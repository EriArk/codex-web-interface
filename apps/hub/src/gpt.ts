import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GptFile,
  type GptJob,
  type GptModels,
  type HubConfig,
  HubError,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { GptHistoryCache } from "./gpt-cache.js";
import {
  gptCatalog,
  gptCompletion,
  gptHistory,
  gptId,
  gptProjectConversations,
  gptProjects,
} from "./gpt-history.js";
import { gptProgress, mergeGptProgress } from "./gpt-progress.js";
import {
  type EntityAction,
  type EntityKind,
  entityAction,
  Library,
  libraryMutation,
} from "./library.js";
import type { Store } from "./store.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const uuid = z.string().uuid();
const settings = z.object({ model: z.string().min(1).max(120), effort: z.string().regex(/^\d$/) });
const input = settings
  .extend({ nativeId: id.nullable(), text: z.string().max(100000), files: z.array(uuid).max(8) })
  .strict();
type Input = z.infer<typeof input>;
type Json = Record<string, any>;
const active = ["queued", "preparing", "running"];
const error = (code: string, message: string, status = 409) => new HubError(status, code, message);
export class GptService {
  readonly historyCache = new GptHistoryCache(async (id) =>
    gptHistory(await this.json("/conversation?id=" + encodeURIComponent(id))),
  );
  private working = false;
  private libraryBusy = false;
  readonly library: Library;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private completion = Promise.resolve();
  private releaseCompletion: (() => void) | undefined;
  private modelsPending: Promise<GptModels> | undefined;
  private modelCache: { value: GptModels; expires: number } | undefined;
  private readonly token: string;
  readonly root: string;
  constructor(
    readonly config: HubConfig,
    readonly store: Store,
  ) {
    this.library = new Library(store, "gpt");
    this.token = config.gpt ? (process.env[config.gpt.tokenSecret] ?? "") : "";
    this.root = join(config.hub.resultsPath, "gpt");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // Never replay an ambiguous native submission after a Hub restart.
    store.db
      .prepare(
        "UPDATE gpt_jobs SET status='unknown',error=? WHERE status IN ('preparing','running')",
      )
      .run("Соединение прервалось. Проверь ответ в чате перед повторной отправкой.");
  }
  available() {
    return !!this.config.gpt && !!this.token;
  }
  private async response(path: string, body?: unknown, timeout = 30000, signal?: AbortSignal) {
    if (!this.available())
      throw error("GPT_NOT_CONFIGURED", "Подключение GPT ещё не настроено.", 503);
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
      return response;
    } catch (e) {
      if (e instanceof HubError) throw e;
      throw error("GPT_CONNECTION_LOST", "Нет связи с подключением GPT.", 503);
    }
  }
  async json(path: string, body?: unknown): Promise<Json> {
    return (await this.response(path, body)).json();
  }
  async pins() {
    const raw = await this.json("/pins");
    const rows: Json[] = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    return rows
      .filter((row) => ["conversation", "project"].includes(row.item_type))
      .flatMap((row) => {
        const item = row.item;
        const nativeId = item?.gizmo?.id ?? item?.gizmo?.gizmo?.id ?? item?.id;
        return gptId(nativeId)
          ? [{ id: nativeId, kind: row.item_type === "project" ? "project" : "thread", item }]
          : [];
      });
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
        archived: recent ? saved.archived : archived,
      });
      if (recent) row.title = saved.name;
    }
    if (!archived && offset === 0) {
      for (const pin of pins.filter((p) => p.kind === "thread")) {
        const item = gptCatalog({ items: [pin.item] }).items[0];
        if (item && !page.items.some((t) => t.id === item.id)) page.items.push(item);
      }
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
    for (const entry of this.library
      .all()
      .filter((e) => e.kind === "project" && (e.archived || e.deleted)))
      if (!items.some((p) => p.id === entry.id))
        items.push({ ...entry, name: entry.name, pinned: false });
    return {
      items,
      conversations: gptProjectConversations(raw)
        .filter((row) => !this.library.get("thread", row.id)?.deleted)
        .map((row) => ({
          ...row,
          pinned: pins.some((p) => p.kind === "thread" && p.id === row.id),
        })),
    };
  }
  async manageEntity(kind: EntityKind, nativeId: string, action: EntityAction) {
    this.library.assertExists(kind, nativeId);
    if (
      this.working ||
      this.libraryBusy ||
      this.jobs().some((job) => active.includes(job.status) || job.status === "unknown")
    )
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
          this.historyCache.invalidate(child.id);
          this.store.db.prepare("DELETE FROM gpt_jobs WHERE nativeId=?").run(child.id);
        }
      }
      if (kind === "thread") {
        this.historyCache.invalidate(nativeId);
        if (action.action === "delete")
          this.store.db.prepare("DELETE FROM gpt_jobs WHERE nativeId=?").run(nativeId);
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
    if (this.working) throw error("GPT_BUSY", "Модели обновятся после текущего ответа.");
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
        efforts: z.array(option).min(1).max(10),
        currentModel: z.string(),
        currentEffort: z.string(),
      })
      .parse(data);
    this.modelCache = { value, expires: Date.now() + 15 * 60000 };
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
      if (selected && count <= 20) return [this.job(String(row.id))];
      return [
        {
          id: String(row.id),
          nativeId: row.nativeId === null ? null : String(row.nativeId),
          status: row.status as GptJob["status"],
          createdAt: Number(row.createdAt),
          updatedAt: Number(row.updatedAt),
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
  jobs(): GptJob[] {
    return this.store.db
      .prepare("SELECT * FROM gpt_jobs ORDER BY createdAt DESC LIMIT 100")
      .all()
      .map((row) => this.publicJob(row));
  }
  private publicJob(row: Json): GptJob {
    return {
      id: row.id,
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
      error: row.error,
    };
  }
  job(jobId: string) {
    const row = this.store.db.prepare("SELECT * FROM gpt_jobs WHERE id=?").get(jobId);
    if (!row) throw error("GPT_JOB_NOT_FOUND", "Отправка не найдена.", 404);
    return this.publicJob(row);
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
  async put(name: string, bytes: Buffer): Promise<GptFile> {
    if (
      !name.trim() ||
      name.length > 240 ||
      /[\\/]/.test(name) ||
      Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw error("GPT_INVALID_FILENAME", "Проверь имя файла.", 400);
    if (!bytes.length || bytes.length > 25 * 1024 * 1024)
      throw error("GPT_FILE_TOO_LARGE", "Файл должен быть меньше 25 МБ.", 413);
    const total = Number(
      this.store.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM gpt_uploads").get()?.total,
    );
    if (total + bytes.length > 2 * 1024 ** 3)
      throw error("GPT_STORAGE_FULL", "Хранилище вложений GPT заполнено.", 507);
    let mime = "application/octet-stream",
      image = false;
    if (/\.(png|jpe?g|webp|gif|avif|heic|heif|tiff?)$/i.test(name)) {
      try {
        bytes = await sharp(bytes, { limitInputPixels: 50_000_000, pages: 1 })
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
    const fileId = randomUUID();
    writeFileSync(join(this.root, fileId), bytes, { mode: 0o600, flag: "wx" });
    this.store.db
      .prepare("INSERT INTO gpt_uploads VALUES(?,?,?,?,?,?)")
      .run(fileId, name, mime, bytes.length, Number(image), Date.now());
    return this.upload(fileId);
  }
  enqueue(jobId: string, value: Input) {
    if (!this.available())
      throw error("GPT_NOT_CONFIGURED", "Подключение GPT ещё не настроено.", 503);
    if (this.libraryBusy)
      throw error("GPT_LIBRARY_BUSY", "Обновляем список чатов. Повтори отправку через секунду.");
    if (value.nativeId) {
      this.library.assertExists("thread", value.nativeId);
      if (this.library.get("thread", value.nativeId)?.archived)
        throw error("GPT_ARCHIVED", "Сначала разархивируй чат.");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const existing = this.store.db
      .prepare("SELECT fingerprint FROM gpt_jobs WHERE id=?")
      .get(jobId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw error("GPT_KEY_REUSED", "Эта отправка уже содержит другое сообщение.");
      return this.job(jobId);
    }
    if (!value.text.trim() && !value.files.length)
      throw error("GPT_EMPTY_MESSAGE", "Добавь текст или файл.", 400);
    if (new Set(value.files).size !== value.files.length)
      throw error("GPT_DUPLICATE_FILE", "Вложение добавлено дважды.", 400);
    const files = value.files.map((fileId) => this.upload(fileId));
    if (files.reduce((n, f) => n + f.bytes, 0) > 64 * 1024 * 1024)
      throw error("GPT_FILES_TOO_LARGE", "До 64 МБ на сообщение.", 413);
    if (this.jobs().filter((job) => active.includes(job.status)).length >= 20)
      throw error("GPT_QUEUE_FULL", "Очередь заполнена.");
    if (this.jobs().some((job) => job.status === "unknown"))
      throw error(
        "GPT_CHECK_PREVIOUS",
        "Сначала проверь предыдущую отправку с неизвестным состоянием.",
      );
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
    void this.pump();
    return this.job(jobId);
  }
  private update(jobId: string, values: Json) {
    if (values.status && ["completed", "cancelled", "unknown", "failed"].includes(values.status)) {
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
    await this.json("/bridge/browser/stop", { reason: "Owner requested stop" });
    this.update(jobId, { status: "cancelled" });
    return this.job(jobId);
  }
  resolve(jobId: string) {
    if (this.job(jobId).status !== "unknown")
      throw error("GPT_NOT_UNKNOWN", "Состояние уже определено.");
    this.update(jobId, { status: "cancelled", error: "" });
    void this.pump();
    return this.job(jobId);
  }
  async pump() {
    if (
      this.working ||
      this.libraryBusy ||
      this.stopped ||
      !this.available() ||
      this.jobs().some((job) => job.status === "unknown")
    )
      return;
    const next = this.store.db
      .prepare("SELECT id FROM gpt_jobs WHERE status='queued' ORDER BY createdAt LIMIT 1")
      .get();
    if (!next) return;
    this.working = true;
    this.completion = new Promise((resolve) => {
      this.releaseCompletion = resolve;
    });
    const jobId = String(next.id);
    let dispatched = false,
      done = false,
      checking = false;
    const streamController = new AbortController();
    let monitor: ReturnType<typeof setInterval> | undefined;
    try {
      if (this.modelsPending) await this.modelsPending;
      const job = this.job(jobId);
      this.update(jobId, { status: "preparing" });
      if (job.nativeId) await this.json("/bridge/sessions/select", { sessionId: job.nativeId });
      else await this.json("/bridge/sessions/new", {});
      if (this.job(jobId).status === "cancelled") return;
      await this.json("/settings", { model: job.model, effort: job.effort });
      await this.json("/bridge/composer/attachments/clear", {});
      const files: string[] = [];
      for (const file of job.files) {
        const data = await this.json("/bridge/files", {
          name: file.name,
          mime: file.mime,
          contentBase64: readFileSync(join(this.root, file.id)).toString("base64"),
        });
        if (!gptId(data.file?.id))
          throw error("GPT_UPLOAD_FAILED", "Не удалось подготовить вложение.");
        files.push(data.file.id);
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
            const history = await this.json(
              "/conversation?id=" + encodeURIComponent(native.nativeId),
            );
            if (this.stopped || done) return;
            this.historyCache.seed(native.nativeId, gptHistory(history));
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
            done = true;
            streamController.abort();
          } catch {
            /* A missed observation never replays or terminates the native request. */
          } finally {
            checking = false;
          }
        })();
      }, 5000);
      monitor.unref();
      const response = await this.response(
        "/bridge/chat",
        {
          message: job.text,
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
            this.update(jobId, { answer: event.text.slice(0, 500000), status: "running" });
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
    } catch {
      if (!done && this.job(jobId).status !== "cancelled")
        this.update(jobId, {
          status: dispatched ? "unknown" : "failed",
          error: dispatched
            ? "ChatGPT не подтвердил завершение. Проверь чат перед повторной отправкой."
            : "Не удалось подготовить отправку. Текст и файлы сохранены.",
        });
    } finally {
      if (monitor) clearInterval(monitor);
      streamController.abort();
      this.working = false;
      this.releaseCompletion?.();
      if (!this.stopped) void this.pump();
    }
  }
  async close() {
    this.stopped = true;
    this.lifetime.abort();
    await this.completion;
  }
  async asset(fileId: string) {
    return this.response("/asset?id=" + encodeURIComponent(fileId), undefined, 60000);
  }
  async result(fileId: string) {
    if (!this.jobs().some((job) => job.assets.some((asset) => asset.id === fileId)))
      throw error("GPT_RESULT_NOT_FOUND", "Результат не найден.", 404);
    return this.response("/bridge/artifacts/" + encodeURIComponent(fileId) + "/download");
  }
}

export function registerGpt(app: FastifyInstance, config: HubConfig, store: Store) {
  const service = new GptService(config, store);
  app.addHook("preClose", async () => service.close());
  app.addHook("onReady", async () => {
    void service.pump();
  });
  app.post("/api/library/gpt/:kind/:id", async (req) => {
    const params = z.object({ kind: z.enum(["thread", "project"]), id }).parse(req.params),
      action = entityAction.parse(req.body);
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
  app.get("/api/gpt/status", async () => ({
    configured: service.available(),
    ...(service.available() ? await service.json("/status") : {}),
    connectUrl: "/gpt-connect",
  }));
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
    return service.historyCache.page(p.id, q, running ? 3000 : 15000);
  });
  app.get("/api/gpt/jobs", async (req) => {
    const q = z
      .object({
        nativeId: id.optional(),
        watch: uuid.optional(),
        after: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    return service.updates(q.nativeId, q.watch, q.after);
  });
  app.post("/api/gpt/send", async (req, reply) =>
    reply.code(202).send({
      job: service.enqueue(uuid.parse(req.headers["idempotency-key"]), input.parse(req.body)),
    }),
  );
  app.post("/api/gpt/jobs/:id/cancel", async (req) => ({
    job: await service.cancel(z.object({ id: uuid }).parse(req.params).id),
  }));
  app.post("/api/gpt/jobs/:id/resolve", async (req) => ({
    job: service.resolve(z.object({ id: uuid }).parse(req.params).id),
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
