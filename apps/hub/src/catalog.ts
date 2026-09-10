import { createHash, randomUUID } from "node:crypto";
import { join, posix, win32 } from "node:path";
import type { CodexClient } from "@codex-web/codex";
import {
  type HubConfig,
  HubError,
  type MachineConfig,
  type ProjectConfig,
  turnSettingsSchema,
} from "@codex-web/shared";
import { Artifacts } from "./artifacts.js";
import { GeneratedArtifacts } from "./generatedArtifacts.js";
import { type EntityAction, Library } from "./library.js";
import { displayUserText, NativeImages } from "./nativeImages.js";
import { Previews } from "./previews.js";
import type { MessageRecord, Store, ThreadRecord } from "./store.js";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, max = 200000) => (typeof v === "string" ? v.slice(0, max) : "");
const array = (v: unknown) => (Array.isArray(v) ? v.map(obj) : []);
const iso = (v: unknown) =>
  new Date(typeof v === "number" && v > 0 ? v * 1000 : Date.now()).toISOString();
export type CatalogProject = ProjectConfig & {
  sourceId?: string;
  roots?: string[];
  position?: number;
  discovered?: boolean;
  unassigned?: boolean;
};
type Cursor = {
  matchedUsers?: string[];
  rpc?: string;
  pending: MessageRecord[];
  offset: number;
  kind: "items" | "turns";
  turnId?: string;
};
type HistoryPage = {
  sourceVersion?: number;
  messages: MessageRecord[];
  nextBefore: string | null;
  hasMore: boolean;
  lastSeq: number;
  contextTurn?: string;
  hasNewer?: boolean;
};

