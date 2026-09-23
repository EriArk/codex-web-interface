import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  CHAT_BLOCK_LINES,
  textBlockLines,
  type GptConnection,
  type GptFile,
  type GptJob,
  type GptModels,
  gptConnectionMessages,
  gptFileLimit,
  type HubConfig,
  HubError,
  imageFilename,
  normalizeGptConnection,
  type ResultItem,
  resultCategorySchema,
  uploadMime,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { GptHistoryCache } from "./gpt-cache.js";
import { GptDeletions } from "./gpt-deletions.js";
import {
  gptCatalog,
  gptCompletion,
  gptHistory,
  gptId,
  gptProjectConversations,
  gptProjects,
} from "./gpt-history.js";
import { GptHistoryDisk } from "./gpt-history-disk.js";
import { gptLinkedText } from "./gpt-links.js";
import { NativeGptJobs } from "./gpt-native-jobs.js";
import { NativeGptLibrary } from "./gpt-native-library.js";
import { nativeProjectTransport } from "./gpt-native-project.js";
import { NativeGptProvider, type NativeGptWorkspace } from "./gpt-native-provider.js";
import { GptOperations, gptOperationInput } from "./gpt-operations.js";
import { gptProgress, mergeGptProgress } from "./gpt-progress.js";
import { GptProjectContent, gptProjectInput } from "./gpt-project-content.js";
import { GptReadBackoff } from "./gpt-read-backoff.js";
import { gptResults, resultPage } from "./gpt-results.js";
import { gptResultContent } from "./gpt-result-content.js";
import { gptSandboxFiles } from "./gpt-sandbox-files.js";
import { GptTextArtifacts } from "./gpt-text-artifacts.js";
import { GptWorkspaceWork, workspaceId, workspaceInput } from "./gpt-workspace.js";
import {
  type EntityAction,
  type EntityKind,
  entityAction,
  Library,
  libraryMutation,
} from "./library.js";
import { assertPreviewFrame, Previews, previewCsp } from "./previews.js";
import { resultReferenceSchema } from "./result-references.js";
import type { Store } from "./store.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const uuid = z.string().uuid();
const settings = z.object({ model: z.string().min(1).max(120), effort: z.string().regex(/^\d$/) });
const input = settings
  .extend({
    replacesJobId: uuid.optional(),
    projectId: id.optional(),
    nativeId: id.nullable(),
    text: z.string().max(100000),
    files: z.array(uuid).max(8),
  })
  .strict();
