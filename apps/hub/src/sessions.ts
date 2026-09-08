import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { CodexClient, type ServerRequest } from "@codex-web/codex";
import { spawnCodex } from "@codex-web/machines";
import {
  type Capabilities,
  type HubConfig,
  HubError,
  type HubEvent,
  type MachineConfig,
  type TurnSettings,
  turnSettingsSchema,
} from "@codex-web/shared";
import { accessCapabilities, requireAccess, threadAccess, turnAccess } from "./access.js";
import { Attachments } from "./attachments.js";
import { Catalog, type CatalogProject } from "./catalog.js";
import { ExternalActivity } from "./externalActivity.js";
import type { EntityAction, EntityKind } from "./library.js";
import type { Store, ThreadRecord } from "./store.js";
import { normalizeLimits } from "./usage.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, max = 200000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
interface Runtime {
  rpc: CodexClient;
  loaded: Set<string>;
  active: Set<string>;
  touched: number;
  codexHome?: string;
  version?: string;
  nativeModes?: boolean;
  capabilities?: Capabilities;
  capabilitiesAt?: number;
  capabilitiesProject?: string;
}
interface Approval {
  id: string;
  threadId: string;
  turnId: string | null;
  kind: "command" | "files" | "question" | "permissions";
  questions?: Record<string, unknown>[];
  permissions?: Record<string, unknown>;
  description: string;
  rpc: CodexClient;
  requestId: string | number;
}
export class Sessions extends EventEmitter {
  private runtimes = new Map<string, Promise<Runtime>>();
  private locks = new Set<string>();
  private approvals = new Map<string, Approval>();
  private summaries = new Map<string, { text: string; index: unknown; emittedAt: number }>();
  readonly attachments: Attachments;
  readonly catalog: Catalog;
  readonly externalActivity: ExternalActivity;
  private idleTimer: NodeJS.Timeout;
  constructor(
    readonly config: HubConfig,
    readonly store: Store,
    private clientFactory: (machine: MachineConfig, cwd: string) => CodexClient = (m, cwd) =>
      new CodexClient(spawnCodex(m, cwd)),
  ) {
    super();
    this.attachments = new Attachments(
      join(config.hub.resultsPath, "uploads"),
      store,
      config.hub.storage.attachmentBytes,
    );
    this.catalog = new Catalog(config, store, async (machineId) => {
      const seed =
        config.projects.find((p) => p.machineId === machineId && p.enabled) ??
        this.catalog.projects().find((p) => p.machineId === machineId);
      if (!seed)
        throw new HubError(
          503,
          "MACHINE_WORKSPACE_REQUIRED",
          "Для компьютера не настроена начальная папка",
        );
      const runtime = await this.runtime(seed.id);
      runtime.touched = Date.now();
      return runtime.rpc;
    });
    this.externalActivity = new ExternalActivity(
      config,
      store,
      this.catalog,
      async (machineId) => {
        const p = this.catalog.projects().find((p) => p.machineId === machineId);
        return p ? ((await this.runtime(p.id)).codexHome ?? "") : "";
      },
      (id) => this.owns(id),
      (event) => this.emit("event", event),
    );
    this.idleTimer = setInterval(() => void this.reap(), 60000);
    this.idleTimer.unref();
  }
  project(id: string): CatalogProject {
    const p = this.catalog.projects().find((p) => p.id === id && p.enabled);
    if (!p) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден");
    return p;
  }
  thread(id: string): ThreadRecord {
    const t = this.store.thread(id);
    this.project(t.projectId);
    return t;
  }
  pending(id: string): Record<string, unknown>[] {
    return [...this.approvals.values()]
      .filter((a) => a.threadId === id)
      .map(({ rpc: _rpc, requestId: _request, ...safe }) => safe);
  }
  private emitEvent(
    threadId: string,
    type: string,
    payload: Record<string, unknown>,
    turnId: string | null = null,
  ): HubEvent {
    const event = this.store.append(threadId, type, payload, turnId);
    this.emit("event", event);
    return event;
  }
  private async runtime(projectId: string): Promise<Runtime> {
    const p = this.project(projectId);
    const runtimeId = p.machineId;
    let existing = this.runtimes.get(runtimeId);
    if (existing) return existing;
    const machine = this.config.machines.find((m) => m.id === p.machineId);
    if (!machine) throw new HubError(503, "MACHINE_NOT_FOUND", "Машина не настроена");
    existing = (async () => {
      const anchor =
        this.config.projects.find((seed) => seed.machineId === machine.id && seed.enabled) ?? p;
      const rpc = this.clientFactory(machine, anchor.workingDirectory);
      const runtime: Runtime = { rpc, loaded: new Set(), active: new Set(), touched: Date.now() };
      rpc.on("notification", (method: string, params: Record<string, unknown>) =>
        this.notification(runtime, method, params),
      );
      rpc.on("request", (request: ServerRequest) => this.request(runtime, request));
      rpc.on("fault", (error: HubError) => {
        if (this.runtimes.get(runtimeId) === existing) this.runtimes.delete(runtimeId);
        for (const threadId of runtime.active) {
          this.store.setStatus(threadId, "unknown", this.store.thread(threadId).activeTurnId);
          this.emitEvent(threadId, "session.state", {
            status: "unknown",
            code: error.code,
            message: "Связь с Codex прервалась. Исход текущей работы нужно проверить.",
          });
        }
        for (const [id, a] of this.approvals) if (a.rpc === rpc) this.approvals.delete(id);
      });
      let account: Record<string, unknown>;
      try {
        const identity = await rpc.initialize();
        runtime.codexHome = text(identity.codexHome, 2048);
        runtime.version = text(identity.userAgent, 300).match(/\/(\d+\.\d+\.\d+)/)?.[1];
        account = await rpc.request("account/read", { refreshToken: false });
      } catch (error) {
        rpc.close();
        throw error;
      }
      if (account.requiresOpenaiAuth && !account.account) {
        rpc.close();
        throw new HubError(503, "CODEX_LOGIN_REQUIRED", "Выполни вход в Codex на выбранной машине");
      }
      return runtime;
    })();
    this.runtimes.set(runtimeId, existing);
    try {
      return await existing;
    } catch (error) {
      this.runtimes.delete(runtimeId);
      throw error;
    }
  }

