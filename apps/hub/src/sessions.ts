import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { Attachments } from "./attachments.js";
import { Catalog, type CatalogProject } from "./catalog.js";
import type { Store, ThreadRecord } from "./store.js";

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
  readonly attachments: Attachments;
  readonly catalog: Catalog;
  private idleTimer: NodeJS.Timeout;
  constructor(
    readonly config: HubConfig,
    readonly store: Store,
    private clientFactory: (machine: MachineConfig, cwd: string) => CodexClient = (m, cwd) =>
      new CodexClient(spawnCodex(m, cwd)),
  ) {
    super();
    this.attachments = new Attachments(join(config.hub.resultsPath, "uploads"), store);
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
        await rpc.initialize();
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

  async status(projectId: string): Promise<{ available: boolean; code?: string }> {
    try {
      const runtime = await this.runtime(projectId);
      runtime.touched = Date.now();
      await runtime.rpc.request("account/read", { refreshToken: false });
      return { available: true };
    } catch {
      return { available: false, code: "CODEX_UNAVAILABLE" };
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
    const [presets, configuration] = await Promise.all([
      r.rpc.request("collaborationMode/list", {}),
      r.rpc.request("config/read", {
        includeLayers: false,
        cwd: this.project(projectId).workingDirectory,
      }),
    ]);
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
    r.capabilities = {
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
    return model;
  }
  async setSettings(id: string, value: TurnSettings): Promise<TurnSettings> {
    const thread = this.thread(id);
    return this.locked(thread.projectId, async () => {
      await this.validateSettings(thread.projectId, value);
      this.store.setThreadSettings(id, value);
      this.emitEvent(id, "thread.settings", { settings: value });
      return value;
    });
  }

  private async locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
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
  async resume(id: string): Promise<ThreadRecord> {
    const t = this.thread(id);
    return this.locked(t.projectId, async () => {
      const r = await this.runtime(t.projectId);
      if (r.loaded.has(id)) return this.store.thread(id);
      const result = await r.rpc.request("thread/resume", {
        threadId: t.codexThreadId,
        cwd: t.workingDirectory || this.project(t.projectId).workingDirectory,
        excludeTurns: true,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
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
    const t = this.thread(id);
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
      if (
        r.loaded.has(id) &&
        (t.origin === "desktop" ||
          (t.historyMode &&
            this.store.db
              .prepare("SELECT 1 FROM events WHERE threadId=? AND type='turn.completed' LIMIT 1")
              .get(id)))
      ) {
        await r.rpc.request("thread/unsubscribe", { threadId: t.codexThreadId });
        r.loaded.delete(id);
      }
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
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
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
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        });
        r.loaded.add(id);
      }
      const prepared = await this.attachments.prepare(
        { ...this.config, projects: this.catalog.projects() },
        id,
        attachmentIds,
        model.supportsImages,
      );
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
      this.store.setStatus(id, "starting");
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
          model: selection.model,
          effort: selection.effort,
          collaborationMode: {
            mode: selection.mode,
            settings: {
              model: selection.model,
              reasoning_effort: selection.effort,
              developer_instructions: null,
            },
          },
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
    if (method === "serverRequest/resolved") {
      for (const [key, a] of this.approvals)
        if (a.rpc === r.rpc && a.requestId === p.requestId) {
          this.approvals.delete(key);
          this.emitEvent(t.id, "approval.resolved", { id: key, decision: "resolved" }, turnId);
        }
    } else if (method === "turn/started") {
      const id = text(record(p.turn).id);
      r.active.add(t.id);
      this.store.setStatus(t.id, "running", id);
      this.emitEvent(t.id, "turn.started", { id }, id);
    } else if (method === "turn/completed") {
      const turn = record(p.turn),
        id = text(turn.id),
        status = text(turn.status);
      r.active.delete(t.id);
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
      if (type === "agentMessage" || type === "plan") {
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
    for (const p of [...this.runtimes.values()]) {
      try {
        (await p).rpc.close();
      } catch {}
    }
    this.runtimes.clear();
  }
}