type Input = z.infer<typeof input>;
type Json = Record<string, any>;
const active = ["queued", "preparing", "running"];
const error = (code: string, message: string, status = 409) => new HubError(status, code, message);
export class GptService {
  private readonly native?: NativeGptProvider;
  private readonly nativeJobs?: NativeGptJobs;
  readonly nativeLibrary?: NativeGptLibrary;
  readonly deletions?: GptDeletions;
  private deletionWork: Promise<void> | undefined;
  private deletionTimer = setInterval(() => {
    if (!this.deletions || this.deletionWork || this.stopped) return;
    this.deletionWork = this.deletions
      .tick(
        this.authorize,
        () =>
          !this.stopped &&
          !this.working &&
          !this.libraryBusy &&
          !this.nativeBlocked() &&
          !this.hasUnfinishedJobs(),
      )
      .catch(() => {})
      .finally(() => {
        this.deletionWork = undefined;
      });
  }, 5000).unref();
  private nativeReadFailures = 0;
  private readonly historyBackoff = new GptReadBackoff();
  private readonly historyReads = new Map<string, Promise<Json>>();
  readonly historyCache: GptHistoryCache;
  receiptMessageIds(jobId: string, conversationId: string): string[] {
    if (!this.nativeJobs) return [];
    const row = this.store.db
      .prepare(
        "SELECT r.messages FROM gpt_native_receipts r JOIN gpt_jobs j ON j.id=r.jobId WHERE r.jobId=? AND j.nativeId=?",
      )
      .get(jobId, conversationId);
    if (!row) return [];
    const messages = z
      .array(z.object({ id, role: z.string() }))
      .max(20)
      .parse(JSON.parse(String(row.messages)));
    return messages.filter((m) => m.role === "assistant").map((m) => m.id);
  }
  private observedHistory?: { id: string; value: Json; checkedAt: number };
  /** Short sharing window for display/completion observers, never mutation preconditions. */
  async readConversation(id: string) {
    const observed = this.observedHistory;
    if (observed?.id === id && Date.now() - observed.checkedAt < 15000) return observed.value;
    const value = await this.json("/conversation?id=" + encodeURIComponent(id));
    if (
      !value.mapping ||
      typeof value.mapping !== "object" ||
      !gptId(value.current_node) ||
      !value.mapping[value.current_node]
    )
      throw error(
        "GPT_HISTORY_UNAVAILABLE",
        "Не удалось прочитать историю ChatGPT. Сохранённая переписка остаётся доступной.",
        503,
      );
    this.observedHistory = { id, value, checkedAt: Date.now() };
    return value;
  }
  readonly operations: GptOperations;
  readonly projectContent: GptProjectContent;
  readonly workspaceWork: GptWorkspaceWork;
  nativeBlocked() {
    return (
      this.operations.blocked() ||
      this.projectContent.blocked() ||
      this.workspaceWork.blocked() ||
      !!this.nativeLibrary?.blocked()
    );
  }
  nativeCounts() {
    const a = this.operations.counts(),
      b = this.projectContent.counts(),
      c = this.workspaceWork.counts();
    return { active: a.active + b.active + c.active, unknown: a.unknown + b.unknown + c.unknown };
  }
  private working = false;
  private libraryBusy = false;
  readonly library: Library;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private completion = Promise.resolve();
  private releaseCompletion: (() => void) | undefined;
  private releasingUploads = false;
  private storageTimer = setInterval(() => {
    if (!this.working) void this.releaseCompletedUploads();
  }, 60000).unref();
  async releaseCompletedUploads() {
    if (this.native || this.stopped || !this.available() || this.releasingUploads) return;
    this.releasingUploads = true;
    try {
      const rows = this.store.db
        .prepare(
          "SELECT s.jobId,s.fileId FROM gpt_staged_uploads s JOIN gpt_jobs j ON j.id=s.jobId WHERE j.status='completed' ORDER BY s.createdAt LIMIT 8",
        )
        .all();
      if (!rows.length) return;
      const result = await this.json("/uploads/release", { ids: rows.map((row) => row.fileId) });
      if (this.stopped || result.ok !== true) return;
      for (const row of rows)
        this.store.db
          .prepare("DELETE FROM gpt_staged_uploads WHERE jobId=? AND fileId=?")
          .run(String(row.jobId), String(row.fileId));
    } catch {
      /* Retain receipts and retry only cleanup, never the prompt. */
    } finally {
      this.releasingUploads = false;
    }
  }
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionCache: { value: GptConnection; until: number } | undefined;
  private compatibilityFailure = false;
  async connection(force = false): Promise<GptConnection> {
    let value: GptConnection;
    if (!force && this.connectionCache && this.connectionCache.until > Date.now())
      value = this.connectionCache.value;
    else {
      let raw: unknown = null;
      if (this.available() && !this.native)
        try {
          raw = await this.json("/status");
        } catch {}
      value = this.native
        ? await this.native.connection().catch(() => ({
            ...normalizeGptConnection(null, true),
            connectUrl: "/gpt-connect?runtime=native" as const,
          }))
        : normalizeGptConnection(raw, this.available());
      this.connectionCache = { value, until: Date.now() + 5000 };
    }
    const activeJobs = Number(
      this.store.db
        .prepare(
          "SELECT count(*) AS n FROM gpt_jobs WHERE status IN ('queued','preparing','running')",
        )
        .get()?.n,
    );
    const unknownJobs = Number(
      this.store.db.prepare("SELECT count(*) AS n FROM gpt_jobs WHERE status='unknown'").get()?.n,
    );
    if (this.compatibilityFailure && value.state === "healthy")
      value = {
        ...value,
        state: "degraded",
        canSend: false,
        message: gptConnectionMessages.degraded,
      };
    const operations = this.nativeCounts();
    const blocked = this.nativeBlocked();
    if (blocked && value.canSend)
      value = {
        ...value,
        state: operations.unknown || this.nativeLibrary?.blocked() ? "degraded" : "busy",
        message:
          operations.unknown || this.nativeLibrary?.blocked()
            ? "Не удалось подтвердить изменение GPT."
            : "В GPT завершается другое действие.",
        canSend: false,
      };
    return {
      ...value,
      activeJobs: activeJobs + operations.active,
      unknownJobs: unknownJobs + operations.unknown,
    };
  }
  async reconnect(): Promise<GptConnection> {
    if (this.working || this.libraryBusy || this.nativeBlocked()) return this.connection();
    this.compatibilityFailure = false;
    this.modelCache = undefined;
    const state = await this.connection(true);
    if (state.state === "healthy") {
      try {
        await this.models();
      } catch {
        this.compatibilityFailure = true;
      }
      if (!this.compatibilityFailure) void this.pump();
    }
    return this.connection();
  }
  private modelsPending: Promise<GptModels> | undefined;
  private modelCache: { value: GptModels; expires: number } | undefined;
  private readonly token: string;
  readonly root: string;
  readonly previews: Previews;
  readonly textArtifacts: GptTextArtifacts;
  private canvasCards = new Map<string, { items: ResultItem[]; checkedAt: number }>();
  private canvasReads = new Map<string, Promise<ResultItem[]>>();
  async canvasResults(conversationId: string, cachedOnly = false): Promise<ResultItem[]> {
    this.authorize();
    this.library.assertExists("thread", conversationId);
    const cached = this.canvasCards.get(conversationId);
    if (cachedOnly || (cached && Date.now() - cached.checkedAt < 60000)) return cached?.items ?? [];
    const pending = this.canvasReads.get(conversationId);
    if (pending) return pending;
    if (this.canvasReads.size >= 4) throw error("GPT_BUSY", "Документы ещё загружаются.", 429);
    const read = this.workspaceWork
      .canvases(conversationId)
      .then(({ items }) => {
        this.authorize();
        this.library.assertExists("thread", conversationId);
        const cards: ResultItem[] = items.map((canvas) => ({
          id:
            "canvas-" +
            createHash("sha256")
              .update(JSON.stringify([conversationId, canvas.id]))
              .digest("hex"),
          turnId: null,
          type: "canvas",
          title: canvas.title || "Документ Canvas",
          createdAt: "",
          payload: {
            canvas: { conversationId, id: canvas.id, version: canvas.version },
            bytes: Buffer.byteLength(canvas.content),
          },
        }));
        this.canvasCards.delete(conversationId);
        this.canvasCards.set(conversationId, { items: cards, checkedAt: Date.now() });
        while (this.canvasCards.size > 32)
          this.canvasCards.delete(this.canvasCards.keys().next().value!);
        return cards;
      })
      .finally(() => this.canvasReads.delete(conversationId));
    this.canvasReads.set(conversationId, read);
    return read;
  }
  constructor(
    readonly config: HubConfig,
    readonly store: Store,
    readonly authorize: () => void = () => {},
    nativeWorkspace?: NativeGptWorkspace,
  ) {
    if (nativeWorkspace) this.native = new NativeGptProvider(nativeWorkspace);
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_job_providers(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id) ON DELETE CASCADE,provider TEXT NOT NULL CHECK(provider IN ('browser','native')))",
    );
    // Existing outbox entries belong to the old transport unless there is a
    // native receipt proving otherwise. A switch never migrates a queued prompt.
    const hadNative = !!store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gpt_native_receipts'")
      .get();
    store.db.exec(
      "INSERT OR IGNORE INTO gpt_job_providers SELECT id,'browser' FROM gpt_jobs" +
        (hadNative ? " WHERE id NOT IN (SELECT jobId FROM gpt_native_receipts)" : ""),
    );
    if (hadNative)
      store.db.exec(
        "INSERT OR IGNORE INTO gpt_job_providers SELECT jobId,'native' FROM gpt_native_receipts",
      );
    this.library = new Library(store, "gpt");
    if (nativeWorkspace)
      this.nativeLibrary = new NativeGptLibrary(store, nativeWorkspace, this.library);
    if (nativeWorkspace) this.deletions = new GptDeletions(store, this.library, nativeWorkspace);
    this.operations = new GptOperations(
      store,
      (path, body) => this.json(path, body),
      () =>
        !this.projectContent?.blocked() &&
        !this.workspaceWork?.blocked() &&
        !this.stopped &&
        !this.working &&
        !this.libraryBusy &&
        !this.nativeLibrary?.blocked() &&
        !this.modelsPending &&
        !this.hasUnfinishedJobs(),
      (id) => {
        this.observedHistory = undefined;
        this.historyCache.invalidate(id);
      },
      this.lifetime.signal,
      !!this.native,
    );
    this.projectContent = new GptProjectContent(
      store,
      (path, body) => this.json(path, body),
      () =>
        !this.stopped &&
        !this.working &&
        !this.libraryBusy &&
        !this.nativeLibrary?.blocked() &&
        !this.modelsPending &&
        !this.operations.blocked() &&
        !this.workspaceWork?.blocked() &&
        !this.hasUnfinishedJobs(),
      (id) => {
        const file = this.upload(id);
        if (this.native) return file;
        this.assertLegacyUpload(file);
        return { ...file, base64: readFileSync(join(this.root, id)).toString("base64") };
      },
      this.lifetime.signal,
      nativeWorkspace
        ? nativeProjectTransport(
            nativeWorkspace,
            (id) => ({ ...this.upload(id), path: join(this.root, id) }),
            () => {
              authorize();
              if (this.stopped) throw Error("NATIVE_STOPPED");
            },
          )
        : undefined,
    );
    this.workspaceWork = new GptWorkspaceWork(
      store,
      (path, body) => this.json(path, body),
      () =>
        !this.stopped &&
        !this.working &&
        !this.libraryBusy &&
        !this.nativeLibrary?.blocked() &&
        !this.modelsPending &&
        !this.operations.blocked() &&
        !this.projectContent.blocked() &&
        !this.hasUnfinishedJobs(),
      !!this.native,
    );
    this.token = config.gpt ? (process.env[config.gpt.tokenSecret] ?? "") : "";
    this.root = join(config.hub.resultsPath, "gpt");
    this.previews = new Previews(join(config.hub.resultsPath, "previews"), store, () => {
      throw error("GPT_PREVIEW_SOURCE", "Демо недоступно.");
    });
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.textArtifacts = new GptTextArtifacts(
      this.root,
      store,
      Math.min(128 * 1024 * 1024, config.hub.storage.artifactBytes),
    );
    this.historyCache = new GptHistoryCache(
      async (id) => gptHistory(await this.readConversation(id), id),
      Date.now,
      new GptHistoryDisk(join(this.root, this.native ? "native-history" : "history")),
    );
    if (nativeWorkspace)
      this.nativeJobs = new NativeGptJobs(
        store,
        nativeWorkspace.client,
        () => {
          authorize();
          if (this.stopped) throw Error("NATIVE_STOPPED");
        },
        nativeWorkspace.conversations,
        nativeWorkspace.creationKeys,
        async (file) => {
          const stored = this.upload(file.id);
          if (stored.bytes !== file.bytes || stored.name !== file.name || stored.mime !== file.mime)
            throw Error("NATIVE_UPLOAD_CHANGED");
          return join(this.root, file.id);
        },
      );
    // Never replay an ambiguous native submission after a Hub restart.
    store.db
      .prepare(
        "UPDATE gpt_jobs SET status='unknown',error=? WHERE status IN ('preparing','running')",
      )
      .run("Соединение прервалось. Проверь ответ в чате перед повторной отправкой.");
  }
  private requireBrowserFeature() {
    if (this.native)
      throw error(
        "GPT_NATIVE_NOT_READY",
        "Это действие пока доступно в клиенте ChatGPT. Открой его в настройках подключения.",
      );
    return true;
  }
  available() {
    return !!this.native || (!!this.config.gpt && !!this.token);
  }
  private async response(path: string, body?: unknown, timeout = 30000, signal?: AbortSignal) {
    this.authorize();
    if (this.native)
      throw error("GPT_NATIVE_NOT_READY", "Это действие ещё не подключено к новому клиенту GPT.");
    if (!this.available())
      throw error("GPT_NOT_CONFIGURED", "Подключение GPT ещё не настроено.", 503);
    const historyRead = body === undefined && path.startsWith("/conversation?");
    if (historyRead) this.historyBackoff.check();
    try {
      const response = await fetch(new URL(path, this.config.gpt?.endpoint), {
        headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(timeout),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (historyRead && (response.status === 429 || response.status >= 500))
          throw this.historyBackoff.fail(response.status, response.headers.get("retry-after"));
        if (historyRead && [401, 403].includes(response.status))
          throw error("GPT_LOGIN_REQUIRED", "Проверь вход в ChatGPT на странице подключения.", 403);
        if (historyRead)
          throw error(
            "GPT_HISTORY_UNAVAILABLE",
            "Не удалось прочитать историю ChatGPT. Проверь доступ к диалогу в оригинале.",
            response.status === 404 ? 404 : 503,
          );
        if (
          path === "/bridge/chat" &&
          response.status === 400 &&
          response.headers.get("x-codex-gpt-dispatch") === "not-submitted"
        )
          throw error(
            "GPT_CHAT_NOT_SUBMITTED",
            "ChatGPT отклонил сообщение до отправки. Текст и файлы сохранены.",
            400,
          );
        if (["/settings", "/bridge/sessions/new", "/bridge/sessions/select"].includes(path)) {
          const reason = response.headers.get("x-codex-gpt-preparation");
          if (reason === "attention")
            throw error("GPT_UI_ATTENTION", "В ChatGPT открыто окно, требующее внимания.");
          if (reason === "timeout")
            throw error("GPT_PREPARATION_TIMEOUT", "ChatGPT не успел подготовить поле ввода.");
        }
        if (path === "/library" && response.status === 429)
          throw error(
            "GPT_PIN_LIMIT",
            "ChatGPT не разрешил закрепление. Уже закреплено 10 элементов; сначала открепи один.",
            409,
          );
        if (path === "/library" && response.status === 409)
          throw error(
            "GPT_ACTION_REJECTED",
            "ChatGPT сейчас не разрешает это действие. Обнови список и повтори.",
            409,
          );
        throw error(
          "GPT_UNAVAILABLE",
          "Не удалось выполнить действие в ChatGPT. Проверь подключение.",
          503,
        );
      }
      if (historyRead) this.historyBackoff.success();
      return response;
    } catch (e) {
      if (e instanceof HubError) throw e;
      if (historyRead) throw this.historyBackoff.fail(503, null);
      throw error("GPT_CONNECTION_LOST", "Нет связи с подключением GPT.", 503);
    }
  }
  async projectFile(projectId: string, fileId: string) {
    this.library.assertExists("project", projectId);
    const project = await this.projectContent.read(projectId),
      file = project.files.find((f) => f.id === fileId);
    if (!file) throw error("GPT_PROJECT_FILE_MISSING", "Файл больше не находится в проекте.", 404);
    if (this.native)
      return {
        file,
        response: (await this.native.workspace.client.media({ projectId, fileId })).response,
      };
    return {
      file,
      response: await this.response(
        "/project-file?" + new URLSearchParams({ projectId, fileId }),
        undefined,
        60000,
      ),
    };
  }
  async json(path: string, body?: unknown): Promise<Json> {
    if (body === undefined && path.startsWith("/conversation?")) {
      const pending = this.historyReads.get(path);
      if (pending) return pending;
      const task = this.readJson(path);
      this.historyReads.set(path, task);
      try {
        return await task;
      } finally {
        if (this.historyReads.get(path) === task) this.historyReads.delete(path);
      }
    }
    return this.readJson(path, body);
  }
  private async readJson(path: string, body?: unknown): Promise<Json> {
    this.authorize();
    if (this.native) {
      try {
        const result = await this.native.json(path, body);
        this.authorize();
        return result;
      } catch (cause) {
        // Preserve the existing cached-history recovery path in native mode.
        // Identity/branch errors deliberately do not qualify for this fallback.
        if (path.startsWith("/conversation?") && cause instanceof Error) {
          if (cause.message === "NATIVE_RATE_LIMITED")
            throw error(
              "GPT_HISTORY_RATE_LIMITED",
              "ChatGPT временно ограничил обновление истории. Повторим автоматически после паузы.",
              429,
            );
          if (
            [
              "NATIVE_READ_UNAVAILABLE",
              "NATIVE_TIMEOUT",
              "NATIVE_HISTORY_HEADERS_TIMEOUT",
              "NATIVE_HISTORY_BODY_TIMEOUT",
              "NATIVE_BUSY",
              "NATIVE_MANUAL_RECOVERY",
              "NATIVE_DISCONNECTED",
              "NATIVE_UNAVAILABLE",
              "NATIVE_WINDOW_CHANGED",
              "NATIVE_WINDOW_AMBIGUOUS",
              "NATIVE_QUEUE_FULL",
            ].includes(cause.message)
          )
            throw error(
              "GPT_HISTORY_UNAVAILABLE",
              "Не удалось обновить историю ChatGPT. Повторим автоматически.",
              503,
            );
        }
        throw cause;
      }
    }
    return (
      await this.response(
        path,
        body,
        [
          "/project-content",
          "/native-operation",
          "/settings",
          "/models",
          "/bridge/sessions/new",
          "/bridge/sessions/select",
        ].includes(path)
          ? 60000
          : 30000,
      )
    ).json();
  }
  async doctorReport() {
    if (this.native) return { ...(await this.connection(true)), provider: "native" };
    const raw = await this.json("/status");
    if (this.nativeCounts().active) return { ...raw, state: "busy" };
    return this.compatibilityFailure && raw.state === "healthy"
      ? { ...raw, state: "degraded", doctorStage: "preparation" }
      : raw;
  }
  async pins() {
    const raw = await this.json("/pins");
    const rows: Json[] = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    const pins = rows
      .filter((row) => ["conversation", "project"].includes(row.item_type))
      .flatMap((row) => {
        const item = row.item;
        const nativeId = item?.gizmo?.id ?? item?.gizmo?.gizmo?.id ?? item?.id;
        return gptId(nativeId)
          ? [{ id: nativeId, kind: row.item_type === "project" ? "project" : "thread", item }]
          : [];
      });
    this.historyCache.setPinned(
      pins
        .filter((pin) => pin.kind === "thread" && !this.library.get("thread", pin.id)?.deleted)
        .map((pin) => pin.id),
    );
    return pins;
  }
  async catalog(offset = 0, archived = false) {
    const [raw, pins] = await Promise.all([
      this.json("/catalog?offset=" + offset + (archived ? "&archived=1" : "")),
      this.pins(),
    ]);
    const page = gptCatalog(raw);
    for (const row of page.items) {
      const saved = this.library.get("thread", row.id);
      if (saved?.deleted) continue;
      const recent = saved?.changedAt && Date.now() - saved.changedAt < 60000;
      this.library.save("thread", row.id, {
        name: recent ? saved.name : row.title,
        projectId: row.projectId,
        activityAt: Math.max(saved?.activityAt ?? 0, row.updatedAt),
        archived: recent ? saved.archived : archived,
      });
      if (recent) row.title = saved.name;
    }
    if (!archived && offset === 0) {
      for (const pin of pins.filter((p) => p.kind === "thread")) {
        const item = gptCatalog({ items: [pin.item] }).items[0];
        if (item && !page.items.some((t) => t.id === item.id)) page.items.push(item);
      }
      this.historyCache.setRecent(
        page.items
          .filter((row) => !this.library.get("thread", row.id)?.deleted)
          .map((row) => row.id),
      );
    }
    return {
      ...page,
      pinnedIds: pins.filter((p) => p.kind === "thread").map((p) => p.id),
      library: this.library.all(),
      items: page.items
        .filter((row) => !this.library.get("thread", row.id)?.deleted)
        .map((row) => ({
          ...row,
          pinned: pins.some((p) => p.kind === "thread" && p.id === row.id),
          archived,
        })),
    };
  }
  async projects() {
    const [raw, pins] = await Promise.all([this.json("/projects"), this.pins()]);
    for (const saved of this.library
      .all()
      .filter((e) => e.kind === "project" && e.renamed && !e.deleted)) {
      if (Date.now() - (saved.nameCheckedAt ?? 0) < 60000) continue;
      try {
        const canonical = gptProjects({
          items: [await this.json("/project?id=" + encodeURIComponent(saved.id))],
        })[0];
        if (canonical)
          this.library.save("project", saved.id, {
            name: canonical.name,
            nameCheckedAt: Date.now(),
          });
      } catch {
        /* Keep the last confirmed name if the connection is unavailable. */
      }
    }
    const items = gptProjects(raw).map((row) => ({
      ...row,
      ...this.library.get("project", row.id),
      id: row.id,
      name: this.library.get("project", row.id)?.renamed
        ? this.library.get("project", row.id)!.name
        : row.name,
      pinned: pins.some((p) => p.kind === "project" && p.id === row.id),
    }));
    // Remember only confirmed project metadata during normal native discovery.
    // Tasks uses this Hub cache, never an extra browser request or writer.
    for (const row of items) {
      const saved = this.library.get("project", row.id);
      if (!saved?.deleted && saved?.name !== row.name)
        this.library.save("project", row.id, { name: row.name });
    }
    for (const entry of this.library
      .all()
      .filter((e) => e.kind === "project" && (e.archived || e.deleted)))
      if (!items.some((p) => p.id === entry.id))
        items.push({ ...entry, name: entry.name, pinned: false });
    const conversations = gptProjectConversations(raw);
    for (const row of conversations) {
      const saved = this.library.get("thread", row.id);
      if (!saved?.deleted)
        this.library.save("thread", row.id, {
          name: saved?.renamed ? saved.name : row.title,
          projectId: row.projectId,
          activityAt: Math.max(saved?.activityAt ?? 0, row.updatedAt),
        });
    }
    return {
      items,
      conversations: conversations
        .filter((row) => !this.library.get("thread", row.id)?.deleted)
        .map((row) => ({
          ...row,
          pinned: pins.some((p) => p.kind === "thread" && p.id === row.id),
        })),
    };
  }
  async manageNativeEntity(key: string, kind: EntityKind, nativeId: string, action: EntityAction) {
    if (!this.nativeLibrary) throw error("GPT_NATIVE_NOT_READY", "Новое подключение не включено.");
    if (kind === "thread" && action.action === "delete" && this.deletions) {
      this.authorize();
      const result = this.deletions.enqueue(key, nativeId);
      this.historyCache.invalidate(nativeId);
      return result;
    }
    if (
      this.working ||
      this.libraryBusy ||
      this.operations.blocked() ||
      this.projectContent.blocked() ||
      this.workspaceWork.blocked() ||
      this.hasUnfinishedJobs()
    )
      throw error("GPT_BUSY", "Дождись завершения текущей работы GPT.");
    this.libraryBusy = true;
    try {
      if (kind === "project" && action.action === "archive") {
        return await this.store.once("library:gpt:project:" + nativeId, key, action, async () => {
          this.library.assertExists(kind, nativeId);
          const source = await this.native!.workspace.client.project(nativeId);
          this.library.save(kind, nativeId, {
            name: source.name,
            archived: action.value,
            changedAt: Date.now(),
          });
          return { ok: true };
        });
      }
      const result = await this.nativeLibrary.run(key, kind, nativeId, action);
      this.observedHistory = undefined;
      if (kind === "thread") this.historyCache.invalidate(nativeId);
      return result;
    } finally {
      this.libraryBusy = false;
      if (!this.stopped) void this.pump();
    }
  }
  async manageEntity(kind: EntityKind, nativeId: string, action: EntityAction) {
    this.library.assertExists(kind, nativeId);
    if (this.working || this.libraryBusy || this.nativeBlocked() || this.hasUnfinishedJobs())
      throw error("GPT_BUSY", "Дождись завершения текущей работы GPT.");
    this.libraryBusy = true;
    try {
      const state = await this.json("/active");
      if (state.generating || state.requestId) throw error("GPT_BUSY", "ChatGPT сейчас занят.");
      let name: string, projectId: string | undefined;
      if (kind === "thread") {
        const source = await this.json("/conversation?id=" + encodeURIComponent(nativeId));
        if (!source.mapping) throw error("GPT_NOT_FOUND", "Чат не найден.", 404);
        name = typeof source.title === "string" ? source.title : "Чат GPT";
        projectId = gptId(source.gizmo_id) ? source.gizmo_id : undefined;
      } else {
        const source = (await this.projects()).items.find((p) => p.id === nativeId);
        if (!source) throw error("GPT_NOT_FOUND", "Проект не найден.", 404);
        name = source.name;
      }
      if (kind !== "project" || action.action !== "archive")
        await this.json("/library", { kind, id: nativeId, ...action });
      this.library.save(kind, nativeId, {
        name: action.action === "rename" ? action.name : name,
        projectId,
        changedAt: Date.now(),
        ...(action.action === "rename" ? { renamed: true, nameCheckedAt: Date.now() } : {}),
        ...(action.action === "archive" ? { archived: action.value } : {}),
        ...(action.action === "delete" ? { deleted: true, archived: false } : {}),
      });
      if (kind === "project" && action.action === "delete") {
        for (const child of this.library
          .all()
          .filter((e) => e.kind === "thread" && e.projectId === nativeId)) {
          this.library.save("thread", child.id, { deleted: true, archived: false, name: "" });
          this.historyCache.remove(child.id);
          this.store.db.prepare("DELETE FROM gpt_jobs WHERE nativeId=?").run(child.id);
        }
      }
      if (kind === "thread") {
        this.observedHistory = undefined;
        this.historyCache.invalidate(nativeId);
        if (action.action === "delete") {
          this.historyCache.remove(nativeId);
          this.store.db.prepare("DELETE FROM gpt_jobs WHERE nativeId=?").run(nativeId);
        }
      }
      return { ok: true };
    } finally {
      this.libraryBusy = false;
      if (!this.stopped) void this.pump();
    }
  }
  async models(): Promise<GptModels> {
    if (this.modelCache && (this.working || this.modelCache.expires > Date.now()))
      return this.modelCache.value;
    if (this.modelsPending) return this.modelsPending;
    // Native choices are a read, independent of mutation receipts and sends.
    // The old browser adapter needs an idle composer to inspect its controls.
    if (!this.native && (this.working || this.libraryBusy || this.nativeBlocked()))
      throw error("GPT_BUSY", "Модели обновятся после текущего ответа.");
    this.modelsPending = this.loadModels();
    try {
      return await this.modelsPending;
    } finally {
      this.modelsPending = undefined;
    }
  }
  private async loadModels() {
    const data = await this.json("/models");
    const option = z.object({ id: z.string().min(1).max(120), label: z.string().min(1).max(120) });
    const value = z
      .object({
        models: z.array(option).min(1).max(50),
        efforts: z.array(option).min(1).max(16),
        effortsByModel: z.record(z.string(), z.array(option).min(1).max(16)).optional(),
        currentModel: z.string(),
        currentEffort: z.string(),
      })
      .parse(data);
    this.modelCache = { value, expires: Date.now() + 15 * 60000 };
    return value;
  }
  private liveRead?: {
    id: string;
    at: number;
    value: Promise<{ jobId: string; items: import("@codex-web/shared").GptProgress[] } | null>;
  };
  private liveCompletions = new Set<string>();
  liveProgress(nativeId: string | undefined, watch: string | undefined) {
    this.authorize();
    const row =
      this.native &&
      this.store.db
        .prepare(
          "SELECT j.id,r.payload FROM gpt_jobs j JOIN gpt_native_receipts r ON r.jobId=j.id WHERE (j.nativeId=? OR j.id=?) AND j.status IN ('preparing','running','unknown') ORDER BY j.createdAt DESC LIMIT 1",
        )
        .get(nativeId ?? null, watch ?? null);
    if (!row) return Promise.resolve(null);
    const jobId = String(row.id);
    if (this.liveRead?.id === jobId && Date.now() - this.liveRead.at < 1000)
      return this.liveRead.value;
    const value = this.native!.workspace.client.liveDispatch(
      jobId,
      JSON.parse(String(row.payload)).conversationId,
    )
      .then((result) => {
        if (result.finished && !this.working && !this.liveCompletions.has(jobId)) {
          this.liveCompletions.add(jobId);
          while (this.liveCompletions.size > 32)
            this.liveCompletions.delete(this.liveCompletions.values().next().value!);
          clearTimeout(this.recoveryTimer);
          void this.pump(); // Completion is a read hint, never proof of delivery or a replay.
        }
        return { jobId, items: result.items };
      })
      .catch(() => null);
    this.liveRead = { id: jobId, at: Date.now(), value };
    return value;
  }
  updates(nativeId: string | undefined, watch: string | undefined, after: number) {
    const stamp = Date.now();
    const rows = this.store.db
      .prepare(
        "SELECT id,nativeId,status,createdAt,updatedAt FROM gpt_jobs ORDER BY createdAt DESC LIMIT 100",
      )
      .all();
    let count = 0;
    const items = rows.flatMap((row) => {
      const selected = row.nativeId === (nativeId ?? null) || row.id === watch;
      if (selected) count++;
      if (Number(row.updatedAt) < after) return [];
      if (row.id === watch || (selected && count <= 20)) return [this.job(String(row.id))];
      return [
        {
          id: String(row.id),
          nativeId: row.nativeId === null ? null : String(row.nativeId),
          status: row.status as GptJob["status"],
          createdAt: Number(row.createdAt),
          updatedAt: Number(row.updatedAt),
          dismissed: this.library.get("thread", "outbox:" + row.id)?.deleted === true,
          summaryOnly: true,
          text: "",
          files: [],
          model: "",
          effort: "",
          answer: "",
          assets: [],
          error: "",
        },
      ];
    });
    return { items, stamp };
  }
  private hasUnfinishedJobs() {
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM gpt_jobs WHERE status IN ('queued','preparing','running','unknown') LIMIT 1",
      )
      .get();
  }
  jobs(): GptJob[] {
    return this.store.db
      .prepare("SELECT * FROM gpt_jobs ORDER BY createdAt DESC LIMIT 100")
      .all()
      .map((row) => this.publicJob(row));
  }
  private publicJob(row: Json): GptJob {
    return {
      id: row.id,
      dismissed: this.library.get("thread", "outbox:" + row.id)?.deleted === true,
      nativeId: row.nativeId,
      text: row.text,
      files: JSON.parse(row.files),
      model: row.model,
      effort: row.effort,
      status: row.status,
      answer: row.answer,
      progress: JSON.parse(
        String(
          this.store.db.prepare("SELECT value FROM gpt_job_progress WHERE jobId=?").get(row.id)
            ?.value ?? "[]",
        ),
      ),
      assets: JSON.parse(row.assets),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      error:
        typeof row.error === "string" && row.error.startsWith("NATIVE_")
          ? row.status === "unknown"
            ? ""
            : "Отправка не подготовлена. Текст и файлы сохранены."
          : row.error,
    };
  }
  job(jobId: string) {
    const row = this.store.db.prepare("SELECT * FROM gpt_jobs WHERE id=?").get(jobId);
    if (!row) throw error("GPT_JOB_NOT_FOUND", "Отправка не найдена.", 404);
    return this.publicJob(row);
  }
  private assertDismissible(jobId: string) {
    const job = this.job(jobId);
    if (job.dismissed) return;
    if (
      !["failed", "cancelled"].includes(job.status) &&
      !(job.status === "completed" && !job.nativeId)
    )
      throw error("GPT_JOB_BUSY", "Сначала дождись завершения или проверь состояние отправки.");
  }
  private dismissRecord(jobId: string) {
    this.store.db
      .prepare(
        "INSERT INTO library_entities(client,kind,id,value) VALUES('gpt','thread',?,?) ON CONFLICT(client,kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(
        "outbox:" + jobId,
        JSON.stringify({ id: "outbox:" + jobId, kind: "thread", name: "", deleted: true }),
      );
    // Keep the idempotency fingerprint so a delayed retry cannot resend a deleted item.
    this.update(jobId, { text: "", files: "[]", answer: "", assets: "[]", error: "" });
    this.store.db.prepare("DELETE FROM gpt_job_progress WHERE jobId=?").run(jobId);
  }
  dismiss(jobId: string) {
    this.assertDismissible(jobId);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.dismissRecord(jobId);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.job(jobId);
  }
  upload(fileId: string): GptFile {
    const row = this.store.db.prepare("SELECT * FROM gpt_uploads WHERE id=?").get(fileId);
    if (!row) throw error("GPT_FILE_NOT_FOUND", "Вложение не найдено.", 404);
    return {
      id: String(row.id),
      name: String(row.name),
      mime: String(row.mime),
      bytes: Number(row.bytes),
      image: !!row.image,
      url: "/api/gpt/uploads/" + row.id,
    };
  }
  private assertLegacyUpload(file: GptFile) {
    // The old browser bridge still buffers JSON/base64. Never let a future UI
    // publication turn a 512 MiB upload into a multi-gigabyte legacy request.
    if (file.bytes > 25 * 1024 ** 2)
      throw error(
        "GPT_NATIVE_UPLOAD_REQUIRED",
        "Для такого файла нужно новое нативное подключение GPT. Файл сохранён; старое браузерное подключение его не передаст.",
        413,
      );
  }
  async put(name: string, bytes: Buffer): Promise<GptFile> {
    return this.putFile(name, bytes);
  }
  async putFile(name: string, source: Buffer | string, uploadId?: string): Promise<GptFile> {
    this.authorize();
    if (uploadId && this.store.db.prepare("SELECT 1 FROM gpt_uploads WHERE id=?").get(uploadId))
      return this.upload(uploadId);
    const size = Buffer.isBuffer(source) ? source.length : (await stat(source)).size;
    let bytes: Buffer | undefined = Buffer.isBuffer(source) ? source : undefined;
    if (
      !name.trim() ||
      name.length > 240 ||
      /[\\/]/.test(name) ||
      Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw error("GPT_INVALID_FILENAME", "Проверь имя файла.", 400);
    if (!size || size > gptFileLimit(name))
      throw error(
        "GPT_FILE_TOO_LARGE",
        `Для этого типа файла предел ChatGPT — ${gptFileLimit(name) / 1024 ** 2} МБ.`,
        413,
      );
    let mime = uploadMime(name),
      image = false;
    if (imageFilename(name)) {
      try {
        bytes = await sharp(source, { limitInputPixels: 50_000_000, pages: 1 })
          .autoOrient()
          .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer();
      } catch {
        throw error(
          "GPT_IMAGE_UNSUPPORTED",
          "Не удалось прочитать изображение. Попробуй JPEG, PNG или WebP.",
          400,
        );
      }
      mime = "image/jpeg";
      image = true;
      name = name.replace(/\.[^.]+$/, ".jpg");
    } else if (/\.txt$/i.test(name)) mime = "text/plain";
    else if (/\.pdf$/i.test(name)) mime = "application/pdf";
    const total = Number(
      this.store.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM gpt_uploads").get()?.total,
    );
    if (total + (bytes?.length ?? size) > this.config.hub.storage.gptUploadBytes)
      throw error("GPT_STORAGE_FULL", "Хранилище вложений GPT заполнено.", 507);
    const fileId = uploadId ?? randomUUID();
    this.authorize();
    if (uploadId)
      await unlink(join(this.root, fileId)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    try {
      if (bytes) await writeFile(join(this.root, fileId), bytes, { mode: 0o600, flag: "wx" });
      else await copyFile(source as string, join(this.root, fileId), 1);
      this.authorize();
      const used = Number(
        this.store.db.prepare("SELECT COALESCE(SUM(bytes),0) total FROM gpt_uploads").get()?.total,
      );
      if (used + (bytes?.length ?? size) > this.config.hub.storage.gptUploadBytes)
        throw error("GPT_STORAGE_FULL", "Хранилище вложений GPT заполнено.", 507);
      this.store.db
        .prepare("INSERT INTO gpt_uploads VALUES(?,?,?,?,?,?)")
        .run(fileId, name, mime, bytes?.length ?? size, Number(image), Date.now());
    } catch (e) {
      await unlink(join(this.root, fileId)).catch(() => {});
      throw e;
    }
    return this.upload(fileId);
  }
  enqueue(jobId: string, value: Input) {
    const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const existing = this.store.db
      .prepare("SELECT fingerprint FROM gpt_jobs WHERE id=?")
      .get(jobId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw error("GPT_KEY_REUSED", "Эта отправка уже содержит другое сообщение.");
      return this.job(jobId);
    }
    if (!this.available())
      throw error("GPT_NOT_CONFIGURED", "Подключение GPT ещё не настроено.", 503);
    this.native?.assertSubmission(jobId, value.nativeId);
    if (this.native && Buffer.byteLength(value.text) > 32768)
      throw error(
        "GPT_NATIVE_INPUT",
        "Сообщение превышает текущий предел нового подключения (32 КБ). Черновик сохранён.",
      );
    if (this.nativeBlocked())
      throw error(
        "GPT_NATIVE_BUSY",
        "Сначала дождись завершения или проверь изменение ветки GPT. Черновик сохранён.",
      );
    if (this.libraryBusy)
      throw error("GPT_LIBRARY_BUSY", "Обновляем список чатов. Повтори отправку через секунду.");
    if (value.projectId) {
      if (value.nativeId)
        throw error(
          "GPT_PROJECT_INPUT",
          "Новый чат проекта не должен содержать старый идентификатор.",
        );
      const project = this.library.get("project", value.projectId);
      if (!project || project.deleted || project.archived)
        throw error("GPT_PROJECT_UNAVAILABLE", "Проект GPT недоступен. Обнови список проектов.");
    }
    if (value.nativeId) {
      this.library.assertExists("thread", value.nativeId);
      if (this.library.get("thread", value.nativeId)?.archived)
        throw error("GPT_ARCHIVED", "Сначала разархивируй чат.");
    }
    if (!value.text.trim() && !value.files.length)
      throw error("GPT_EMPTY_MESSAGE", "Добавь текст или файл.", 400);
    if (new Set(value.files).size !== value.files.length)
      throw error("GPT_DUPLICATE_FILE", "Вложение добавлено дважды.", 400);
    const files = value.files.map((fileId) => this.upload(fileId));
    if (files.reduce((n, f) => n + f.bytes, 0) > this.config.hub.storage.gptUploadBytes)
      throw error("GPT_FILES_TOO_LARGE", "Вложения превышают доступное хранилище GPT.", 413);
    if (this.jobs().filter((job) => active.includes(job.status)).length >= 20)
      throw error("GPT_QUEUE_FULL", "Очередь заполнена.");
    if (
      this.jobs().some(
        (job) => job.status === "unknown" && (!this.native || job.nativeId === value.nativeId),
      )
    )
      throw error(
        "GPT_CHECK_PREVIOUS",
        "Сначала проверь предыдущую отправку с неизвестным состоянием.",
      );
    if (value.replacesJobId) {
      if (value.replacesJobId === jobId || value.nativeId)
        throw error("GPT_INVALID_REPLACEMENT", "Обнови выбранную отправку.");
      if (this.job(value.replacesJobId).dismissed)
        throw error("GPT_JOB_DISMISSED", "Эта отправка уже удалена или заменена. Обнови список.");
      this.assertDismissible(value.replacesJobId);
    }
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare("INSERT INTO gpt_jobs VALUES(?,?,?,?,?,?,?,'queued','',?,?,?,'',NULL,0)")
        .run(
          jobId,
          fingerprint,
          value.nativeId,
          value.text,
          JSON.stringify(files),
          value.model,
          value.effort,
          "[]",
          Date.now(),
          Date.now(),
        );
      this.store.db
        .prepare("INSERT INTO gpt_job_providers VALUES(?,?)")
        .run(jobId, this.native ? "native" : "browser");
      if (value.projectId)
        this.store.db
          .prepare("INSERT INTO gpt_project_jobs(jobId,projectId) VALUES(?,?)")
          .run(jobId, value.projectId);
      if (value.replacesJobId) this.dismissRecord(value.replacesJobId);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    void this.pump();
    return this.job(jobId);
  }
  private update(jobId: string, values: Json) {
    if (values.status && ["completed", "cancelled", "unknown", "failed"].includes(values.status)) {
      this.observedHistory = undefined;
      const nativeId = this.job(jobId).nativeId;
      if (nativeId) this.historyCache.invalidate(nativeId);
    }
    const columns = Object.keys(values);
    this.store.db
      .prepare(
        "UPDATE gpt_jobs SET " +
          columns.map((key) => key + "=?").join(",") +
          ",updatedAt=? WHERE id=?",
      )
      .run(...Object.values(values), Date.now(), jobId);
  }
  async cancel(jobId: string) {
    const job = this.job(jobId);
    if (job.status === "queued") {
      this.update(jobId, { status: "cancelled" });
      return this.job(jobId);
    }
    if (!["preparing", "running"].includes(job.status)) return job;
    const provider = this.store.db
      .prepare("SELECT provider FROM gpt_job_providers WHERE jobId=?")
      .get(jobId)?.provider;
    if (provider !== (this.native ? "native" : "browser"))
      throw error(
        "GPT_OTHER_PROVIDER",
        "Эта отправка принадлежит предыдущему подключению GPT. Проверь её в прежнем клиенте.",
      );
    if (this.native) {
      if (job.status === "preparing") {
        this.update(jobId, { status: "cancelled" });
        return this.job(jobId);
      }
      await this.nativeJobs!.stop(jobId);
      this.observedHistory = undefined;
      if (job.nativeId) this.historyCache.invalidate(job.nativeId);
      return this.job(jobId);
    }
    await this.json("/bridge/browser/stop", { reason: "Owner requested stop" });
    this.update(jobId, { status: "cancelled" });
    return this.job(jobId);
  }
  async resolve(jobId: string) {
    if (this.job(jobId).status !== "unknown")
      throw error("GPT_NOT_UNKNOWN", "Состояние уже определено.");
    if (
      this.store.db.prepare("SELECT provider FROM gpt_job_providers WHERE jobId=?").get(jobId)
        ?.provider === "native"
    ) {
      await this.nativeJobs!.review(jobId);
      this.invalidateNativeJob(jobId);
      void this.pump();
      return this.job(jobId);
    }
    this.update(jobId, { status: "cancelled", error: "" });
    void this.pump();
    return this.job(jobId);
  }
  private async pumpNative() {
    if (
      !this.native ||
      !this.nativeJobs ||
      this.stopped ||
      this.working ||
      this.libraryBusy ||
      this.nativeBlocked()
    )
      return;
    this.working = true;
    this.completion = new Promise((resolve) => {
      this.releaseCompletion = resolve;
    });
    let retry = false;
    try {
      // Give a ready independent chat priority over background history checks.
      // Its own persisted receipt still blocks it; old-provider jobs never migrate.
      const eligible = this.store.db.prepare(
        "SELECT j.id FROM gpt_jobs j JOIN gpt_job_providers p ON p.jobId=j.id WHERE p.provider='native' AND j.status='queued' AND NOT EXISTS(SELECT 1 FROM gpt_native_preparations wait WHERE wait.jobId=j.id AND wait.retryAt>?) AND NOT EXISTS(SELECT 1 FROM gpt_jobs busy WHERE busy.status IN ('running','unknown') AND busy.nativeId IS j.nativeId) ORDER BY j.createdAt LIMIT 1",
      );
      let next = eligible.get(Date.now());
      retry = !!this.store.db.prepare("SELECT 1 FROM gpt_jobs WHERE status='queued' LIMIT 1").get();
      const pending = this.store.db
        .prepare(
          "SELECT j.id FROM gpt_jobs j JOIN gpt_job_providers p ON p.jobId=j.id JOIN gpt_native_receipts r ON r.jobId=j.id WHERE p.provider='native' AND j.status IN ('running','unknown') ORDER BY j.updatedAt LIMIT 2",
        )
        .all();
      if (pending.length) retry = true;
      for (const row of next ? [] : pending) {
        retry = true;
        let refreshed = false;
        try {
          const result = await this.nativeJobs.reconcile(String(row.id));
          refreshed = result.status !== "unknown";
          this.nativeReadFailures = result.status === "unknown" ? this.nativeReadFailures + 1 : 0;
        } catch {
          this.nativeReadFailures++;
        }
        this.invalidateNativeJob(String(row.id), refreshed);
      }
      if (this.jobs().some((j) => j.status === "preparing")) return;
      next = eligible.get(Date.now());
      if (!next) return;
      retry = true;
      // Preparation validates the bound account and the selected model itself.
      // Do not fetch the model catalog once here and again during preparation.
      const status = await this.native.workspace.client.status();
      if (status.manual || this.stopped) {
        this.nativeReadFailures++;
        return;
      }
      this.nativeReadFailures = 0;
      const jobId = String(next.id);
      if (this.job(jobId).status !== "queued") return;
      try {
        await this.nativeJobs.run(jobId);
      } catch (cause) {
        const current = this.job(jobId);
        if (
          current.status === "queued" &&
          Number(
            this.store.db
              .prepare("SELECT retryAt FROM gpt_native_preparations WHERE jobId=?")
              .get(jobId)?.retryAt,
          ) > Date.now()
        )
          return;
        const receipt = this.store.db
          .prepare("SELECT 1 FROM gpt_native_receipts WHERE jobId=?")
          .get(jobId);
        if (["queued", "preparing", "running", "unknown", "failed"].includes(current.status))
          this.update(jobId, {
            status: receipt ? "unknown" : "failed",
            error: receipt
              ? ""
              : cause instanceof Error && /^NATIVE_[A-Z_]+$/.test(cause.message)
                ? cause.message
                : "NATIVE_PREPARATION_FAILED",
          });
      }
      this.invalidateNativeJob(jobId, true);
    } catch {
      // A lost read never triggers a dispatch. Keep the last visible answer.
      this.nativeReadFailures++;
      retry = true;
    } finally {
      this.working = false;
      this.releaseCompletion?.();
      if (retry && !this.stopped) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = setTimeout(
          () => void this.pump(),
          this.nativeReadFailures
            ? Math.min(60000, 5000 * 2 ** Math.min(4, this.nativeReadFailures))
            : 2000,
        );
        this.recoveryTimer.unref();
      }
    }
  }
  private invalidateNativeJob(id: string, refresh = false) {
    const job = this.job(id);
    if (job.status === "unknown") {
      const since = Number(
        this.store.db
          .prepare("SELECT uncertainSince FROM gpt_native_receipts WHERE jobId=?")
          .get(id)?.uncertainSince ?? Date.now(),
      );
      this.store.db
        .prepare("UPDATE gpt_jobs SET error=? WHERE id=?")
        .run(
          Date.now() - since >= 45000
            ? "Не удалось подтвердить доставку сообщения. Проверь историю перед новой отправкой."
            : "",
          id,
        );
    }
    this.observedHistory = undefined;
    if (job.nativeId) {
      if (refresh && ["running", "completed", "cancelled"].includes(job.status))
        this.historyCache.warm(job.nativeId, job.status !== "running");
      else this.historyCache.invalidate(job.nativeId);
    }
  }
  async pump() {
    if (this.native) return this.pumpNative();
    if (
      this.working ||
      this.libraryBusy ||
      this.nativeBlocked() ||
      this.stopped ||
      !this.available() ||
      this.jobs().some((job) => job.status === "unknown")
    )
      return;
    const next = this.store.db
      .prepare(
        "SELECT j.id FROM gpt_jobs j JOIN gpt_job_providers p ON p.jobId=j.id WHERE j.status='queued' AND p.provider='browser' ORDER BY j.createdAt LIMIT 1",
      )
      .get();
    if (!next) {
      await this.releaseCompletedUploads();
      return;
    }
    this.working = true;
    this.completion = new Promise((resolve) => {
      this.releaseCompletion = resolve;
    });
    const jobId = String(next.id);
    let dispatched = false,
      done = false,
      checking = false;
    let preparing: "session" | "settings" | "attachments" = "settings";
    const streamController = new AbortController();
    let monitor: ReturnType<typeof setInterval> | undefined;
    try {
      const connection = await this.connection(true);
      if (connection.state !== "healthy") return;
      if (this.modelsPending) {
        try {
          await this.modelsPending;
        } catch {
          this.compatibilityFailure = true;
          return;
        }
      }
      const job = this.job(jobId);
      // The owner may cancel while the asynchronous connection/model checks are pending.
      if (job.status !== "queued" || job.dismissed) return;
      this.update(jobId, { status: "preparing" });
      preparing = "session";
      if (job.nativeId) await this.json("/bridge/sessions/select", { sessionId: job.nativeId });
      else {
        const project = this.store.db
          .prepare("SELECT projectId FROM gpt_project_jobs WHERE jobId=?")
          .get(jobId);
        await this.json("/bridge/sessions/new", project ? { projectId: project.projectId } : {});
      }
      if (this.job(jobId).status === "cancelled") return;
      preparing = "settings";
      const selected = await this.json("/settings", { model: job.model, effort: job.effort });
      if (selected.model !== job.model || String(selected.effort) !== job.effort)
        throw error(
          "GPT_SETTINGS_NOT_CONFIRMED",
          "Не удалось подтвердить выбранные модель и режим.",
        );
      preparing = "attachments";
      await this.json("/bridge/composer/attachments/clear", {});
      const files: string[] = [];
      for (const file of job.files) {
        this.assertLegacyUpload(file);
        const data = await this.json("/bridge/files", {
          name: file.name,
          mime: file.mime,
          contentBase64: readFileSync(join(this.root, file.id)).toString("base64"),
        });
        if (!gptId(data.file?.id))
          throw error("GPT_UPLOAD_FAILED", "Не удалось подготовить вложение.");
        files.push(data.file.id);
        this.store.db
          .prepare("INSERT OR IGNORE INTO gpt_staged_uploads VALUES(?,?,?)")
          .run(jobId, data.file.id, Date.now());
      }
      if (this.job(jobId).status === "cancelled") return;
      dispatched = true;
      monitor = setInterval(() => {
        void (async () => {
          if (checking || done || this.job(jobId).status === "cancelled") return;
          checking = true;
          try {
            const row = this.store.db
              .prepare("SELECT requestId FROM gpt_jobs WHERE id=?")
              .get(jobId);
            if (!row?.requestId) return;
            const native = await this.json("/active");
            if (this.stopped || done) return;
            if (native.requestId !== row.requestId || !gptId(native.nativeId)) return;
            const current = this.job(jobId);
            if (current.nativeId && current.nativeId !== native.nativeId) return;
            if (!current.nativeId) this.update(jobId, { nativeId: native.nativeId });
            const history = await this.readConversation(native.nativeId);
            if (this.stopped || done) return;
            this.historyCache.seed(native.nativeId, gptHistory(history, native.nativeId));
            const completion = gptCompletion(history, current.text, current.createdAt);
            if (!completion.complete || this.job(jobId).status === "cancelled") return;
            const assets = [
              ...new Map(
                completion.messages.flatMap((m) => m.files).map((f) => [f.id, f]),
              ).values(),
            ];
            this.update(jobId, {
              status: "completed",
              answer: completion.messages
                .map((m) => m.text)
                .filter(Boolean)
                .join("\n\n"),
              assets: JSON.stringify(assets),
            });
            // This exact fresh read already confirmed completion; retain it after status invalidation.
            this.historyCache.seed(native.nativeId, gptHistory(history, native.nativeId));
            this.observedHistory = { id: native.nativeId, value: history, checkedAt: Date.now() };
            done = true;
            streamController.abort();
          } catch {
            /* A missed observation never replays or terminates the native request. */
          } finally {
            checking = false;
          }
        })();
      }, 15000);
      monitor.unref();
      const response = await this.response(
        "/bridge/chat",
        {
          message: job.text,
          ...(this.store.db
            .prepare("SELECT projectId FROM gpt_project_jobs WHERE jobId=?")
            .get(jobId) ?? {}),
          sessionId: job.nativeId ?? undefined,
          attachments: files,
          stream: true,
        },
        30 * 60000,
        streamController.signal,
      );
      let pending = "",
        bytes = 0;
      const decoder = new TextDecoder();
      if (!response.body) throw Error("GPT_EMPTY_STREAM");
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) throw Error("GPT_STREAM_TOO_LARGE");
        pending += decoder.decode(chunk, { stream: true });
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (!line.startsWith("data: ")) continue;
          let event: Json;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (done || this.job(jobId).status === "cancelled") continue;
          const progress = gptProgress(event);
          if (progress.length) {
            const previous = this.job(jobId).progress ?? [];
            const value = JSON.stringify(mergeGptProgress(previous, progress));
            if (value !== JSON.stringify(previous)) {
              this.store.db
                .prepare(
                  "INSERT INTO gpt_job_progress VALUES(?,?) ON CONFLICT(jobId) DO UPDATE SET value=excluded.value",
                )
                .run(jobId, value);
              this.update(jobId, { status: "running" });
            }
          }
          // Whitelist public output. Never persist or forward adapter diagnostics, raw thinking or tokens.
          if (event.type === "request.started" && gptId(event.requestId))
            this.update(jobId, { requestId: event.requestId });
          if (event.type === "prompt.sent") this.update(jobId, { submitted: 1, status: "running" });
          if (event.type === "answer.snapshot" && typeof event.text === "string")
            this.update(jobId, {
              answer: gptLinkedText(event.text, {}).slice(0, 500000),
              status: "running",
            });
          if (event.type === "request.done") {
            const assets: GptFile[] = (Array.isArray(event.artifacts) ? event.artifacts : [])
              .filter((a: Json) => gptId(a.id))
              .map((a: Json) => ({
                id: a.id,
                name: typeof a.name === "string" ? a.name : "Результат",
                mime: typeof a.mime === "string" ? a.mime : "application/octet-stream",
                bytes: Number(a.size) || 0,
                image: /^image\/(png|jpeg|gif|webp|avif)$/.test(a.mime ?? ""),
                url: "/api/gpt/results/" + encodeURIComponent(a.id),
              }));
            this.update(jobId, {
              status: "completed",
              assets: JSON.stringify(assets),
              ...(gptId(event.session?.id) ? { nativeId: event.session.id } : {}),
            });
            done = true;
          }
          if (event.type === "request.error" && !done) throw Error("GPT_NATIVE_ERROR");
        }
        if (pending.length > 2 * 1024 * 1024) throw Error("GPT_STREAM_LINE_TOO_LARGE");
      }
      if (!done && this.job(jobId).status !== "cancelled") throw Error("GPT_STREAM_ENDED");
    } catch (cause) {
      const rejected = cause instanceof HubError && cause.code === "GPT_CHAT_NOT_SUBMITTED";
      if (
        !dispatched &&
        preparing === "settings" &&
        !(
          cause instanceof HubError &&
          ["GPT_UI_ATTENTION", "GPT_PREPARATION_TIMEOUT"].includes(cause.code)
        )
      )
        this.compatibilityFailure = true;
      if (!done && this.job(jobId).status !== "cancelled")
        this.update(jobId, {
          status: dispatched && !rejected ? "unknown" : "failed",
          error:
            cause instanceof HubError && cause.code === "GPT_UI_ATTENTION"
              ? cause.message + " Текст и файлы сохранены."
              : rejected
                ? cause.message
                : dispatched
                  ? "ChatGPT не подтвердил завершение. Проверь чат перед повторной отправкой."
                  : preparing === "settings"
                    ? "Не удалось выбрать модель или режим в ChatGPT. Текст и файлы сохранены."
                    : preparing === "session"
                      ? "Не удалось открыть чат в ChatGPT. Текст и файлы сохранены."
                      : "Не удалось подготовить вложения в ChatGPT. Текст и файлы сохранены.",
        });
    } finally {
      if (monitor) clearInterval(monitor);
      streamController.abort();
      if (!this.stopped && this.job(jobId).nativeId)
        await this.verifyProjectJob(jobId).catch(() => {});
      if (!this.stopped && done && this.job(jobId).status === "completed")
        await this.releaseCompletedUploads();
      this.working = false;
      this.releaseCompletion?.();
      if (!this.stopped) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = setTimeout(
          () => void this.pump(),
          this.job(jobId).status === "queued" ? 10000 : 0,
        );
        this.recoveryTimer.unref();
      }
    }
  }
  private verifyingProjects = new Set<string>();
  async verifyProjectJob(jobId: string) {
    const row = this.store.db.prepare("SELECT * FROM gpt_project_jobs WHERE jobId=?").get(jobId);
    if (!row || row.verified || this.verifyingProjects.has(jobId)) return;
    const job = this.job(jobId);
    if (!job.nativeId || Date.now() - Number(row.checkedAt) < 10000) return;
    this.verifyingProjects.add(jobId);
    this.store.db
      .prepare("UPDATE gpt_project_jobs SET checkedAt=? WHERE jobId=?")
      .run(Date.now(), jobId);
    try {
      const raw = await this.json("/conversation?id=" + encodeURIComponent(job.nativeId));
      const messages = gptHistory(raw, job.nativeId);
      const user = messages.find(
        (m) =>
          m.role === "user" && m.text === job.text && m.createdAt * 1000 >= job.createdAt - 10000,
      );
      if (raw.gizmo_id !== row.projectId || !user) return;
      this.historyCache.seed(job.nativeId, messages);
      this.library.save("thread", job.nativeId, {
        name: typeof raw.title === "string" ? raw.title.slice(0, 120) : "Продолжение",
        projectId: String(row.projectId),
        activityAt: Date.now() / 1000,
      });
      this.store.db.prepare("UPDATE gpt_project_jobs SET verified=1 WHERE jobId=?").run(jobId);
    } finally {
      this.verifyingProjects.delete(jobId);
    }
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.recoveryTimer);
    clearInterval(this.storageTimer);
    clearInterval(this.deletionTimer);
    this.lifetime.abort();
    await this.completion;
    await this.deletionWork;
    await this.operations.close();
    await this.projectContent.close();
    await this.workspaceWork.close();
  }
  async sandboxFile(conversationId: string, messageId: string, key: string) {
    if (this.native) {
      this.authorize();
      return this.native.workspace.client.media({ conversationId, messageId, fileId: key });
    }
    const raw = await this.json("/conversation?id=" + encodeURIComponent(conversationId));
    const message = gptHistory(raw, conversationId).find(
      (m) => m.id === messageId && m.role === "assistant",
    );
    const file = message?.files.find((f) => f.id === key);
    const node = Object.values(raw.mapping ?? {}).find(
      (n: any) => (n.message?.id ?? n.id) === messageId,
    ) as Json | undefined;
    const body = (node?.message?.content?.parts ?? [])
      .filter((p: unknown) => typeof p === "string")
      .join("\n");
    const path = gptSandboxFiles(body, conversationId, messageId).paths.get(key);
    if (!file || !path) throw error("GPT_RESULT_NOT_FOUND", "Файл не найден в этом ответе.", 404);
    const response = await this.response(
      "/sandbox-file?" + new URLSearchParams({ conversationId, messageId, path }),
      undefined,
      60000,
    );
    return { file, response };
  }
  async nativeAsset(conversationId: string, messageId: string, fileId: string) {
    this.authorize();
    if (!this.native || this.library.get("thread", conversationId)?.deleted)
      throw error("GPT_RESULT_NOT_FOUND", "Файл недоступен.", 404);
    return this.native.workspace.client.media({ conversationId, messageId, fileId });
  }
  async downloadBody(response: Response) {
    if (!response.body) throw error("GPT_EMPTY_ASSET", "Файл недоступен.", 503);
    if (this.native) return Readable.fromWeb(response.body as never);
    // Keep the legacy connector's existing bound; native downloads are checked
    // chunk by chunk by the private transfer protocol up to 512 MiB.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 ** 2) throw error("GPT_RESULT_TOO_LARGE", "Файл слишком большой.", 413);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async asset(fileId: string) {
    return this.response("/asset?id=" + encodeURIComponent(fileId), undefined, 60000);
  }
  async result(fileId: string) {
    const owners = this.store.db
      .prepare(
        "SELECT j.id,j.nativeId FROM gpt_jobs j, json_each(j.assets) a WHERE json_extract(a.value,'$.id')=?",
      )
      .all(fileId);
    if (
      !owners.some(
        (row) =>
          !this.library.get("thread", "outbox:" + row.id)?.deleted &&
          (!row.nativeId || !this.library.get("thread", String(row.nativeId))?.deleted),
      )
    )
      throw error("GPT_RESULT_NOT_FOUND", "Результат не найден.", 404);
    return this.response("/bridge/artifacts/" + encodeURIComponent(fileId) + "/download");
  }
}