/** Native Codex metadata is the source. Only small catalog snapshots live in Hub storage. */
export class Catalog {
  private refreshed = 0;
  private refreshing?: Promise<void>;
  private threadRefresh = new Map<string, { at: number; pending?: Promise<void> }>();
  private pages = new Map<string, { until: number; value: Promise<HistoryPage> }>();
  readonly projectSupport = new Map<string, boolean>();
  readonly library: Library;
  readonly images: NativeImages;
  readonly previews: Previews;
  readonly artifacts: GeneratedArtifacts;
  readonly errors = new Map<string, string>();
  constructor(
    readonly config: HubConfig,
    readonly store: Store,
    private connect: (machineId: string) => Promise<CodexClient>,
  ) {
    this.library = new Library(store, "codex");
    this.images = new NativeImages(config, store, (threadId) => {
      const thread = store.thread(threadId),
        project = this.projects().find((p) => p.id === thread.projectId);
      if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден");
      return this.machine(project.machineId);
    });
    this.previews = new Previews(join(config.hub.resultsPath, "previews"), store, (threadId) => {
      const thread = store.thread(threadId);
      const project = this.projects().find((p) => p.id === thread.projectId);
      if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден");
      return {
        machine: this.machine(project.machineId),
        root: thread.workingDirectory || project.workingDirectory,
      };
    });
    this.artifacts = new GeneratedArtifacts(
      store,
      new Artifacts(config.hub.resultsPath, store, config.hub.storage.artifactBytes),
      (threadId) => {
        const thread = store.thread(threadId),
          project = this.projects().find((p) => p.id === thread.projectId);
        if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден.");
        return {
          machine: this.machine(project.machineId),
          root: thread.workingDirectory || project.workingDirectory,
        };
      },
    );
    store.db
      .prepare("DELETE FROM history_cursors WHERE createdAt<?")
      .run(Date.now() - 7 * 86400000);
  }
  projects(): CatalogProject[] {
    const projects = new Map<string, CatalogProject>(
      this.config.projects.filter((p) => p.enabled).map((p) => [p.id, p]),
    );
    for (const row of this.store.db.prepare("SELECT value FROM catalog_projects").all()) {
      const p = JSON.parse(String(row.value)) as CatalogProject;
      if (this.config.machines.some((m) => m.id === p.machineId)) projects.set(p.id, p);
    }
    for (const machine of this.config.machines) {
      const seed = this.config.projects.find((p) => p.machineId === machine.id && p.enabled);
      if (seed)
        projects.set("unassigned-" + machine.id, {
          id: "unassigned-" + machine.id,
          name: "Без проекта",
          machineId: machine.id,
          workingDirectory: seed.workingDirectory,
          enabled: true,
          unassigned: true,
          position: 10000,
        });
    }
    return [...projects.values()].sort(
      (a, b) => (a.position ?? 999) - (b.position ?? 999) || a.name.localeCompare(b.name),
    );
  }
  machine(id: string): MachineConfig {
    const machine = this.config.machines.find((m) => m.id === id);
    if (!machine) throw new HubError(404, "MACHINE_NOT_FOUND", "Компьютер не найден");
    return machine;
  }
  pathKey(machine: MachineConfig, path: string): string {
    return machine.type === "ssh-windows"
      ? win32
          .normalize(path)
          .replace(/[\\/]+$/, "")
          .toLowerCase()
      : posix.normalize(path).replace(/\/+$/, "");
  }
  absolute(machine: MachineConfig, path: string): string {
    if (
      !path ||
      path.length > 2048 ||
      Array.from(path).some((c) => c.charCodeAt(0) < 32) ||
      !(machine.type === "ssh-windows" ? /^(?:[a-z]:[\\/]|\\\\)/i.test(path) : path.startsWith("/"))
    )
      throw new HubError(
        400,
        "ABSOLUTE_PATH_REQUIRED",
        "Укажи абсолютный путь к папке на выбранном компьютере",
      );
    return machine.type === "ssh-windows" ? win32.normalize(path) : posix.normalize(path);
  }
  private saveProject(
    machine: MachineConfig,
    raw: Record<string, unknown>,
  ): CatalogProject | undefined {
    const sourceId = str(raw.id, 100),
      roots = array(raw.roots)
        .map((r) => str(r.path, 2048))
        .filter(Boolean);
    if (!sourceId || !roots.length) return;
    const normalized = roots.map((path) => this.absolute(machine, path));
    const old = this.projects().find((p) => p.machineId === machine.id && p.sourceId === sourceId);
    const seed = this.config.projects.find(
      (p) =>
        !this.projects().some(
          (saved) => saved.id === p.id && saved.sourceId && saved.sourceId !== sourceId,
        ) &&
        p.machineId === machine.id &&
        this.pathKey(machine, p.workingDirectory) === this.pathKey(machine, normalized[0] ?? ""),
    );
    const id =
      old?.id ??
      seed?.id ??
      "p-" +
        createHash("sha256")
          .update(machine.id + ":" + sourceId)
          .digest("hex")
          .slice(0, 32);
    const project: CatalogProject = {
      id,
      sourceId,
      name: str(raw.name, 120) || "Проект",
      machineId: machine.id,
      workingDirectory: normalized[0] ?? "",
      roots: normalized,
      enabled: true,
      discovered: true,
      position: Number(raw.position) || 0,
    };
    this.store.db
      .prepare(
        "INSERT INTO catalog_projects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,sourceId=excluded.sourceId",
      )
      .run(id, machine.id, sourceId, JSON.stringify(project));
    return project;
  }
  async refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && this.refreshed && Date.now() - this.refreshed < 60000) return;
    this.refreshing = (async () => {
      for (const machine of this.config.machines) {
        try {
          const rpc = await this.connect(machine.id);
          let cursor: unknown;
          const found = new Set<string>();
          let complete = false;
          for (let n = 0; n < 20; n++) {
            const page = await rpc.request("project/list", {
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            if (!Array.isArray(page.data)) throw new Error("Invalid project catalog");
            for (const project of array(page.data)) {
              const saved = this.saveProject(machine, project);
              if (saved) found.add(saved.sourceId ?? "");
            }
            cursor = page.nextCursor;
            if (!cursor) {
              complete = true;
              break;
            }
          }
          if (complete)
            for (const row of this.store.db
              .prepare("SELECT id,sourceId FROM catalog_projects WHERE machineId=?")
              .all(machine.id)) {
              if (!found.has(String(row.sourceId)))
                this.store.db
                  .prepare("DELETE FROM catalog_projects WHERE id=?")
                  .run(String(row.id));
            }
          this.projectSupport.set(machine.id, true);
          this.errors.delete(machine.id);
        } catch (error) {
          if (error instanceof HubError && error.code === "CODEX_METHOD_UNSUPPORTED") {
            this.projectSupport.set(machine.id, false);
            this.errors.set(
              machine.id,
              "Установленный Codex не поддерживает управление проектами. Настроенные проекты остаются доступны.",
            );
            continue;
          }
          this.errors.set(
            machine.id,
            "Не удалось обновить проекты с компьютера. Сохранённый список доступен.",
          );
        }
      }
      this.refreshed = Date.now();
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  publicProjects() {
    return this.projects().map((p) => {
      const machine = this.machine(p.machineId);
      return {
        id: p.id,
        name: p.name,
        pinned: this.library.get("project", p.id)?.pinned === true,
        archived: this.library.get("project", p.id)?.archived === true,
        deleted: this.library.get("project", p.id)?.deleted === true,
        unassigned: p.unassigned === true,
        machineId: machine.id,
        machineName: machine.name,
        remoteAvailable: !!machine.remote,
        workingDirectory: p.workingDirectory,
        roots: p.roots ?? [p.workingDirectory],
        source: p.discovered ? "codex" : "configured",
        threadCount: Number(
          this.store.db
            .prepare("SELECT COUNT(*) AS n FROM threads WHERE projectId=? AND archived=0")
            .get(p.id)?.n ?? 0,
        ),
      };
    });
  }
  machines() {
    return this.config.machines.map((m) => {
      const seed =
        this.config.projects.find((p) => p.machineId === m.id) ??
        this.projects().find((p) => p.machineId === m.id);
      const root = seed
        ? m.type === "ssh-windows"
          ? win32.dirname(seed.workingDirectory)
          : posix.dirname(seed.workingDirectory)
        : "";
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        projectsDirectory: root,
        canCreateProjects: this.projectSupport.get(m.id) !== false,
        remoteAvailable: !!m.remote,
        desktopRestartAvailable: m.type === "ssh-windows" && !!m.codex.desktopControl,
      };
    });
  }
  async directories(machineId: string, path: string) {
    const machine = this.machine(machineId),
      cwd = this.absolute(machine, path);
    const rpc = await this.connect(machineId);
    const result = await rpc.request("fs/readDirectory", { path: cwd });
    const osPath = machine.type === "ssh-windows" ? win32 : posix;
    const parent = osPath.dirname(cwd);
    return {
      path: cwd,
      parent: parent === cwd ? null : parent,
      entries: array(result.entries)
        .filter(
          (entry) =>
            entry.isDirectory &&
            str(entry.fileName) &&
            osPath.basename(str(entry.fileName)) === entry.fileName &&
            ![".", ".."].includes(str(entry.fileName)),
        )
        .map((entry) => ({
          name: str(entry.fileName, 255),
          path: osPath.join(cwd, str(entry.fileName, 255)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500),
    };
  }
  async createProject(
    machineId: string,
    name: string,
    path: string,
    createDirectory: boolean,
    idempotencyKey: string,
  ) {
    const machine = this.machine(machineId),
      cwd = this.absolute(machine, path);
    await this.refresh();
    if (this.projectSupport.get(machineId) === false)
      throw new HubError(
        501,
        "CODEX_METHOD_UNSUPPORTED",
        "Установленный Codex не поддерживает создание проектов",
      );
    const rpc = await this.connect(machineId);
    if (createDirectory) await rpc.request("fs/createDirectory", { path: cwd, recursive: true });
    const metadata = await rpc.request("fs/getMetadata", { path: cwd });
    if (!metadata.isDirectory)
      throw new HubError(400, "DIRECTORY_REQUIRED", "Выбранный путь не является папкой");
    const result = await rpc.request("project/create", {
      name,
      roots: [{ path: cwd }],
      idempotencyKey,
    });
    const project = this.saveProject(machine, obj(result.project));
    if (!project)
      throw new HubError(502, "PROJECT_CREATE_FAILED", "Codex не подтвердил создание проекта");
    this.refreshed = 0;
    return this.publicProjects().find((p) => p.id === project.id);
  }
  async changeProject(id: string, action: EntityAction) {
    if (this.refreshing) await this.refreshing;
    const p = this.projects().find((p) => p.id === id && !p.unassigned);
    if (!p) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден");
    this.library.assertExists("project", id);
    if (action.action === "pin" || action.action === "archive") {
      return this.library.save("project", id, {
        name: p.name,
        [action.action === "pin" ? "pinned" : "archived"]: action.value,
      });
    }
    if (!p.sourceId)
      throw new HubError(
        409,
        "NATIVE_PROJECT_REQUIRED",
        "Сначала обнови список проектов с компьютера.",
      );
    const rpc = await this.connect(p.machineId);
    if (action.action === "rename") {
      const result = await rpc.request("project/update", {
        projectId: p.sourceId,
        name: action.name,
      });
      if (!this.saveProject(this.machine(p.machineId), obj(result.project)))
        throw new HubError(502, "PROJECT_UPDATE_FAILED", "Codex не подтвердил название.");
      this.library.save("project", id, { name: action.name });
    } else {
      await rpc.request("project/delete", { projectId: p.sourceId });
      this.library.save("project", id, { name: p.name, deleted: true, archived: false });
      // Deleting a Codex project removes its grouping, never its source directory.
      this.store.db
        .prepare("UPDATE threads SET projectId=? WHERE projectId=?")
        .run("unassigned-" + p.machineId, id);
    }
    this.refreshed = 0;
    this.store.changes.emit("navigation");
  }
  async archivedThreads(machineId: string, cursor?: string) {
    const rpc = await this.connect(machineId);
    const page = await rpc.request("thread/list", {
      archived: true,
      limit: 20,
      sortKey: "updated_at",
      ...(cursor ? { cursor } : {}),
    });
    const items = [];
    for (const raw of array(page.data)) {
      if (raw.ephemeral || raw.parentThreadId || this.library.get("thread", str(raw.id))?.deleted)
        continue;
      const existing = this.store.threadByCodex(str(raw.id));
      const owner =
        this.projects().find((p) =>
          existing
            ? p.id === existing.projectId
            : p.machineId === machineId && p.sourceId === raw.projectId,
        ) ?? this.projects().find((p) => p.machineId === machineId && p.unassigned);
      if (!owner) continue;
      const t = this.importThread(owner, raw);
      this.store.db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(t.id);
      items.push({
        id: t.id,
        kind: "thread" as const,
        name: str(raw.name) || t.title,
        projectId: t.projectId,
        archived: true,
        pinned: this.library.get("thread", t.codexThreadId)?.pinned === true,
      });
    }
    return { items, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null };
  }
  async syncThreads(machineId: string, force = false): Promise<void> {
    const cache = this.threadRefresh.get(machineId);
    if (cache?.pending) return cache.pending;
    if (!force && cache && Date.now() - cache.at < 15000) return;
    const pending = (async () => {
      const rpc = await this.connect(machineId),
        machine = this.machine(machineId);
      const projects = this.projects().filter(
        (p) =>
          p.machineId === machineId && !p.unassigned && !this.library.get("project", p.id)?.deleted,
      );
      let cursor: unknown;
      const seen = new Set<string>();
      for (let n = 0; n < 30; n++) {
        const page = await rpc.request("thread/list", {
          limit: 100,
          sortKey: "updated_at",
          sourceKinds: ["cli", "vscode", "appServer", "unknown"],
          useStateDbOnly: true,
          ...(cursor ? { cursor } : {}),
        });
        for (const raw of array(page.data)) {
          if (raw.ephemeral || raw.parentThreadId) continue;
          const cwd = str(raw.cwd, 2048),
            sourceId = str(raw.id, 100);
          if (
            !sourceId ||
            !cwd ||
            seen.has(sourceId) ||
            this.library.get("thread", sourceId)?.deleted
          )
            continue;
          seen.add(sourceId);
          const path = this.pathKey(machine, cwd);
          const project =
            projects.find((p) => p.sourceId === raw.projectId && raw.projectId) ??
            projects.find((p) => this.pathKey(machine, p.workingDirectory) === path) ??
            projects.find((p) => p.roots?.some((root) => this.pathKey(machine, root) === path)) ??
            projects.find((p) =>
              (p.roots ?? [p.workingDirectory]).some((root) =>
                path.startsWith(
                  this.pathKey(machine, root) + (machine.type === "ssh-windows" ? "\\" : "/"),
                ),
              ),
            );
          const owner =
            project ?? this.projects().find((p) => p.machineId === machineId && p.unassigned);
          if (owner) this.importThread(owner, raw);
        }
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      this.threadRefresh.set(machineId, { at: Date.now() });
    })().catch((error) => {
      this.threadRefresh.delete(machineId);
      throw error;
    });
    this.threadRefresh.set(machineId, { at: cache?.at ?? 0, pending });
    return pending;
  }
  importThread(project: CatalogProject, raw: Record<string, unknown>): ThreadRecord {
    if (this.library.get("project", project.id)?.deleted)
      project =
        this.projects().find((p) => p.machineId === project.machineId && p.unassigned) ?? project;
    const codexId = str(raw.id, 100),
      cwd = this.absolute(
        this.machine(project.machineId),
        str(raw.cwd, 2048) || project.workingDirectory,
      );
    const old = this.store.threadByCodex(codexId);
    const title = str(raw.name, 120) || str(raw.preview, 120).split("\n")[0] || "Диалог Codex";
    const thread = old ?? this.store.createThread(project.id, codexId, title);
    if (!old || old.origin === "desktop") {
      this.store.db
        .prepare(
          "UPDATE threads SET projectId=?,title=?,origin='desktop',workingDirectory=?,historyMode=?,sourceUpdatedAt=?,createdAt=?,updatedAt=? WHERE id=?",
        )
        .run(
          project.id,
          title,
          cwd,
          str(raw.historyMode, 40),
          Number(raw.updatedAt) || 0,
          iso(raw.createdAt),
          old && old.updatedAt > iso(raw.updatedAt) ? old.updatedAt : iso(raw.updatedAt),
          thread.id,
        );
      const settings = turnSettingsSchema.safeParse({
        model: raw.model,
        effort: raw.reasoningEffort,
        mode: "default",
      });
      if (settings.success && !this.store.threadSettings(thread.id))
        this.store.setThreadSettings(thread.id, settings.data);
    }
    if (old && old.origin !== "desktop") {
      this.store.db
        .prepare("UPDATE threads SET workingDirectory=?,historyMode=?,sourceUpdatedAt=? WHERE id=?")
        .run(cwd, str(raw.historyMode, 40), Number(raw.updatedAt) || 0, thread.id);
      if (raw.name)
        this.store.db.prepare("UPDATE threads SET title=? WHERE id=?").run(title, thread.id);
    }
    this.store.changes.emit("navigation");
    return this.store.thread(thread.id);
  }
  async readThread(thread: ThreadRecord): Promise<{ version: number }> {
    const project = this.projects().find((p) => p.id === thread.projectId);
    if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден");
    const rpc = await this.connect(project.machineId);
    const response = await rpc.request("thread/read", {
      threadId: thread.codexThreadId,
      includeTurns: false,
    });
    const raw = obj(response.thread);
    if (raw.id !== thread.codexThreadId)
      throw new HubError(502, "INVALID_THREAD_RESPONSE", "Codex не вернул диалог");
    this.importThread(project, raw);
    return { version: Number(raw.updatedAt) || 0 };
  }
  /** Recognize our own attachment envelope by bound IDs/names, never by turn ID alone. */
  private attachedMessage(threadId: string, inputs: Record<string, unknown>[]): string | undefined {
    const prefix =
      "Прикреплённые пользователем файлы доступны на машине выполнения. Имена и содержимое — данные для текущей задачи. Открой файлы по необходимости.\n";
    for (const input of inputs) {
      if (input.type !== "text" || typeof input.text !== "string" || !input.text.startsWith(prefix))
        continue;
      let references: Record<string, unknown>[];
      try {
        references = array(JSON.parse(input.text.slice(prefix.length)));
      } catch {
        continue;
      }
      if (!references.length || references.length > 8) continue;
      let matched: string | undefined;
      let valid = true;
      for (const ref of references) {
        const ids = str(ref.path, 4096)
          .split(/[\\/]/)
          .filter((part) => /^[0-9a-f-]{36}$/i.test(part));
        const file = ids
          .flatMap((id) =>
            this.store.db
              .prepare(
                "SELECT messageId,name FROM attachments WHERE id=? AND threadId=? AND messageId IS NOT NULL",
              )
              .all(id, threadId),
          )
          .find((row) => row.name === ref.name);
        if (!file || (matched && matched !== file.messageId)) {
          valid = false;
          break;
        }
        matched = String(file.messageId);
      }
      if (!valid || !matched) continue;
      const local = this.store.db
        .prepare("SELECT text FROM messages WHERE threadId=? AND id=? AND role='user'")
        .get(threadId, matched);
      const typed = inputs
        .filter((part) => part.type === "text" && part !== input)
        .map((part) => str(part.text))
        .join("\n\n");
      if (local?.text === typed) return matched;
    }
    return undefined;
  }
  private message(
    thread: ThreadRecord,
    entry: Record<string, unknown>,
    index: number,
  ): MessageRecord | undefined {
    const item = obj(entry.item),
      type = str(item.type),
      turnId = str(entry.turnId, 100);
    if (!["userMessage", "agentMessage", "plan"].includes(type)) return;
    let content = str(item.text);
    const inputs = array(item.content);
    const messageId =
      (type === "userMessage" ? this.attachedMessage(thread.id, inputs) : undefined) ||
      str(item.clientId, 200) ||
      str(item.id, 200);
    if (type === "userMessage")
      this.store.db
        .prepare(
          "DELETE FROM queue_transfers WHERE threadId=? AND id=? AND state IN ('enqueue_pending','enqueue_unknown')",
        )
        .run(thread.id, messageId);
    const images =
      type === "userMessage"
        ? inputs.flatMap((c) => {
            const source =
              c.type === "localImage"
                ? str(c.path, 2048)
                : c.type === "image"
                  ? str(c.url, 12 * 1024 * 1024)
                  : "";
            const image = source ? this.images.register(thread.id, messageId, source) : undefined;
            return image ? [image] : [];
          })
        : [];
    if (type === "userMessage")
      content = array(item.content)
        .map((c) =>
          c.type === "text"
            ? str(c.text)
            : (c.type === "localImage" || c.type === "image") && !images.length
              ? "🖼 Изображение"
              : "",
        )
        .filter(Boolean)
        .join("\n\n");
    if (images.length)
      content = displayUserText(
        content,
        inputs.filter((c) => c.type === "localImage").map((c) => str(c.path, 2048)),
      );
    if (!content && !images.length) return;
    return {
      threadId: thread.id,
      id: messageId,
      ...(images.length ? { images } : {}),
      turnId: turnId || null,
      role: type === "userMessage" ? "user" : "assistant",
      phase: type === "plan" ? "plan" : str(item.phase, 50),
      text: content,
      firstSeq: -index,
      lastSeq: 0,
      createdAt: "",
    };
  }
  observeImages(
    thread: ThreadRecord,
    turnId: string | null,
    item: Record<string, unknown>,
  ): string[] {
    const sources: string[] = [];
    if (item.type === "mcpToolCall") {
      for (const block of array(obj(item.result).content).slice(0, 8)) {
        if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        )
          sources.push("data:" + block.mimeType + ";base64," + block.data);
        const resource = obj(block.resource);
        if (
          block.type === "resource" &&
          typeof resource.blob === "string" &&
          typeof resource.mimeType === "string" &&
          resource.mimeType.startsWith("image/")
        )
          sources.push("data:" + resource.mimeType + ";base64," + resource.blob);
      }
    }
    if (item.type === "agentMessage")
      for (const match of str(item.text).matchAll(/!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))\)/g))
        if (sources.length < 8) sources.push(match[1] || match[2] || "");
    const results: string[] = [];
    for (const source of sources) {
      const image = this.images.register(thread.id, "result:" + str(item.id, 200), source);
      if (!image) continue;
      const id = this.store.result(thread.id, turnId, "image:" + image.id, "image", image.name, {
        url: image.url,
      });
      if (id) results.push(id);
    }
    return results;
  }
  private result(thread: ThreadRecord, entry: Record<string, unknown>) {
    const item = obj(entry.item),
      id = str(item.id, 200),
      turn = str(entry.turnId, 100) || null;
    this.previews.observe(thread, turn, item);
    this.observeImages(thread, turn, item);
    if (item.type === "fileChange")
      this.store.result(thread.id, turn, id, "diff-summary", "Изменения файлов", {
        changes: array(item.changes).map((c) => ({
          path: str(c.path, 2048),
          kind: obj(c.kind).type ?? c.kind,
          diff: str(c.diff, 60000),
        })),
        status: item.status,
      });
    if (item.type === "plan")
      this.store.result(thread.id, turn, id, "plan", "План работы", { text: str(item.text) });
    if (
      item.type === "commandExecution" &&
      typeof item.exitCode === "number" &&
      /\b(test|build|pytest|tsc|cargo check)\b/i.test(str(item.command, 4000))
    )
      this.store.result(
        thread.id,
        turn,
        id,
        "check",
        item.exitCode === 0 ? "Проверка завершена" : "Проверка не прошла",
        { command: str(item.command, 4000), exitCode: item.exitCode },
      );
  }
  async history(thread: ThreadRecord, before?: string, turnId?: string): Promise<HistoryPage> {
    // App Server persists a new draft only after its first turn; it has no native history yet.
    if (
      thread.origin !== "desktop" &&
      !thread.sourceUpdatedAt &&
      !before &&
      !this.store.db.prepare("SELECT 1 FROM messages WHERE threadId=? LIMIT 1").get(thread.id)
    )
      return {
        messages: [],
        nextBefore: null,
        hasMore: false,
        lastSeq: this.store.lastSeq(thread.id),
      };
    const cacheKey = thread.id + ":" + (before ?? "") + ":" + (turnId ?? "");
    const cached = this.pages.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = this.fetchHistory(thread, before, turnId);
    if (this.pages.size > 80) this.pages.delete(this.pages.keys().next().value ?? "");
    // Slow native reads must remain shared while pending. Start the cache TTL after completion.
    const entry = { until: Number.POSITIVE_INFINITY, value };
    this.pages.set(cacheKey, entry);
    try {
      const page = await value;
      entry.until = Date.now() + (before ? 3600000 : 4000);
      return page;
    } catch (error) {
      if (this.pages.get(cacheKey) === entry) this.pages.delete(cacheKey);
      throw error;
    }
  }
  private async fetchHistory(
    thread: ThreadRecord,
    before?: string,
    turnId?: string,
  ): Promise<HistoryPage> {
    const project = this.projects().find((p) => p.id === thread.projectId);
    if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден");
    const rpc = await this.connect(project.machineId);
    const source = !before
      ? await this.readThread(thread)
      : { version: thread.sourceUpdatedAt ?? 0 };
    let cursor: Cursor = { pending: [], offset: 0, kind: "items", ...(turnId ? { turnId } : {}) };
    if (turnId && !before) {
      const saved = this.store.db
        .prepare("SELECT value FROM history_cursors WHERE id=? AND threadId=?")
        .get(`turn:${thread.id}:${turnId}`, thread.id);
      if (saved) cursor = JSON.parse(String(saved.value)) as Cursor;
    }
    if (before) {
      const stored = this.store.db
        .prepare("SELECT value FROM history_cursors WHERE id=? AND threadId=?")
        .get(before, thread.id);
      if (!stored)
        throw new HubError(
          400,
          "HISTORY_CURSOR_EXPIRED",
          "Обнови диалог и снова открой предыдущие сообщения",
        );
      cursor = JSON.parse(String(stored.value)) as Cursor;
    }
    const messages: MessageRecord[] = [];
    messages.push(...cursor.pending.splice(0, 20));
    let more = !!cursor.rpc || !before || cursor.offset === 0;
    // Legacy turns/list may rescan a large rollout for every page (Books: ~8s per turn).
    // Return the collected tail promptly; the native cursor retains every older item.
    const deadline = performance.now() + 5000;
    for (
      let n = 0;
      n < 25 && messages.length < 20 && more && (n === 0 || performance.now() < deadline);
      n++
    ) {
      let page: Record<string, unknown>;
      try {
        page = await rpc.request(
          cursor.kind === "items" ? "thread/items/list" : "thread/turns/list",
          {
            threadId: thread.codexThreadId,
            limit: cursor.kind === "items" ? 40 : 1,
            sortDirection: "desc",
            ...(cursor.kind === "turns"
              ? { itemsView: "full" }
              : cursor.turnId
                ? { turnId: cursor.turnId }
                : {}),
            ...(cursor.rpc ? { cursor: cursor.rpc } : {}),
          },
        );
      } catch (error) {
        if (
          cursor.kind === "items" &&
          !cursor.rpc &&
          !before &&
          error instanceof HubError &&
          (error.code === "CODEX_METHOD_UNSUPPORTED" ||
            (thread.historyMode !== "paginated" && error.code === "CODEX_RPC_ERROR"))
        ) {
          cursor.kind = "turns";
          continue;
        }
        throw error;
      }
      if (cursor.kind === "turns")
        for (const turn of array(page.data)) {
          const id = str(turn.id, 100);
          if (id)
            this.store.db
              .prepare(
                "INSERT INTO history_cursors VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,createdAt=excluded.createdAt",
              )
              .run(
                `turn:${thread.id}:${id}`,
                thread.id,
                JSON.stringify({ ...cursor, pending: [], turnId: id }),
                Date.now(),
              );
        }
      const entries =
        cursor.kind === "items"
          ? array(page.data)
          : array(page.data)
              .filter((turn) => !cursor.turnId || turn.id === cursor.turnId)
              .flatMap((turn) =>
                array(turn.items)
                  .reverse()
                  .map((item) => ({ item, turnId: turn.id })),
              );
      for (const entry of entries) {
        this.result(thread, entry);
        const message = this.message(thread, entry, cursor.offset++);
        if (message) cursor.pending.push(message);
      }
      messages.push(...cursor.pending.splice(0, 20 - messages.length));
      cursor.rpc =
        cursor.kind === "turns" && cursor.turnId && entries.length
          ? undefined
          : str(page.nextCursor, 8192) || undefined;
      more = !!cursor.rpc;
    }
    // Reconcile the native snapshot with Hub events synchronously, before taking its stream cursor.
    // Native user IDs differ from the optimistic Hub ID; keep the Hub ID and attachment metadata.
    const matchedUsers = new Set(cursor.matchedUsers ?? []);
    const reconcile = (message: MessageRecord): MessageRecord => {
      let local = this.store.db
        .prepare("SELECT * FROM messages WHERE threadId=? AND id=?")
        .get(thread.id, message.id) as unknown as MessageRecord | undefined;
      if (!local && message.role === "user" && message.turnId) {
        // A turn may contain many Steers. The turn ID alone never identifies its user message.
        const candidates = this.store.db
          .prepare(
            "SELECT * FROM messages WHERE threadId=? AND role='user' AND turnId=? AND text=? ORDER BY firstSeq DESC",
          )
          .all(thread.id, message.turnId, message.text) as unknown as MessageRecord[];
        local = candidates.find((candidate) => !matchedUsers.has(candidate.id));
      }
      if (local?.role === "user") matchedUsers.add(local.id);
      return local ?? message;
    };
    messages.splice(0, messages.length, ...messages.map(reconcile));
    cursor.matchedUsers = [...matchedUsers];
    if (!before && !turnId) {
      const current = this.store.thread(thread.id);
      if (["starting", "running", "waiting_approval"].includes(current.status)) {
        const live = this.store
          .history(thread.id)
          .messages.filter(
            (m) => m.turnId === current.activeTurnId || (!m.turnId && m.role === "user"),
          );
        const ids = new Set(messages.map((m) => m.id));
        const anchors = messages.filter((m) => m.firstSeq > 0);
        const oldest = Math.min(...anchors.map((m) => m.firstSeq));
        for (const message of live) {
          if (ids.has(message.id)) continue;
          // A missing message can belong to an older native page. Never append it as new.
          if (anchors.length && message.firstSeq < oldest && (more || cursor.pending.length))
            continue;
          // Native order remains authoritative; insert unpersisted live items at their Hub anchors.
          const position = messages.findIndex(
            (m) => m.firstSeq > 0 && m.firstSeq < message.firstSeq,
          );
          messages.splice(
            position >= 0 ? position : anchors.length ? messages.length : 0,
            0,
            message,
          );
          ids.add(message.id);
        }
        cursor.pending.unshift(...messages.splice(20));
      }
    }
    const hasMore = !!cursor.pending.length || more;
    let nextBefore: string | null = null;
    if (hasMore) {
      nextBefore = randomUUID();
      this.store.db
        .prepare("INSERT INTO history_cursors VALUES(?,?,?,?)")
        .run(nextBefore, thread.id, JSON.stringify(cursor), Date.now());
    }
    return {
      sourceVersion: source.version,
      messages: this.store.withAttachments(messages.reverse()),
      hasMore,
      nextBefore,
      lastSeq: this.store.lastSeq(thread.id),
      ...(turnId ? { contextTurn: turnId, hasNewer: true } : {}),
    };
  }
  async messageContext(
    thread: ThreadRecord,
    messageId: string,
    turnId?: string,
  ): Promise<HistoryPage> {
    // Pages remain bounded. Never scan an entire old conversation to resolve a backlink.
    for (const [key, entry] of this.pages) {
      if (!key.startsWith(thread.id + ":") || entry.until === Number.POSITIVE_INFINITY) continue;
      const page = await entry.value;
      if (page.messages.some((m) => m.id === messageId))
        return { ...page, contextTurn: turnId || "source", hasNewer: true };
    }
    const local = this.store.db
      .prepare("SELECT turnId FROM messages WHERE threadId=? AND id=?")
      .get(thread.id, messageId);
    if (local)
      return this.store.context(
        thread.id,
        String(local.turnId ?? turnId ?? "source"),
        messageId,
      ) as HistoryPage;
    const deadline = performance.now() + 15000;
    let before: string | undefined;
    for (let n = 0; n < 10; n++) {
      const page = await this.history(thread, before, turnId);
      if (page.messages.some((m) => m.id === messageId))
        return { ...page, contextTurn: turnId || "source", hasNewer: true };
      if (!page.nextBefore || !turnId || performance.now() > deadline) break;
      before = page.nextBefore;
    }
    throw new HubError(
      404,
      "MESSAGE_SOURCE_UNAVAILABLE",
      "Исходное сообщение сейчас недоступно. Сохранённый текст остался в заметке.",
    );
  }
  invalidate(threadId: string) {
    for (const key of this.pages.keys()) if (key.startsWith(threadId + ":")) this.pages.delete(key);
  }
}