  machineClient(machineId: string): "web" | "desktop" {
    const clients = record(this.store.preferences().machineClients);
    return clients[machineId] === "desktop" ? "desktop" : "web";
  }
  assertWritable(projectId: string): void {
    const machineId = this.project(projectId).machineId;
    if (this.catalog.library.get("project", projectId)?.deleted)
      throw new HubError(404, "PROJECT_DELETED", "Проект удалён.");
    if (
      this.handingOff.has(machineId) ||
      record(this.store.preferences().desktopReturns)[machineId]
    )
      throw new HubError(409, "HANDOFF_PENDING", "Передаём управление…");
    if (this.machineClient(machineId) === "desktop")
      throw new HubError(
        409,
        "MACHINE_RELEASED",
        "Компьютер освобождён для Codex. Верни управление сайту в настройках.",
      );
  }
  private machineWrites = new Map<string, number>();
  private handingOff = new Set<string>();

  async handoffToDesktop(machineId: string, confirmInterrupt = false): Promise<void> {
    if (!confirmInterrupt) return this.setMachineClient(machineId, "desktop");
    if (
      this.handingOff.has(machineId) ||
      record(this.store.preferences().desktopReturns)[machineId]
    )
      throw new HubError(409, "HANDOFF_PENDING", "Передача управления уже выполняется.");
    const projects = this.catalog.projects().filter((p) => p.machineId === machineId);
    if (this.machineWrites.get(machineId) || projects.some((p) => this.locks.has(p.id)))
      throw new HubError(409, "PROJECT_BUSY", "Дождись завершения отправки сообщения.");
    const threads = projects.flatMap((p) => this.store.threads(p.id));
    if (threads.some((t) => t.activitySource !== "external" && t.status === "unknown"))
      throw new HubError(
        409,
        "HANDOFF_STATE_UNKNOWN",
        "Сначала проверь состояние задач. Для зависшего Codex есть жёсткий перезапуск.",
      );
    this.handingOff.add(machineId);
    try {
      const existing = this.runtimes.get(machineId);
      const runtime = existing ? await existing : undefined;
      const active = threads.filter(
        (t) =>
          t.activitySource !== "external" &&
          ["running", "starting", "waiting_approval"].includes(t.status),
      );
      if (active.some((t) => !runtime?.loaded.has(t.id) || !t.activeTurnId))
        throw new HubError(
          409,
          "HANDOFF_STATE_UNKNOWN",
          "Не удалось подтвердить текущий ход. Проверь состояние задачи.",
        );
      await Promise.all(
        active.map(async (t) => {
          try {
            await this.interrupt(t.id);
          } catch (error) {
            if (this.store.thread(t.id).activeTurnId === t.activeTurnId) throw error;
          }
        }),
      );
      const deadline = Date.now() + 15000;
      while (runtime?.active.size) {
        if (Date.now() >= deadline)
          throw new HubError(
            409,
            "HANDOFF_STOP_PENDING",
            "Codex ещё останавливается. Повтори передачу после остановки.",
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await this.setMachineClient(machineId, "desktop");
    } finally {
      this.handingOff.delete(machineId);
    }
  }
  async withThreadWrite<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const thread = this.thread(id);
    if (thread.archived) throw new HubError(409, "THREAD_ARCHIVED", "Сначала разархивируй диалог.");
    const projectId = thread.projectId;
    if (this.entityWrites.has(projectId))
      throw new HubError(409, "ENTITY_BUSY", "Обновляем список диалогов.");
    this.assertWritable(projectId);
    const machineId = this.project(projectId).machineId;
    this.machineWrites.set(machineId, (this.machineWrites.get(machineId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      this.machineWrites.set(machineId, (this.machineWrites.get(machineId) ?? 1) - 1);
    }
  }
  async setMachineClient(
    machineId: string,
    client: "web" | "desktop",
    force = false,
  ): Promise<void> {
    if (!this.config.machines.some((m) => m.id === machineId))
      throw new HubError(404, "MACHINE_NOT_FOUND", "Компьютер не найден");
    const projects = this.catalog.projects().filter((p) => p.machineId === machineId);
    if (client === "desktop" && !force) {
      if (this.machineWrites.get(machineId) || projects.some((p) => this.locks.has(p.id)))
        throw new HubError(409, "PROJECT_BUSY", "Дождись завершения отправки сообщения.");
      if (
        projects.some((p) =>
          this.store
            .threads(p.id)
            .some(
              (t) =>
                t.activitySource !== "external" &&
                ["running", "starting", "waiting_approval", "unknown"].includes(t.status),
            ),
        )
      )
        throw new HubError(409, "DESKTOP_BUSY", "Сначала останови задачи, запущенные через сайт.");
    }
    this.store.setPreferences({
      machineClients: { ...record(this.store.preferences().machineClients), [machineId]: client },
    });
    if (client !== "desktop") return;
    const existing = this.runtimes.get(machineId);
    if (!existing) return;
    // Pause mutations before awaiting a launch already in flight. Read-only discovery may reconnect later.
    try {
      const runtime = await existing;
      runtime.rpc.close(); // Companion's job object terminates this App Server tree on pipe disconnect.
      if (this.runtimes.get(machineId) === existing) this.runtimes.delete(machineId);
    } catch {
      /* A failed launch owns no live writer. */
    }
  }

  async owns(id: string): Promise<boolean> {
    const t = this.thread(id),
      p = this.project(t.projectId),
      promise = this.runtimes.get(p.machineId);
    if (!promise) return false;
    try {
      return (await promise).loaded.has(id);
    } catch {
      return false;
    }
  }
  private entityWrites = new Set<string>();
  async manageEntity(kind: EntityKind, id: string, action: EntityAction) {
    const t = kind === "thread" ? this.thread(id) : undefined;
    const projectId = t?.projectId ?? id;
    if (this.machineWrites.get(this.project(projectId).machineId))
      throw new HubError(409, "ENTITY_BUSY", "Дождись завершения отправки сообщения.");
    return this.locked(projectId, async () => {
      this.entityWrites.add(projectId);
      try {
        const r = await this.runtime(projectId);
        const absent = new Set<string>(),
          nativeArchived = new Set<string>();
        if ((action.action === "archive" && action.value) || action.action === "delete") {
          const targets = t ? [t] : this.store.threads(projectId);
          for (const row of targets) {
            if (
              r.active.has(row.id) ||
              row.activeTurnId ||
              ["running", "starting", "waiting_approval", "unknown"].includes(row.status)
            )
              throw new HubError(409, "ENTITY_BUSY", "Дождись завершения работы в этом чате.");
            const emptyWeb =
              row.origin === "web" &&
              !this.store.db.prepare("SELECT 1 FROM messages WHERE threadId=? LIMIT 1").get(row.id);
            let missingRead = false;
            try {
              const result = await r.rpc.request("thread/read", {
                threadId: row.codexThreadId,
                includeTurns: false,
              });
              const status = record(record(result.thread).status);
              if (status.type === "active" || status.type === "systemError")
                throw new HubError(
                  409,
                  "ENTITY_BUSY",
                  "Диалог сейчас занят. Обнови его состояние.",
                );
            } catch (error) {
              if (
                emptyWeb &&
                error instanceof HubError &&
                ["THREAD_NOT_LOADED", "THREAD_NOT_PERSISTED"].includes(error.code)
              )
                missingRead = true;
              else throw error;
            }
            let queue: Record<string, any> = { data: [] };
            if (!row.archived || missingRead) {
              try {
                queue = await r.rpc.request("thread/queue/list", {
                  threadId: row.codexThreadId,
                  limit: 100,
                });
              } catch (error) {
                if (error instanceof HubError && error.code === "THREAD_ARCHIVED" && !missingRead)
                  nativeArchived.add(row.id);
                else if (
                  emptyWeb &&
                  error instanceof HubError &&
                  error.code === "THREAD_NOT_PERSISTED"
                )
                  absent.add(row.id);
                else throw error;
              }
            }
            if (missingRead && !absent.has(row.id))
              throw new HubError(409, "ENTITY_BUSY", "Не удалось подтвердить состояние диалога.");
            if (!Array.isArray(queue.data) || queue.data.length || queue.nextCursor)
              throw new HubError(
                409,
                "ENTITY_QUEUED",
                "Сначала обработай сообщения в очереди этого чата.",
              );
          }
        }
        if (!t) return await this.catalog.changeProject(id, action);
        const library = this.catalog.library;
        library.assertExists("thread", t.codexThreadId);
        if (action.action === "pin") {
          library.save("thread", t.codexThreadId, {
            name: t.title,
            localId: id,
            pinned: action.value,
          });
        } else if (action.action === "rename") {
          await r.rpc.request("thread/name/set", { threadId: t.codexThreadId, name: action.name });
          this.store.db.prepare("UPDATE threads SET title=? WHERE id=?").run(action.name, id);
        } else if (action.action === "archive") {
          let localArchive =
            absent.has(id) || library.get("thread", t.codexThreadId)?.localArchive === true;
          if (!localArchive && !(action.value && nativeArchived.has(id))) {
            try {
              await r.rpc.request(action.value ? "thread/archive" : "thread/unarchive", {
                threadId: t.codexThreadId,
              });
            } catch (error) {
              if (
                action.value &&
                error instanceof HubError &&
                error.code === "THREAD_NOT_PERSISTED" &&
                t.origin === "web" &&
                !this.store.db.prepare("SELECT 1 FROM messages WHERE threadId=? LIMIT 1").get(id)
              )
                localArchive = true;
              else throw error;
            }
          }
          this.store.db
            .prepare("UPDATE threads SET archived=? WHERE id=?")
            .run(Number(action.value), id);
          library.save("thread", t.codexThreadId, {
            name: t.title,
            localId: id,
            archived: action.value,
            localArchive: action.value && localArchive,
          });
          if (!localArchive) r.loaded.delete(id);
          this.catalog.invalidate(id);
        } else {
          if (!absent.has(id)) await r.rpc.request("thread/delete", { threadId: t.codexThreadId });
          library.save("thread", t.codexThreadId, { name: "", localId: id, deleted: true });
          r.loaded.delete(id);
          this.catalog.invalidate(id);
          const files = [
            ...this.store.db
              .prepare("SELECT id FROM artifacts WHERE threadId=?")
              .all(id)
              .map((row) => join(this.config.hub.resultsPath, String(row.id) + ".png")),
            ...this.store.db
              .prepare("SELECT id FROM attachments WHERE threadId=?")
              .all(id)
              .flatMap((row) =>
                [".bin", ".jpg"].map((ext) =>
                  join(this.config.hub.resultsPath, "uploads", String(row.id) + ext),
                ),
              ),
            ...this.store.db
              .prepare("SELECT id FROM html_previews WHERE threadId=?")
              .all(id)
              .map((row) =>
                join(this.config.hub.resultsPath, "previews", String(row.id) + ".html"),
              ),
          ];
          this.store.db.exec("BEGIN IMMEDIATE");
          try {
            for (const table of [
              "native_images",
              "artifacts",
              "attachments",
              "queue_transfers",
              "thread_settings",
              "messages",
              "events",
              "results",
              "history_cursors",
              "html_previews",
            ])
              this.store.db.prepare("DELETE FROM " + table + " WHERE threadId=?").run(id);
            this.store.db.prepare("DELETE FROM threads WHERE id=?").run(id);
            this.store.db.exec("COMMIT");
          } catch (error) {
            this.store.db.exec("ROLLBACK");
            throw error;
          }
          for (const path of files) {
            try {
              unlinkSync(path);
            } catch {
              /* Already absent or deferred to storage maintenance. */
            }
          }
        }
        this.store.changes.emit("navigation");
        return { ok: true };
      } finally {
        this.entityWrites.delete(projectId);
      }
    });
  }
  async queueClient(id: string): Promise<CodexClient> {
    const r = await this.runtime(this.thread(id).projectId);
    r.touched = Date.now();
    return r.rpc;
  }
  async status(
    projectId: string,
  ): Promise<{ available: boolean; code?: string; serverVersion?: string }> {
    try {
      const runtime = await this.runtime(projectId);
      runtime.touched = Date.now();
      const account = await runtime.rpc.request("account/read", { refreshToken: false });
      if (account.requiresOpenaiAuth && !account.account)
        throw new HubError(
          503,
          "CODEX_LOGIN_REQUIRED",
          "Выполни вход в Codex на машине выполнения",
        );
      return { available: true, serverVersion: runtime.version };
    } catch (error) {
      return {
        available: false,
        code: error instanceof HubError ? error.code : "CODEX_UNAVAILABLE",
      };
    }
  }

  async usage(machineId: string) {
    const project = this.catalog.projects().find((p) => p.machineId === machineId && p.enabled);
    if (!project) throw new HubError(404, "MACHINE_NOT_FOUND", "Компьютер не найден");
    const r = await this.runtime(project.id);
    try {
      return normalizeLimits(await r.rpc.request("account/rateLimits/read", {}));
    } catch {
      throw new HubError(503, "LIMITS_UNAVAILABLE", "Лимиты сейчас недоступны.");
    }
  }
  async capabilities(projectId: string): Promise<Capabilities> {
    const r = await this.runtime(projectId);
    r.touched = Date.now();
    if (
      r.capabilities &&
      r.capabilitiesProject === projectId &&
      Date.now() - (r.capabilitiesAt ?? 0) < 300000
    )
      return r.capabilities;
    const models: Capabilities["models"] = [];
    let cursor: unknown;
    for (let page = 0; page < 10; page++) {
      const result = await r.rpc.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      for (const raw of Array.isArray(result.data) ? result.data : []) {
        const m = record(raw);
        if (m.hidden === true) continue;
        const efforts = (
          Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []
        )
          .map((raw) => record(raw).reasoningEffort)
          .filter(
            (v): v is TurnSettings["effort"] =>
              turnSettingsSchema.shape.effort.safeParse(v).success,
          );
        const id = text(m.model, 200) || text(m.id, 200);
        if (id && efforts.length && !models.some((v) => v.id === id))
          models.push({
            id,
            name: text(m.displayName, 200) || id,
            description: text(m.description, 1000),
            efforts,
            defaultEffort: efforts.includes(m.defaultReasoningEffort as TurnSettings["effort"])
              ? (m.defaultReasoningEffort as TurnSettings["effort"])
              : (efforts[0] ?? "medium"),
            supportsImages: Array.isArray(m.inputModalities) && m.inputModalities.includes("image"),
          });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (!models.length)
      throw new HubError(503, "MODELS_UNAVAILABLE", "Codex не вернул доступные модели");
    const warnings: string[] = [];
    if (r.version !== "0.153.4")
      warnings.push(
        `Codex ${r.version ?? "неизвестной версии"}: эта версия ещё не прошла проверку совместимости.`,
      );
    const optional = async (method: string, params: Record<string, unknown>, label: string) => {
      try {
        return await r.rpc.request(method, params);
      } catch (error) {
        if (!(error instanceof HubError) || error.code !== "CODEX_METHOD_UNSUPPORTED") throw error;
        warnings.push(label + " недоступно в установленном Codex.");
        return {};
      }
    };
    const [presets, configuration] = await Promise.all([
      optional("collaborationMode/list", {}, "Планирование"),
      optional(
        "config/read",
        {
          includeLayers: false,
          cwd: this.project(projectId).workingDirectory,
        },
        "Чтение настроек модели",
      ),
    ]);
    r.nativeModes = Array.isArray(presets.data);
    const modes = (Array.isArray(presets.data) ? presets.data : [])
      .map((raw) => record(raw).mode)
      .filter((v): v is TurnSettings["mode"] => v === "default" || v === "plan");
    if (!modes.includes("default")) modes.unshift("default");
    const config = record(configuration.config),
      model = models.find((m) => m.id === config.model) ?? models[0];
    if (!model) throw new HubError(503, "MODELS_UNAVAILABLE", "Codex не вернул модели");
    const effort = model.efforts.includes(config.model_reasoning_effort as TurnSettings["effort"])
      ? (config.model_reasoning_effort as TurnSettings["effort"])
      : model.defaultEffort;
    const access = await accessCapabilities(r.rpc, this.project(projectId).workingDirectory);
    r.capabilities = {
      accessModes: access.modes,
      accessMessage: access.message,
      serverVersion: r.version,
      warnings,
      models,
      modes: [...new Set(modes)],
      defaults: { model: model.id, effort, mode: "default" },
    };
    r.capabilitiesProject = projectId;
    r.capabilitiesAt = Date.now();
    return r.capabilities;
  }
  private async validateSettings(
    projectId: string,
    value: TurnSettings,
  ): Promise<Capabilities["models"][number]> {
    const caps = await this.capabilities(projectId),
      model = caps.models.find((m) => m.id === value.model);
    if (!model)
      throw new HubError(400, "MODEL_UNAVAILABLE", "Эта модель недоступна. Обнови список моделей");
    if (!model.efforts.includes(value.effort))
      throw new HubError(
        400,
        "EFFORT_UNAVAILABLE",
        "Этот уровень размышления не поддерживается выбранной моделью",
      );
    if (!caps.modes.includes(value.mode))
      throw new HubError(
        400,
        "MODE_UNAVAILABLE",
        "Этот режим не поддерживается установленным Codex",
      );
    await requireAccess(
      (await this.runtime(projectId)).rpc,
      this.project(projectId).workingDirectory,
      value.access,
    );
    return model;
  }
  async setSettings(id: string, value: TurnSettings): Promise<TurnSettings> {
    const thread = this.thread(id);
    const changingAccess =
      (this.store.threadSettings(id)?.access ?? "workspace") !== (value.access ?? "workspace");
    if (changingAccess && !(await this.owns(id))) {
      await this.externalActivity.refresh();
      const latest = this.thread(id);
      if (
        latest.activitySource === "external" &&
        ["running", "starting", "waiting_approval"].includes(latest.status)
      )
        throw new HubError(
          409,
          "THREAD_IN_USE",
          "Сменить доступ можно после завершения задачи в другом клиенте.",
        );
    }
    return this.locked(thread.projectId, async () => {
      await this.validateSettings(thread.projectId, value);
      const r = await this.runtime(thread.projectId);
      if (changingAccess && r.loaded.has(id))
        await r.rpc.request("thread/settings/update", {
          threadId: thread.codexThreadId,
          ...turnAccess(value.access),
        });
      this.store.setThreadSettings(id, value);
      this.emitEvent(id, "thread.settings", { settings: value });
      return value;
    });
  }

  private async locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    this.assertWritable(projectId);
    if (this.locks.has(projectId))
      throw new HubError(409, "PROJECT_BUSY", "Другая команда для проекта ещё обрабатывается");
    this.locks.add(projectId);
    try {
      return await fn();
    } finally {
      this.locks.delete(projectId);
    }
  }
  async create(projectId: string, title: string): Promise<ThreadRecord> {
    this.project(projectId);
    return this.locked(projectId, async () => {
      const r = await this.runtime(projectId);
      const result = await r.rpc.request("thread/start", {
        cwd: this.project(projectId).workingDirectory,
        ...(this.project(projectId).sourceId
          ? { projectId: this.project(projectId).sourceId }
          : {}),
        historyMode: "paginated",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      const codexId = text(record(result.thread).id);
      if (!codexId)
        throw new HubError(502, "INVALID_THREAD_RESPONSE", "Codex не вернул идентификатор диалога");
      const t = this.store.createThread(projectId, codexId, title);
      if (record(result.thread).historyMode)
        this.store.db
          .prepare("UPDATE threads SET historyMode=?,workingDirectory=? WHERE id=?")
          .run(
            text(record(result.thread).historyMode, 40),
            this.project(projectId).workingDirectory,
            t.id,
          );
      r.loaded.add(t.id);
      r.touched = Date.now();
      if (title !== "Новый диалог")
        await r.rpc.request("thread/name/set", { threadId: codexId, name: title }).catch(() => {});
      this.emitEvent(t.id, "thread.created", { title: t.title });
      return t;
    });
  }
  async fork(id: string, attachmentIds: string[] = []): Promise<ThreadRecord> {
    const original = this.thread(id);
    this.attachments.validateCopy(id, attachmentIds);
    return this.locked(original.projectId, async () => {
      const r = await this.runtime(original.projectId);
      const page = await r.rpc.request("thread/turns/list", {
        threadId: original.codexThreadId,
        limit: 2,
        itemsView: "summary",
        sortDirection: "desc",
      });
      const completed = (Array.isArray(page.data) ? page.data.map(record) : []).find((turn) =>
        ["completed", "interrupted", "failed"].includes(text(turn.status)),
      );
      if (!completed?.id)
        throw new HubError(
          409,
          "NO_COMPLETED_HISTORY",
          "Сначала дождись завершения первого ответа в исходном диалоге.",
        );
      const response = await r.rpc.request("thread/fork", {
        threadId: original.codexThreadId,
        lastTurnId: completed.id,
        excludeTurns: true,
        deferGoalContinuation: true,
        cwd: original.workingDirectory || this.project(original.projectId).workingDirectory,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      const raw = record(response.thread),
        codexId = text(raw.id);
      if (!codexId || codexId === original.codexThreadId)
        throw new HubError(502, "INVALID_THREAD_RESPONSE", "Codex не подтвердил создание копии");
      const created = this.store.createThread(
        original.projectId,
        codexId,
        original.title.slice(0, 100) + " · копия",
      );
      this.store.db
        .prepare("UPDATE threads SET workingDirectory=?,historyMode=?,sourceUpdatedAt=? WHERE id=?")
        .run(
          original.workingDirectory || this.project(original.projectId).workingDirectory,
          text(raw.historyMode) || original.historyMode || "paginated",
          Number(raw.updatedAt) || Date.now() / 1000,
          created.id,
        );
      try {
        await this.attachments.copyPending(id, created.id, attachmentIds);
      } catch (error) {
        await r.rpc.request("thread/archive", { threadId: codexId }).catch(() => {});
        this.store.db.prepare("DELETE FROM threads WHERE id=?").run(created.id);
        throw error;
      }
      if (original.settings)
        this.store.setThreadSettings(created.id, { ...original.settings, access: "workspace" });
      r.loaded.add(created.id);
      r.touched = Date.now();
      await r.rpc
        .request("thread/name/set", { threadId: codexId, name: created.title })
        .catch(() => {});
      this.emitEvent(created.id, "thread.created", {
        title: created.title,
        copiedFrom: original.id,
      });
      return this.store.thread(created.id);
    });
  }
  async resume(id: string): Promise<ThreadRecord> {
    const t = this.thread(id);
    if (t.archived) throw new HubError(409, "THREAD_ARCHIVED", "Сначала разархивируй диалог.");
    return this.locked(t.projectId, async () => {
      const r = await this.runtime(t.projectId);
      if (r.loaded.has(id)) return this.store.thread(id);
      await requireAccess(r.rpc, this.project(t.projectId).workingDirectory, t.settings?.access);
      let result: Record<string, unknown>;
      try {
        result = await r.rpc.request("thread/resume", {
          threadId: t.codexThreadId,
          cwd: t.workingDirectory || this.project(t.projectId).workingDirectory,
          excludeTurns: true,
          ...threadAccess(t.settings?.access),
        });
      } catch (error) {
        const empty =
          t.origin === "web" &&
          !this.store.db.prepare("SELECT 1 FROM messages WHERE threadId=? LIMIT 1").get(id) &&
          !this.store.db.prepare("SELECT 1 FROM queue_transfers WHERE threadId=? LIMIT 1").get(id);
        if (!(error instanceof HubError && error.code === "THREAD_NOT_PERSISTED" && empty))
          throw error;
        // No native conversation history existed yet. Recreate only the empty placeholder.
        const project = this.project(t.projectId);
        result = await r.rpc.request("thread/start", {
          cwd: t.workingDirectory || project.workingDirectory,
          ...(project.sourceId ? { projectId: project.sourceId } : {}),
          historyMode: "paginated",
          ...threadAccess(t.settings?.access),
        });
        const nativeId = text(record(result.thread).id);
        if (!nativeId)
          throw new HubError(502, "INVALID_CODEX_RESPONSE", "Codex не подтвердил пустой диалог.");
        const previousId = t.codexThreadId,
          meta = this.catalog.library.get("thread", previousId);
        this.store.db.prepare("UPDATE threads SET codexThreadId=? WHERE id=?").run(nativeId, id);
        t.codexThreadId = nativeId;
        if (meta) {
          this.catalog.library.save("thread", nativeId, { ...meta, id: nativeId, localId: id });
          this.store.db
            .prepare("DELETE FROM library_entities WHERE client='codex' AND kind='thread' AND id=?")
            .run(previousId);
        }
        await r.rpc.request("thread/name/set", { threadId: nativeId, name: t.title });
        result = { ...result, thread: { ...record(result.thread), turns: [] } };
      }
      const turns =
        record(result.thread).turns ??
        (
          await r.rpc.request("thread/turns/list", {
            threadId: t.codexThreadId,
            limit: 1,
            itemsView: "summary",
            sortDirection: "desc",
          })
        ).data;
      const last = Array.isArray(turns) ? record(turns.at(-1)) : {};
      const status = text(last.status);
      if (t.status === "unknown" && last.id) {
        const latestUser = this.store.history(id).messages.findLast((m) => m.role === "user");
        const items = Array.isArray(last.items) ? last.items.map(record) : [];
        const codexUser = items.find((item) => item.type === "userMessage");
        const firstText = Array.isArray(codexUser?.content)
          ? record(codexUser.content.find((v) => record(v).type === "text")).text
          : undefined;
        const matches = t.activeTurnId === last.id || (latestUser && latestUser.text === firstText);
        if (matches) {
          if (latestUser && !latestUser.turnId)
            this.emitEvent(id, "turn.started", { id: last.id }, text(last.id));
          for (const item of items)
            if (item.type === "agentMessage" || item.type === "plan") {
              const existing = this.store.db
                .prepare("SELECT text,phase FROM messages WHERE threadId=? AND id=?")
                .get(id, text(item.id));
              const phase = item.type === "plan" ? "plan" : text(item.phase);
              if (existing?.text !== text(item.text) || existing?.phase !== phase)
                this.emitEvent(
                  id,
                  "assistant.completed",
                  { id: text(item.id), text: text(item.text), phase },
                  text(last.id),
                );
            }
        }
      }
      if (status === "inProgress") {
        r.active.add(id);
        this.store.setStatus(id, "running", text(last.id) || null);
      } else if (t.status === "unknown") {
        // Resume restores conversation history; it is not proof that an unacknowledged command ran.
        this.store.setStatus(id, "idle");
        this.emitEvent(id, "session.state", {
          status: "idle",
          message:
            "Связь восстановлена. Неподтверждённая команда не отправлялась повторно; проверь последний результат.",
        });
      }
      r.loaded.add(id);
      this.store.db.prepare("UPDATE threads SET activitySource='hub' WHERE id=?").run(id);
      r.touched = Date.now();
      return this.store.thread(id);
    });
  }
  async startTurn(
    id: string,
    prompt: string,
    settings?: TurnSettings,
    attachmentIds: string[] = [],
  ): Promise<Record<string, unknown>> {
    let t = this.thread(id);
    if (!(await this.owns(id))) await this.externalActivity.refresh();
    t = this.thread(id);
    if (t.activitySource === "external" && ["running", "waiting_approval"].includes(t.status))
      throw new HubError(
        409,
        "THREAD_IN_USE",
        "Codex работает в другом клиенте. Можно добавить сообщение в очередь; оно продолжит работу после текущего ответа.",
      );
    return this.locked(t.projectId, async () => {
      const r = await this.runtime(t.projectId);
      if (
        [...r.active].some((activeId) => this.store.thread(activeId).projectId === t.projectId) ||
        ["unknown", "starting", "running", "waiting_approval"].includes(
          this.store.thread(id).status,
        )
      )
        throw new HubError(
          409,
          "PROJECT_BUSY",
          "Сначала дождись завершения работы или восстанови диалог",
        );
      const selection =
        settings ??
        this.store.threadSettings(id) ??
        (await this.capabilities(t.projectId)).defaults;
      const model = await this.validateSettings(t.projectId, selection);
      // The Hub is the primary writer. Keep its loaded conversation between turns;
      // releasing and reacquiring it here lets another App Server steal the writer.
      if (
        !r.loaded.has(id) &&
        t.origin !== "desktop" &&
        !t.sourceUpdatedAt &&
        !this.store.db.prepare("SELECT 1 FROM messages WHERE threadId=? LIMIT 1").get(id)
      ) {
        // An unsent draft may disappear with its App Server. Recreate only that empty draft.
        const fresh = await r.rpc.request("thread/start", {
          cwd: t.workingDirectory || this.project(t.projectId).workingDirectory,
          ...(this.project(t.projectId).sourceId
            ? { projectId: this.project(t.projectId).sourceId }
            : {}),
          historyMode: "paginated",
          ...threadAccess(selection.access),
        });
        const sourceId = text(record(fresh.thread).id);
        if (!sourceId) throw new HubError(502, "INVALID_THREAD_RESPONSE", "Codex не создал диалог");
        this.store.db.prepare("UPDATE threads SET codexThreadId=? WHERE id=?").run(sourceId, id);
        t.codexThreadId = sourceId;
        r.loaded.add(id);
      }
      if (!r.loaded.has(id)) {
        await r.rpc.request("thread/resume", {
          threadId: t.codexThreadId,
          cwd: t.workingDirectory || this.project(t.projectId).workingDirectory,
          excludeTurns: true,
          ...threadAccess(selection.access),
        });
        r.loaded.add(id);
      }
      const prepared = await this.attachments.prepare(
        { ...this.config, projects: this.catalog.projects() },
        id,
        attachmentIds,
        model.supportsImages,
      );
      try {
        this.assertWritable(t.projectId);
      } catch (error) {
        prepared.release();
        throw error;
      }
      this.catalog.invalidate(id);
      const messageId = randomUUID();
      try {
        this.attachments.bind(id, messageId, prepared.files);
      } catch (error) {
        prepared.release();
        throw error;
      }
      this.store.setThreadSettings(id, selection);
      this.emitEvent(id, "thread.settings", { settings: selection });
      r.active.add(id);
      r.touched = Date.now();
      this.store.db.prepare("UPDATE threads SET activitySource='hub' WHERE id=?").run(id);
      this.store.setStatus(id, "starting");
      this.emitEvent(id, "session.state", { status: "starting" });
      this.emitEvent(id, "user.message", {
        id: messageId,
        text: prompt,
        attachments: prepared.files.map((file) => ({ ...file, messageId })),
        settings: selection,
      });
      if (t.title === "Новый диалог")
        this.store.db
          .prepare("UPDATE threads SET title=? WHERE id=?")
          .run(
            (prompt.trim() || prepared.files[0]?.name || "Вложения")
              .replace(/\s+/g, " ")
              .slice(0, 60),
            id,
          );
      try {
        const response = await r.rpc.request("turn/start", {
          threadId: t.codexThreadId,
          input: [...(prompt ? [{ type: "text", text: prompt }] : []), ...prepared.input],
          clientUserMessageId: messageId,
          ...turnAccess(selection.access),
          model: selection.model,
          effort: selection.effort,
          ...(r.nativeModes
            ? {
                collaborationMode: {
                  mode: selection.mode,
                  settings: {
                    model: selection.model,
                    reasoning_effort: selection.effort,
                    developer_instructions: null,
                  },
                },
              }
            : {}),
        });
        const turnId = text(record(response.turn).id);
        if (!turnId)
          throw new HubError(
            502,
            "INVALID_TURN_RESPONSE",
            "Codex не подтвердил идентификатор хода",
          );
        if (this.store.thread(id).status === "starting")
          this.store.setStatus(id, "running", turnId);
        return { turnId, status: this.store.thread(id).status };
      } catch (error) {
        this.store.setStatus(id, "unknown");
        this.emitEvent(id, "session.state", {
          status: "unknown",
          message: "Codex не подтвердил запуск. Проверь диалог перед повтором.",
        });
        throw error;
      } finally {
        prepared.release();
      }
    });
  }
  async interrupt(id: string): Promise<Record<string, unknown>> {
    const t = this.thread(id);
    const r = await this.runtime(t.projectId);
    if (!t.activeTurnId)
      throw new HubError(409, "NO_ACTIVE_TURN", "Нет подтверждённого активного хода");
    await r.rpc.request("turn/interrupt", { threadId: t.codexThreadId, turnId: t.activeTurnId });
    return { requested: true }; // Completion is established by turn/completed.
  }
  async approve(id: string, decision: "accept" | "decline"): Promise<Record<string, unknown>> {
    const a = this.approvals.get(id);
    if (!a || a.rpc.closed)
      throw new HubError(409, "APPROVAL_EXPIRED", "Запрос подтверждения уже недействителен");
    this.thread(a.threadId);
    if (a.kind === "question") throw new HubError(400, "ANSWER_REQUIRED", "Нужен ответ на вопрос");
    this.approvals.delete(id);
    this.store.setStatus(a.threadId, "running", a.turnId);
    this.emitEvent(a.threadId, "approval.resolved", { id, decision }, a.turnId);
    a.rpc.respond(
      a.requestId,
      a.kind === "permissions"
        ? { permissions: decision === "accept" ? (a.permissions ?? {}) : {}, scope: "turn" }
        : { decision },
    );
    return { resolved: true };
  }
  async answer(id: string, answers: Record<string, string[]>): Promise<Record<string, unknown>> {
    const a = this.approvals.get(id);
    if (!a || a.rpc.closed || a.kind !== "question")
      throw new HubError(409, "APPROVAL_EXPIRED", "Вопрос больше не актуален");
    const formatted: Record<string, unknown> = {};
    for (const question of a.questions ?? []) {
      const key = String(question.id),
        values = answers[key];
      if (!values?.length) throw new HubError(400, "ANSWER_REQUIRED", "Ответь на каждый вопрос");
      formatted[key] = { answers: values };
    }
    this.approvals.delete(id);
    this.store.setStatus(a.threadId, "running", a.turnId);
    this.emitEvent(a.threadId, "approval.resolved", { id, decision: "answered" }, a.turnId);
    a.rpc.respond(a.requestId, { answers: formatted });
    return { resolved: true };
  }
  private request(r: Runtime, request: ServerRequest): void {
    const t = this.store.threadByCodex(text(request.params.threadId));
    const supported = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
      "item/permissions/requestApproval",
    ];
    if (!t || !supported.includes(request.method)) {
      r.rpc.rejectRequest(request.id);
      if (t)
        this.emitEvent(t.id, "error", {
          code: "UNSUPPORTED_REQUEST",
          message: "Codex запросил действие, которое этот клиент пока не поддерживает.",
        });
      return;
    }
    const a: Approval = {
      id: randomUUID(),
      threadId: t.id,
      turnId: text(request.params.turnId) || t.activeTurnId,
      kind: request.method.includes("commandExecution")
        ? "command"
        : request.method.includes("requestUserInput")
          ? "question"
          : request.method.includes("permissions")
            ? "permissions"
            : "files",
      permissions: request.method.includes("permissions")
        ? record(request.params.permissions)
        : undefined,
      questions: Array.isArray(request.params.questions)
        ? request.params.questions.map((value) => {
            const q = record(value);
            return {
              id: text(q.id, 200),
              header: text(q.header, 200),
              question: text(q.question, 8000),
              isSecret: q.isSecret === true,
              options: Array.isArray(q.options)
                ? q.options.map((value) => {
                    const o = record(value);
                    return { label: text(o.label, 1000), description: text(o.description, 2000) };
                  })
                : [],
            };
          })
        : undefined,
      description:
        text(request.params.command, 4000) ||
        text(request.params.reason, 4000) ||
        "Изменение файлов проекта",
      rpc: r.rpc,
      requestId: request.id,
    };
    this.approvals.set(a.id, a);
    this.store.setStatus(t.id, "waiting_approval", a.turnId);
    this.emitEvent(
      t.id,
      "approval.requested",
      {
        id: a.id,
        kind: a.kind,
        description: a.description,
        questions: a.questions ?? [],
        permissions: a.permissions,
      },
      a.turnId,
    );
  }
  private notification(r: Runtime, method: string, p: Record<string, unknown>): void {
    const t = this.store.threadByCodex(text(p.threadId));
    if (!t) return;
    r.touched = Date.now();
    const turnId = text(p.turnId) || t.activeTurnId;
    if (method === "item/reasoning/summaryTextDelta") {
      // Only the native public summary stream is used. Never expose raw reasoning text/content.
      const itemId = text(p.itemId, 200),
        key = t.id + ":" + itemId;
      if (!itemId) return;
      const value = this.summaries.get(key) ?? { text: "", index: p.summaryIndex, emittedAt: 0 };
      value.text = (
        value.text +
        (value.index !== p.summaryIndex ? "\n\n" : "") +
        text(p.delta, 8000)
      ).slice(0, 8000);
      value.index = p.summaryIndex;
      this.summaries.set(key, value);
      if (this.summaries.size > 32) this.summaries.delete(this.summaries.keys().next().value!);
      if (Date.now() - value.emittedAt >= 500) {
        value.emittedAt = Date.now();
        this.emitEvent(t.id, "activity.summary", { itemId, text: value.text }, turnId);
      }
    } else if (method === "thread/settings/updated" && r.loaded.has(t.id)) {
      const settings = this.store.threadSettings(t.id),
        native = record(p.threadSettings),
        sandbox = record(native.sandboxPolicy);
      const access =
        sandbox.type === "dangerFullAccess" && native.approvalPolicy === "never"
          ? "full"
          : sandbox.type === "workspaceWrite" && native.approvalPolicy === "on-request"
            ? "workspace"
            : undefined;
      if (settings && access && (settings.access ?? "workspace") !== access) {
        this.store.setThreadSettings(t.id, { ...settings, access });
        this.emitEvent(t.id, "thread.settings", { settings: { ...settings, access } });
      }
    } else if (method === "serverRequest/resolved") {
      for (const [key, a] of this.approvals)
        if (a.rpc === r.rpc && a.requestId === p.requestId) {
          this.approvals.delete(key);
          this.emitEvent(t.id, "approval.resolved", { id: key, decision: "resolved" }, turnId);
        }
    } else if (method === "turn/started") {
      const id = text(record(p.turn).id);
      r.active.add(t.id);
      this.store.db.prepare("UPDATE threads SET activitySource='hub' WHERE id=?").run(t.id);
      this.store.setStatus(t.id, "running", id);
      this.emitEvent(t.id, "turn.started", { id }, id);
    } else if (method === "turn/completed") {
      const turn = record(p.turn),
        id = text(turn.id),
        status = text(turn.status);
      r.active.delete(t.id);
      for (const key of this.summaries.keys())
        if (key.startsWith(t.id + ":")) this.summaries.delete(key);
      this.catalog.invalidate(t.id);
      for (const [key, a] of this.approvals) if (a.threadId === t.id) this.approvals.delete(key);
      this.store.setStatus(
        t.id,
        ["completed", "interrupted", "failed"].includes(status) ? status : "unknown",
      );
      this.emitEvent(
        t.id,
        "turn.completed",
        { id, status, error: turn.error ? text(record(turn.error).message, 2000) : null },
        id,
      );
    } else if (method === "thread/queue/changed") {
      this.emitEvent(t.id, "queue.changed", {});
    } else if (
      (method === "item/started" || method === "item/completed") &&
      record(p.item).type === "userMessage"
    ) {
      const item = record(p.item),
        content = Array.isArray(item.content) ? item.content.map(record) : [];
      const messageId = text(item.clientId) || text(item.id);
      this.store.db
        .prepare(
          "DELETE FROM queue_transfers WHERE threadId=? AND ((id=? AND state IN ('enqueue_pending','enqueue_unknown')) OR (state IN ('pending','steered','unknown') AND json_extract(value, '$.clientUserMessageId')=?))",
        )
        .run(t.id, messageId, messageId);
      this.emitEvent(t.id, "queue.changed", {});
      const value = content
        .filter((c) => c.type === "text")
        .map((c) => text(c.text))
        .join("\n\n");
      // Normal sends already have an optimistic user event. Queued/steered messages arrive here.
      const existing = this.store.db
        .prepare(
          "SELECT id FROM messages WHERE threadId=? AND (id=? OR (turnId=? AND role='user' AND text=?)) LIMIT 1",
        )
        .get(t.id, messageId, turnId, value);
      if (!existing) {
        const files = this.store.db
          .prepare("SELECT * FROM attachments WHERE threadId=? AND messageId=?")
          .all(t.id, messageId)
          .map((v) => this.store.attachmentPublic(v));
        this.emitEvent(
          t.id,
          "user.message",
          {
            id: messageId,
            text: files.length ? text(content[0]?.text) : value,
            attachments: files,
          },
          turnId,
        );
      }
    } else if (method === "item/started") {
      const kind = text(record(p.item).type);
      const labels: Record<string, string> = {
        reasoning: "Обдумывает задачу",
        commandExecution: "Выполняет команду",
        fileChange: "Изменяет файлы",
        webSearch: "Ищет информацию",
        mcpToolCall: "Работает с инструментом",
        dynamicToolCall: "Работает с инструментом",
        agentMessage: "Пишет ответ",
        plan: "Составляет план",
      };
      this.emitEvent(
        t.id,
        "turn.progress",
        {
          label: labels[kind] ?? "Работает над задачей",
          itemId: text(record(p.item).id, 200),
          ...(kind === "commandExecution" ? { command: text(record(p.item).command, 4000) } : {}),
          ...(kind === "mcpToolCall"
            ? {
                detail: [text(record(p.item).server, 200), text(record(p.item).tool, 200)]
                  .filter(Boolean)
                  .join(" · "),
              }
            : {}),
        },
        turnId,
      );
    } else if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      this.emitEvent(
        t.id,
        "assistant.delta",
        {
          id: text(p.itemId),
          text: text(p.delta),
          ...(method === "item/plan/delta" ? { phase: "plan" } : {}),
        },
        turnId,
      );
    } else if (method === "item/completed") {
      const item = record(p.item),
        id = text(item.id),
        type = text(item.type);
      for (const imageId of this.catalog.observeImages(t, turnId, item))
        this.emitEvent(t.id, "result.created", { id: imageId, type: "image" }, turnId);
      for (const previewId of this.catalog.previews.observe(t, turnId, item))
        this.emitEvent(t.id, "result.created", { id: previewId, type: "preview" }, turnId);
      if (type === "reasoning") {
        const summary = Array.isArray(item.summary)
          ? item.summary
              .filter((v) => typeof v === "string")
              .join("\n\n")
              .slice(0, 8000)
          : "";
        if (summary)
          this.emitEvent(t.id, "activity.summary", { itemId: id, text: summary }, turnId);
        this.summaries.delete(t.id + ":" + id);
      } else if (type === "agentMessage" || type === "plan") {
        this.emitEvent(
          t.id,
          "assistant.completed",
          { id, text: text(item.text), phase: type === "plan" ? "plan" : text(item.phase) },
          turnId,
        );
        if (type === "plan") {
          const resultId = this.store.result(t.id, turnId, id, "plan", "План работы", {
            text: text(item.text),
          });
          if (resultId)
            this.emitEvent(t.id, "result.created", { id: resultId, type: "plan" }, turnId);
        }
      } else if (type === "commandExecution") {
        const command = text(item.command, 4000);
        this.emitEvent(
          t.id,
          "activity.command",
          {
            itemId: id,
            id,
            command,
            status: text(item.status),
            exitCode: item.exitCode,
            output: text(item.aggregatedOutput, 64000),
          },
          turnId,
        );
        if (
          typeof item.exitCode === "number" &&
          /\b(test|build|pytest|tsc|cargo check)\b/i.test(command)
        ) {
          const resultId = this.store.result(
            t.id,
            turnId,
            id,
            "check",
            item.exitCode === 0 ? "Проверка завершена" : "Проверка не прошла",
            { command, exitCode: item.exitCode, classification: "command-pattern" },
          );
          if (resultId)
            this.emitEvent(t.id, "result.created", { id: resultId, type: "check" }, turnId);
        }
      } else if (type === "fileChange") {
        const changes = Array.isArray(item.changes)
          ? item.changes.map((v) => {
              const c = record(v);
              return {
                path: text(c.path, 2048),
                kind: record(c.kind).type ?? c.kind,
                diff: text(c.diff, 100000),
              };
            })
          : [];
        const resultId = this.store.result(t.id, turnId, id, "diff-summary", "Изменения файлов", {
          changes,
          status: text(item.status),
        });
        if (resultId)
          this.emitEvent(t.id, "result.created", { id: resultId, type: "diff-summary" }, turnId);
      } else if (type === "mcpToolCall") {
        this.emitEvent(
          t.id,
          "activity.tool",
          { id, tool: text(item.tool, 200), status: text(item.status) },
          turnId,
        );
      }
    } else if (method === "model/rerouted") {
      this.emitEvent(
        t.id,
        "session.notice",
        {
          message: `Codex переключил модель на ${text(p.toModel, 200)}`,
          model: text(p.toModel, 200),
        },
        turnId,
      );
    } else if (method === "error") {
      this.emitEvent(
        t.id,
        "error",
        { code: "CODEX_ERROR", message: text(record(p.error).message, 2000) || "Ошибка Codex" },
        turnId,
      );
    }
  }
  private async reap(): Promise<void> {
    for (const [id, promise] of this.runtimes) {
      try {
        const r = await promise;
        if (
          !r.active.size &&
          Date.now() - r.touched > this.config.hub.codexIdleTimeoutMinutes * 60000
        ) {
          this.runtimes.delete(id);
          r.rpc.close();
        }
      } catch {
        /* Failed startup is handled by the caller. */
      }
    }
  }
  async close(): Promise<void> {
    clearInterval(this.idleTimer);
    await this.externalActivity.close();
    for (const p of [...this.runtimes.values()]) {
      try {
        (await p).rpc.close();
      } catch {}
    }
    this.runtimes.clear();
    this.summaries.clear();
  }
}