export function registerGpt(
  app: FastifyInstance,
  config: HubConfig,
  store: Store,
  authorize?: () => void,
  nativeWorkspace?: NativeGptWorkspace,
) {
  const service = new GptService(config, store, authorize, nativeWorkspace);
  app.addHook("preClose", async () => service.close());
  app.addHook("onReady", async () => {
    void service.pump();
  });
  app.get("/api/library/gpt/:kind/:id/pending", async (req) => {
    const params = z.object({ kind: z.enum(["thread", "project"]), id }).parse(req.params);
    return { pending: service.nativeLibrary?.pending(params.kind, params.id) ?? null };
  });
  app.post("/api/library/gpt/:kind/:id", async (req) => {
    const params = z.object({ kind: z.enum(["thread", "project"]), id }).parse(req.params),
      action = entityAction.parse(req.body);
    const key = uuid.parse(req.headers["idempotency-key"]);
    if (service.nativeLibrary) {
      const previous = store.db
        .prepare("SELECT 1 FROM commands WHERE scope=? AND key=?")
        .get("library:gpt:" + params.kind + ":" + params.id, key);
      if (previous && !(params.kind === "project" && action.action === "archive"))
        throw error(
          "GPT_PROVIDER_CHANGED",
          "Это действие принадлежит прежнему подключению. Проверь его результат.",
        );
      return service.manageNativeEntity(key, params.kind, params.id, action);
    }
    return store.once(
      "library:gpt:" + params.kind + ":" + params.id,
      uuid.parse(req.headers["idempotency-key"]),
      action,
      () => libraryMutation(() => service.manageEntity(params.kind, params.id, action)),
    );
  });
  app.get("/api/library/gpt/archived", async (req) => {
    const q = z
      .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
      .parse(req.query);
    const page = await service.catalog(q.offset, true);
    return {
      items: [
        ...(!q.offset ? service.library.archived().filter((e) => e.kind === "project") : []),
        ...page.items.map((t) => ({ ...t, kind: "thread", name: t.title })),
      ],
      nextOffset: page.nextOffset,
    };
  });
  app.get("/api/gpt/native-operations", async (req) => {
    const q = z.object({ nativeId: id.optional() }).parse(req.query);
    return service.operations.list(q.nativeId);
  });
  app.get("/api/gpt/conversations/:id/messages/:messageId/action", async (req) => {
    const p = z.object({ id, messageId: id }).parse(req.params);
    service.library.assertExists("thread", p.id);
    return service.operations.preview(p.id, p.messageId);
  });
  app.get("/api/gpt/conversations/:id/messages/:messageId/versions", async (req) => {
    const p = z.object({ id, messageId: id }).parse(req.params),
      q = z.object({ targetMessageId: id.optional() }).parse(req.query);
    service.library.assertExists("thread", p.id);
    return service.operations.versions(p.id, p.messageId, q.targetMessageId);
  });
  app.post("/api/gpt/native-operations", async (req, reply) => {
    const input = gptOperationInput.parse(req.body);
    service.library.assertExists("thread", input.nativeId);
    return reply
      .code(202)
      .send(service.operations.start(uuid.parse(req.headers["idempotency-key"]), input));
  });
  app.post("/api/gpt/native-operations/:id/check", async (req) => {
    await service.operations.confirm(z.object({ id: uuid }).parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/gpt/native-operations/:id/checked", async (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    await service.operations.checked(z.object({ id: uuid }).parse(req.params).id);
    void service.pump();
    return { ok: true };
  });
  app.get("/api/gpt/projects/:id/files/:fileId", async (req, reply) => {
    const p = z.object({ id, fileId: id }).parse(req.params),
      { file, response } = await service.projectFile(p.id, p.fileId);
    if (!response.body) throw error("GPT_PROJECT_FILE_MISSING", "Файл недоступен.", 404);
    return reply
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
      )
      .header("X-Content-Type-Options", "nosniff")
      .type("application/octet-stream")
      .send(await service.downloadBody(response));
  });
  app.get("/api/gpt/projects/:id/content", async (req) => {
    const p = z.object({ id }).parse(req.params);
    service.library.assertExists("project", p.id);
    return {
      project: await service.projectContent.read(p.id),
      operations: service.projectContent.list(p.id),
      capabilities: service.projectContent.capabilities(),
    };
  });
  app.get("/api/gpt/project-operations", async () => ({
    items: service.store.db
      .prepare(
        "SELECT id,projectId,action,state,error,createdAt FROM gpt_project_operations WHERE state IN ('pending','unknown') ORDER BY createdAt LIMIT 10",
      )
      .all(),
  }));
  app.post("/api/gpt/project-operations", async (req, reply) => {
    const input = gptProjectInput.parse(req.body);
    service.library.assertExists("project", input.projectId);
    return reply
      .code(202)
      .send(service.projectContent.start(uuid.parse(req.headers["idempotency-key"]), input));
  });
  app.post("/api/gpt/project-operations/:id/check", async (req) => {
    await service.projectContent.check(z.object({ id: uuid }).parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/gpt/project-operations/:id/checked", async (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    await service.projectContent.checked(z.object({ id: uuid }).parse(req.params).id);
    void service.pump();
    return { ok: true };
  });
  app.get("/api/gpt/scheduled", async (req) => {
    const q = z
      .object({ cursor: z.string().max(4000).optional() })
      .strict()
      .parse(req.query);
    return service.workspaceWork.schedules(q.cursor);
  });
  app.get("/api/gpt/scheduled/:id", async (req) => ({
    item: await service.workspaceWork.schedule(z.object({ id: workspaceId }).parse(req.params).id),
  }));
  app.get("/api/gpt/canvas", async (req) => {
    const q = z.object({ conversationId: workspaceId }).strict().parse(req.query);
    service.library.assertExists("thread", q.conversationId);
    return service.workspaceWork.canvases(q.conversationId);
  });
  app.get("/api/gpt/canvas/version", async (req) => {
    const q = z
      .object({
        conversationId: workspaceId,
        id: workspaceId,
        version: z.coerce.number().int().min(1).max(1000000),
      })
      .strict()
      .parse(req.query);
    service.library.assertExists("thread", q.conversationId);
    return service.workspaceWork.version(q.conversationId, q.id, q.version);
  });
  app.get("/api/gpt/workspace-operations", async () => ({ items: service.workspaceWork.list() }));
  app.get("/api/gpt/workspace-operations/:id", async (req) =>
    service.workspaceWork.get(z.object({ id: uuid }).parse(req.params).id),
  );
  app.post("/api/gpt/workspace-operations", async (req, reply) =>
    reply
      .code(202)
      .send(
        service.workspaceWork.start(
          uuid.parse(req.headers["idempotency-key"]),
          workspaceInput.parse(req.body),
        ),
      ),
  );
  app.post("/api/gpt/workspace-operations/:id/check", async (req) => {
    const id = z.object({ id: uuid }).parse(req.params).id;
    await service.workspaceWork.check(id);
    return service.workspaceWork.get(id);
  });
  app.post("/api/gpt/workspace-operations/:id/checked", async (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const id = z.object({ id: uuid }).parse(req.params).id;
    await service.workspaceWork.checked(id);
    void service.pump();
    return service.workspaceWork.get(id);
  });
  app.get("/api/gpt/status", async () => service.connection());
  app.post("/api/gpt/reconnect", async () => service.reconnect());
  app.get("/api/gpt/models", async () => service.models());
  app.get("/api/gpt/conversations", async (req) => {
    const q = z
      .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
      .parse(req.query);
    return service.catalog(q.offset);
  });
  app.get("/api/gpt/projects", async () => {
    return service.projects();
  });
  app.get("/api/gpt/conversations/:id/messages", async (req) => {
    const p = z.object({ id }).parse(req.params),
      q = z
        .object({
          before: id.optional(),
          messageId: id.optional(),
          cached: z.literal("1").optional(),
          known: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          anchor: id.optional(),
          prefix: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .parse(req.query);
    const running = !!store.db
      .prepare(
        "SELECT 1 FROM gpt_jobs WHERE nativeId=? AND status IN ('queued','preparing','running') LIMIT 1",
      )
      .get(p.id);
    service.library.assertExists("thread", p.id);
    return service.historyCache.page(
      p.id,
      q,
      running ? 15000 : 60000,
      !q.known || q.cached === "1",
    );
  });
  app.get("/api/gpt/conversations/:id/results", async (req) => {
    const p = z.object({ id }).parse(req.params);
    const q = z
      .object({
        category: resultCategorySchema.default("all"),
        before: id.optional(),
        cached: z.literal("1").optional(),
      })
      .parse(req.query);
    service.library.assertExists("thread", p.id);
    const snapshot = await service.historyCache.snapshot(
      p.id,
      60000,
      q.cached === "1" && !q.before,
    );
    return {
      ...resultPage(
        gptResults(
          p.id,
          snapshot.items,
          service.previews,
          service.config.hub.publicBaseUrl,
          service.textArtifacts,
        ),
        q.category,
        q.before,
      ),
      sourceRevision: snapshot.lineage,
    };
  });
  app.get("/api/gpt/conversations/:id/canvases", async (req) => {
    const p = z.object({ id }).parse(req.params);
    const q = z.object({ cached: z.literal("1").optional() }).parse(req.query);
    const items = await service.canvasResults(p.id, q.cached === "1");
    return { ...resultPage(items, "files"), items, nextBefore: null };
  });
  app.get("/api/gpt/text-artifacts/:id", async (req, reply) => {
    service.authorize();
    const item = service.textArtifacts.describe(
      z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params).id,
    );
    service.library.assertExists("thread", item.conversationId);
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(item.name),
      )
      .header("Content-Length", item.bytes)
      .type("text/markdown; charset=utf-8")
      .send(createReadStream(item.path));
  });
  app.get("/api/gpt/conversations/:id/results/:resultId", async (req) => {
    const p = z.object({ id, resultId: id }).parse(req.params);
    service.library.assertExists("thread", p.id);
    if (p.resultId.startsWith("canvas-")) {
      const canvas = (await service.canvasResults(p.id)).find((row) => row.id === p.resultId);
      if (!canvas) throw error("RESULT_NOT_FOUND", "Результат не найден.", 404);
      return canvas;
    }
    const item = gptResults(
      p.id,
      await service.historyCache.messages(p.id),
      service.previews,
      service.config.hub.publicBaseUrl,
      service.textArtifacts,
    ).find((row) => row.id === p.resultId);
    if (!item) throw error("RESULT_NOT_FOUND", "Результат не найден.", 404);
    return item;
  });
  app.post("/api/gpt/conversations/:id/results/reveal", async (req) => {
    const p = z.object({ id }).parse(req.params),
      ref = resultReferenceSchema.parse(req.body);
    service.library.assertExists("thread", p.id);
    const messages = await service.historyCache.messages(p.id);
    // Live outbox text is keyed by its durable job, canonical history by message.
    // Only verified receipt IDs from this conversation may bridge that identity.
    const ids = new Set([ref.messageId, ...service.receiptMessageIds(ref.messageId, p.id)]);
    const matches = messages
      .filter((item) => ids.has(item.id) && item.role === "assistant")
      .flatMap((message) => {
        if (/^text-block:\d+:[a-f0-9]{64}$/.test(ref.source)) {
          const [, offset, hash] = ref.source.split(":");
          const block = gptResultContent(message.text).blocks.find(
            (block) =>
              block.offset === Number(offset) &&
              createHash("sha256").update(block.text).digest("hex") === hash,
          );
          if (
            !block ||
            textBlockLines(block.text) <= CHAT_BLOCK_LINES ||
            message.complete === false ||
            message.phase === "commentary"
          )
            return [];
          return [
            service.textArtifacts.put(
              p.id,
              message.id,
              block,
              new Date(message.createdAt * 1000 || 0).toISOString(),
            ),
          ];
        }
        const source = ref.source.startsWith("sandbox:")
          ? gptSandboxFiles(`[file](<${ref.source}>)`, p.id, message.id).files[0]?.url
          : ref.source;
        const file = message.files.find((item) => item.url === source);
        return file
          ? gptResults(p.id, [message], service.previews, service.config.hub.publicBaseUrl).filter(
              (item) => item.id === file.id,
            )
          : [];
      });
    const result = matches.length === 1 ? matches[0] : undefined;
    if (!result)
      throw error(
        "RESULT_NOT_FOUND",
        "Этот файл или изображение недоступны в исходном сообщении.",
        404,
      );
    return result;
  });
  const gptPreview = async (previewId: string) => {
    const scope = service.previews.thread(previewId);
    if (!scope.startsWith("gpt:")) throw error("PREVIEW_NOT_FOUND", "Демо не найдено.", 404);
    service.library.assertExists("thread", scope.slice(4));
    return service.previews.document(previewId);
  };
  app.get("/api/gpt/previews/:id/ready", async (req) => {
    await gptPreview(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.params).id);
    return { ready: true };
  });
  app.get("/api/gpt/previews/:id", async (req, reply) => {
    assertPreviewFrame(req.headers);
    const html = await gptPreview(
      z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.params).id,
    );
    return reply
      .header("Content-Security-Policy", previewCsp)
      .removeHeader("X-Frame-Options")
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
      .type("text/html; charset=utf-8")
      .send(html);
  });
  app.get("/api/gpt/jobs", async (req) => {
    const q = z
      .object({
        nativeId: id.optional(),
        watch: uuid.optional(),
        after: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const live = await service.liveProgress(q.nativeId, q.watch);
    return { ...service.updates(q.nativeId, q.watch, q.after), live };
  });
  app.post("/api/gpt/send", async (req, reply) =>
    reply.code(202).send({
      job: service.enqueue(uuid.parse(req.headers["idempotency-key"]), input.parse(req.body)),
    }),
  );
  app.post("/api/gpt/jobs/:id/dismiss", async (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return { job: service.dismiss(z.object({ id: uuid }).parse(req.params).id) };
  });
  app.post("/api/gpt/jobs/:id/cancel", async (req) => ({
    job: await service.cancel(z.object({ id: uuid }).parse(req.params).id),
  }));
  app.post("/api/gpt/jobs/:id/resolve", async (req) => ({
    job: await service.resolve(z.object({ id: uuid }).parse(req.params).id),
  }));
  app.post("/api/gpt/uploads", { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.query);
    if (!Buffer.isBuffer(req.body))
      throw error("GPT_INVALID_UPLOAD", "Не удалось прочитать файл.", 400);
    return reply.code(201).send({ file: await service.put(name, req.body) });
  });
  app.get("/api/gpt/uploads/:id", async (req, reply) => {
    const file = service.upload(z.object({ id: uuid }).parse(req.params).id);
    reply.header(
      "Content-Disposition",
      (file.image ? "inline" : "attachment") +
        "; filename*=UTF-8''" +
        encodeURIComponent(file.name),
    );
    return reply
      .type(file.image ? file.mime : "application/octet-stream")
      .send(createReadStream(join(service.root, file.id)));
  });
  app.get("/api/gpt/downloads/:conversationId/:messageId/:key", async (req, reply) => {
    const params = z
      .object({
        conversationId: id,
        messageId: id,
        key: z.string().regex(/^sandbox-[a-f0-9]{64}$/),
      })
      .parse(req.params);
    const { file, response } = await service.sandboxFile(
      params.conversationId,
      params.messageId,
      params.key,
    );
    if (!response.body) throw error("GPT_EMPTY_ASSET", "Файл недоступен. Попробуй ещё раз.", 503);
    return reply
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
      )
      .header("X-Content-Type-Options", "nosniff")
      .type("application/octet-stream")
      .send(await service.downloadBody(response));
  });
  app.get("/api/gpt/native-assets/:conversationId/:messageId/:fileId", async (req, reply) => {
    const p = z
      .object({
        conversationId: uuid,
        messageId: id,
        fileId: id.refine((v) => /^file[-_]/.test(v)),
      })
      .parse(req.params);
    const { file, response } = await service.nativeAsset(p.conversationId, p.messageId, p.fileId);
    if (!response.body) throw error("GPT_EMPTY_ASSET", "Файл недоступен.", 503);
    reply.header(
      "Content-Disposition",
      (file.image ? "inline" : "attachment") +
        "; filename*=UTF-8''" +
        encodeURIComponent(file.name),
    );
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .type(file.image ? file.mime : "application/octet-stream")
      .send(await service.downloadBody(response));
  });
  app.get("/api/gpt/assets/:id", async (req, reply) => {
    const fileId = z
      .object({ id: id.refine((value) => /^file[-_]/.test(value)) })
      .parse(req.params).id;
    const response = await service.asset(fileId);
    const chunks: Buffer[] = [];
    let size = 0;
    if (!response.body) throw error("GPT_EMPTY_ASSET", "Изображение недоступно.", 503);
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024)
        throw error("GPT_RESULT_TOO_LARGE", "Результат слишком большой.", 413);
      chunks.push(Buffer.from(chunk));
    }
    const mime = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(mime);
    reply.header("Content-Disposition", image ? "inline" : "attachment");
    return reply.type(image ? mime : "application/octet-stream").send(Buffer.concat(chunks));
  });
  app.get("/api/gpt/results/:id", async (req, reply) => {
    const response = await service.result(z.object({ id }).parse(req.params).id);
    const chunks: Buffer[] = [];
    let size = 0;
    if (!response.body) throw error("GPT_EMPTY_ASSET", "Результат недоступен.", 503);
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024)
        throw error("GPT_RESULT_TOO_LARGE", "Результат слишком большой.", 413);
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const mime = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(mime);
    reply.header("Content-Disposition", image ? "inline" : "attachment");
    return reply.type(image ? mime : "application/octet-stream").send(bytes);
  });
  return service;
}
