import { createHash, randomUUID } from "node:crypto";
import { inspectProject } from "@codex-web/machines";
import {
  HubError,
  type ProjectAction,
  type ProjectRepository,
  type SharedExecution,
  type SharedExecutionDetail,
  type SharedMaterial,
  type TeamCheckout,
} from "@codex-web/shared";
import type { createApp } from "./app.js";
import type { ProjectActionPolicy } from "./project-actions.js";
import type { TeamProjects } from "./team-projects.js";

type Runtime = Awaited<ReturnType<typeof createApp>>;
type Personal = (userId: string) => Promise<{ runtime: Runtime }>;
type RecordValue = Omit<SharedExecution, "own"> & {
  accessRevision: { member: number; user: number };
  checkout: TeamCheckout;
  privateActionId: string;
  repository: string | null;
  core: { id: string; revision: number; content: SharedMaterial } | null;
  native?: { workingDirectory: string; currentRevision: number; settings: string; text: string };
  problem?: string;
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const missing = () => new HubError(404, "SHARED_EXECUTION_MISSING", "Запуск недоступен.");
const changed = () =>
  new HubError(
    409,
    "SHARED_EXECUTION_CHANGED",
    "Назначение, рабочий чат или контекст изменились. Подготовь запуск заново.",
  );
const waiting = new Set(["PROJECT_BUSY", "THREAD_IN_USE", "SHARED_WAITING"]);

/** A permission-aware Hub queue. Native queue entries cannot enforce project revocation at dispatch. */
export class TeamExecutions {
  private pending = new Map<string, Promise<unknown>>();
  private leases = new Set<string>();
  private preparing = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private cursor = "";
  constructor(
    readonly projects: TeamProjects,
    private personal: Personal,
    private authorize: () => void,
    private verify: (
      runtime: Runtime,
      checkout: TeamCheckout,
      repository: string | null,
    ) => Promise<void> = verifyExecutionCheckout,
  ) {
    for (const row of this.db
      .prepare("SELECT value FROM team_executions WHERE state='dispatching'")
      .all()) {
      const v = JSON.parse(String(row.value)) as RecordValue;
      this.write({
        ...v,
        state: "unknown",
        problem: "После перезапуска проверь исход в своём чате. Повторной отправки не будет.",
      });
    }
  }
  private get db() {
    return this.projects.db;
  }
  start() {
    this.timer = setInterval(() => {
      void this.synchronize();
    }, 3000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.pending.values()]);
  }
  private raw(id: string): RecordValue {
    const row = this.db.prepare("SELECT value FROM team_executions WHERE id=?").get(id);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  private write(v: RecordValue) {
    const before = this.raw(v.id);
    v.updatedAt = Date.now();
    this.db
      .prepare("UPDATE team_executions SET state=?,value=?,updatedAt=? WHERE id=?")
      .run(v.state, JSON.stringify(v), v.updatedAt, v.id);
    if (before.state !== v.state)
      this.projects.changed(v.userId, v.projectId, "execution." + v.state, v.itemId);
    return v;
  }
  private summary(v: RecordValue, actor: string): SharedExecution {
    const {
      id,
      projectId,
      itemId,
      itemRevision,
      title,
      userId,
      userName,
      state,
      ready,
      createdAt,
      updatedAt,
    } = v;
    return {
      id,
      projectId,
      itemId,
      itemRevision,
      title,
      userId,
      userName,
      state,
      ready,
      createdAt,
      updatedAt,
      own: userId === actor,
    };
  }
  list(actor: string, projectId: string, itemId: string) {
    this.projects.get(actor, projectId, itemId);
    return {
      items: this.db
        .prepare(
          "SELECT value FROM team_executions WHERE projectId=? AND itemId=? ORDER BY createdAt DESC,id LIMIT 20",
        )
        .all(projectId, itemId)
        .map((r) => this.summary(JSON.parse(String(r.value)), actor)),
    };
  }
  private access(actor: string, projectId: string, id: string, own = false) {
    this.projects.access(actor, projectId);
    const v = this.raw(id);
    if (v.projectId !== projectId || (own && v.userId !== actor)) throw missing();
    return v;
  }
  async detail(actor: string, projectId: string, id: string): Promise<SharedExecutionDetail> {
    let v = this.access(actor, projectId, id);
    const result: SharedExecutionDetail = { execution: this.summary(v, actor) };
    if (v.userId !== actor) return result;
    const { runtime } = await this.personal(actor);
    this.access(actor, projectId, id, true);
    const row = runtime.sessions.store.db
      .prepare("SELECT id FROM project_work_actions WHERE id=?")
      .get(v.privateActionId);
    if (row) {
      const action = runtime.projectWork.get(v.privateActionId);
      v = this.observe(v, action);
      result.preview = action;
    }
    result.execution = this.summary(v, actor);
    result.checkout = v.checkout;
    result.problem = v.problem;
    return result;
  }
  private core(projectId: string) {
    const row = this.db
      .prepare(
        "SELECT id,revision,content FROM team_materials WHERE projectId=? AND kind='core' AND deleted=0",
      )
      .get(projectId);
    return row
      ? {
          id: String(row.id),
          revision: Number(row.revision),
          content: JSON.parse(String(row.content)) as SharedMaterial,
        }
      : null;
  }
  private validate(v: RecordValue) {
    this.authorize();
    if (this.stopped) throw new HubError(503, "WORKSPACE_CLOSING", "Сервис переподключается.");
    const project = this.projects.access(v.userId, v.projectId, "write"),
      item = this.projects.get(v.userId, v.projectId, v.itemId),
      checkout = this.projects.checkout(v.userId, v.projectId);
    if (
      project.memberRevision !== v.accessRevision?.member ||
      this.projects.registry.active(v.userId).executionEpoch !== v.accessRevision?.user ||
      item.revision !== v.itemRevision ||
      item.assigneeId !== v.userId ||
      !checkout ||
      hash(checkout) !== hash(v.checkout) ||
      (project.repository ?? null) !== v.repository ||
      hash(this.core(v.projectId)) !== hash(v.core)
    )
      throw changed();
    return item;
  }
  private native(v: RecordValue, runtime: Runtime, action: ProjectAction) {
    this.validate(v);
    const project = runtime.sessions.project(v.checkout.personalProjectId),
      current = runtime.projectWork.context.current(action.scope);
    runtime.projectWork.context.assertProject(action.scope);
    runtime.sessions.assertWritable(project.id);
    if (
      !v.ready ||
      !v.native ||
      action.scope.client !== "codex" ||
      action.scope.projectId !== project.id ||
      project.machineId !== v.checkout.machineId ||
      project.workingDirectory !== v.native.workingDirectory ||
      current.threadId !== action.threadId ||
      current.revision !== v.native.currentRevision ||
      hash(runtime.sessions.store.threadSettings(action.threadId!) ?? null) !== v.native.settings ||
      hash(action.text) !== v.native.text ||
      action.planId !== v.privateActionId ||
      runtime.projectWork.plans.get(v.privateActionId).revision !== action.planRevision
    )
      throw changed();
  }
  /** Covers central dispatch AND any attempt to submit its private action URL directly. */
  policy(actor: string, runtime: () => Runtime | undefined): ProjectActionPolicy {
    const bound = (action: ProjectAction) => {
      const row = this.db
        .prepare(
          "SELECT value FROM team_executions WHERE userId=? AND (privateActionId=? OR privateActionId=?)",
        )
        .get(actor, action.id, action.planId ?? "");
      if (!row) return null;
      const v = JSON.parse(String(row.value)) as RecordValue;
      if (v.privateActionId !== action.id) throw changed();
      return v;
    };
    const check = (action: ProjectAction) => {
      const v = bound(action);
      if (!v) return null;
      if (!this.leases.has(v.id) || v.state !== "dispatching" || !runtime())
        throw new HubError(409, "SHARED_CONFIRM_REQUIRED", "Подтверди запуск в общем плане.");
      this.native(v, runtime()!, action);
      return v;
    };
    return {
      prepare: (action) => {
        const v = bound(action);
        if (!v) return;
        this.validate(v);
        if (!this.preparing.has(v.id) || v.state !== "prepared") throw changed();
        if (v.core) {
          action.text =
            "## Согласованная основа общего проекта (сохранённая версия)\n" +
            JSON.stringify(v.core.content) +
            "\n\n" +
            action.text;
          action.snapshot.sharedCore = v.core;
        }
      },
      dispatch: (action, nativeQueue) => {
        if (check(action) && nativeQueue)
          throw new HubError(409, "SHARED_WAITING", "Ждём завершения текущей работы на Hub.");
      },
      beforeSubmit: async (action) => {
        const v = check(action);
        if (v) {
          await this.verify(runtime()!, v.checkout, v.repository);
          check(action);
        }
      },
      beforeCommit: (action) => {
        check(action);
      },
    };
  }
  async prepare(actor: string, projectId: string, itemId: string, id: string, revision: number) {
    this.projects.access(actor, projectId, "write");
    let v: RecordValue;
    const previous = this.db.prepare("SELECT 1 FROM team_executions WHERE id=?").get(id);
    if (previous) {
      v = this.access(actor, projectId, id, true);
      if (v.itemId !== itemId || v.itemRevision !== revision) throw changed();
      if (v.ready || v.state !== "prepared") return this.detail(actor, projectId, id);
    } else
      v = this.projects.registry.transaction(() => {
        const item = this.projects.get(actor, projectId, itemId),
          project = this.projects.access(actor, projectId, "write"),
          checkout = this.projects.checkout(actor, projectId);
        if (item.revision !== revision) throw changed();
        if (
          item.content.kind !== "plan" ||
          item.content.status === "done" ||
          !item.content.sections.some((s) => s.items.some((i) => !i.checked))
        )
          throw new HubError(
            409,
            "SHARED_PLAN_EMPTY",
            "Сначала сохрани план с невыполненными пунктами.",
          );
        if (item.assigneeId !== actor)
          throw new HubError(
            403,
            "SHARED_ASSIGNEE_REQUIRED",
            "Запуск доступен назначенному исполнителю. Назначь себя и сохрани план.",
          );
        if (!checkout)
          throw new HubError(
            409,
            "CHECKOUT_REQUIRED",
            "Сначала подключи свою рабочую папку во вкладке «Моя копия».",
          );
        if (
          this.db
            .prepare(
              "SELECT 1 FROM team_executions WHERE itemId=? AND state IN ('prepared','queued','dispatching','running','unknown')",
            )
            .get(itemId)
        )
          throw new HubError(
            409,
            "SHARED_EXECUTION_ACTIVE",
            "Этот план уже подготовлен или выполняется. Открой существующий запуск.",
          );
        if (
          Number(
            this.db
              .prepare("SELECT count(*) n FROM team_executions WHERE projectId=?")
              .get(projectId)?.n,
          ) >= 10000
        )
          throw new HubError(
            409,
            "SHARED_EXECUTION_LIMIT",
            "Достигнут лимит истории запусков проекта: 10000.",
          );
        const value: RecordValue = {
          accessRevision: {
            member: project.memberRevision,
            user: this.projects.registry.active(actor).executionEpoch,
          },
          id,
          projectId,
          itemId,
          itemRevision: revision,
          title: item.title,
          userId: actor,
          userName: this.projects.registry.user(actor).name,
          checkout,
          privateActionId: randomUUID(),
          repository: project.repository ?? null,
          core: this.core(projectId),
          ready: false,
          state: "prepared",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.db
          .prepare("INSERT INTO team_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            projectId,
            itemId,
            revision,
            actor,
            checkout.id,
            checkout.revision,
            value.state,
            value.privateActionId,
            JSON.stringify(value),
            value.createdAt,
            value.updatedAt,
          );
        this.projects.changed(actor, projectId, "execution.prepared", itemId);
        return value;
      });
    if (this.pending.has(id)) {
      await this.pending.get(id);
      return this.detail(actor, projectId, id);
    }
    const work = (async () => {
      this.preparing.add(id);
      try {
        const { runtime } = await this.personal(actor);
        this.validate(v);
        await this.verify(runtime, v.checkout, v.repository);
        const item = this.validate(v);
        if (item.content.kind !== "plan") throw changed();
        const project = runtime.sessions.project(v.checkout.personalProjectId),
          scope = { client: "codex" as const, projectId: project.id, name: project.name };
        const plan = runtime.projectWork.plans.save(v.privateActionId, {
          ...item.content,
          revision: 0,
          scope,
          links: [],
        });
        const action = await runtime.projectWork.prepare(v.privateActionId, {
          scope,
          kind: "plan",
          planId: plan.id,
          planRevision: plan.revision,
        });
        this.validate(v);
        if (this.raw(id).state !== "prepared") throw changed();
        const current = runtime.projectWork.context.current(scope);
        if (
          action.threadId !== current.threadId ||
          action.snapshot.currentRevision !== current.revision ||
          action.state !== "prepared"
        )
          throw changed();
        v = this.write({
          ...v,
          ready: true,
          native: {
            workingDirectory: project.workingDirectory,
            currentRevision: current.revision,
            settings: hash(runtime.sessions.store.threadSettings(action.threadId!) ?? null),
            text: hash(action.text),
          },
        });
      } catch (error) {
        if (this.raw(id).state === "prepared")
          this.write({
            ...this.raw(id),
            state: "blocked",
            problem:
              error instanceof HubError
                ? error.message
                : "Не удалось подготовить запуск. Сообщение не отправлено.",
          });
        throw error;
      } finally {
        this.preparing.delete(id);
      }
    })();
    this.pending.set(id, work);
    try {
      await work;
    } finally {
      this.pending.delete(id);
    }
    return this.detail(actor, projectId, id);
  }
  async submit(actor: string, projectId: string, id: string) {
    let v = this.access(actor, projectId, id, true);
    if (v.state === "prepared") {
      this.validate(v);
      if (!v.ready || this.pending.has(id)) throw changed();
      v = this.write({ ...v, state: "queued" });
    } else if (v.state === "blocked" || v.state === "cancelled" || v.state === "failed")
      throw new HubError(
        409,
        "SHARED_EXECUTION_FINISHED",
        "Этот запуск закрыт. Подготовь новое подтверждение.",
      );
    // A queued action carries explicit consent. Lost HTTP acknowledgements only read its receipt.
    if (v.state === "queued") await this.dispatch(id);
    return this.detail(actor, projectId, id);
  }
  cancel(actor: string, projectId: string, id: string) {
    const v = this.access(actor, projectId, id, true);
    if (["prepared", "queued", "blocked"].includes(v.state)) {
      if (this.leases.has(id))
        throw new HubError(409, "SHARED_DISPATCHING", "Запуск уже отправляется. Проверь свой чат.");
      this.write({ ...v, state: "cancelled", problem: undefined });
    } else if (v.state !== "cancelled")
      throw new HubError(
        409,
        "SHARED_STOP_IN_CHAT",
        "Работа уже отправлена. Останови её в своём чате.",
      );
    return { execution: this.summary(this.raw(id), actor) };
  }
  private observe(v: RecordValue, action: ProjectAction) {
    if (!["dispatching", "running", "unknown"].includes(v.state) || this.leases.has(v.id)) return v;
    const state = action.state === "dispatching" ? "unknown" : action.state;
    if (["queued", "prepared"].includes(state)) return v; // Never re-admit an uncertain dispatch.
    if (state !== v.state) return this.write({ ...v, state, problem: action.error });
    return v;
  }
  private async dispatch(id: string) {
    if (this.pending.has(id)) return this.pending.get(id);
    const work = (async () => {
      let v = this.raw(id);
      if (v.state !== "queued" || this.stopped) return;
      let runtime: Runtime | undefined;
      try {
        this.validate(v);
        runtime = (await this.personal(v.userId)).runtime;
        v = this.raw(id);
        if (v.state !== "queued") return;
        const action = runtime.projectWork.get(v.privateActionId);
        this.native(v, runtime, action);
        const thread = runtime.sessions.thread(action.threadId!);
        if (["starting", "running", "waiting_approval"].includes(thread.status)) return;
        if (thread.status === "unknown")
          throw new HubError(
            409,
            "THREAD_STATE_UNKNOWN",
            "Сначала восстанови свой рабочий чат и подготовь запуск заново.",
          );
        await this.verify(runtime, v.checkout, v.repository);
        if (this.raw(id).state !== "queued") return;
        this.native(v, runtime, action);
        v = this.write({ ...v, state: "dispatching", problem: undefined });
        this.leases.add(id);
        await runtime.projectWork.submit(v.privateActionId);
      } catch (error) {
        v = this.raw(id);
        const action = runtime?.sessions.store.db
          .prepare("SELECT value FROM project_work_actions WHERE id=?")
          .get(v.privateActionId);
        const observed = action ? (JSON.parse(String(action.value)) as ProjectAction) : undefined;
        const code = error instanceof HubError ? error.code : "SHARED_EXECUTION_FAILED";
        if (
          observed &&
          ["unknown", "running", "completed", "failed", "cancelled"].includes(observed.state) &&
          v.state === "dispatching"
        )
          this.write({ ...v, state: observed.state, problem: observed.error });
        else if (v.state === "queued" || v.state === "dispatching") {
          this.write({
            ...v,
            state: waiting.has(code) ? "queued" : "blocked",
            problem: waiting.has(code)
              ? undefined
              : error instanceof HubError
                ? error.message
                : "Не удалось выполнить проверку запуска. Подготовь новое подтверждение.",
          });
        }
      } finally {
        this.leases.delete(id);
        v = this.raw(id);
        if (runtime && v.state === "dispatching")
          this.observe(v, runtime.projectWork.get(v.privateActionId));
      }
    })();
    this.pending.set(id, work);
    try {
      await work;
    } finally {
      this.pending.delete(id);
    }
  }
  async synchronize() {
    if (this.stopped) return;
    // Maintenance/recovery pauses dispatch; it is not a failed or cancelled request.
    try {
      this.authorize();
    } catch {
      return;
    }
    const rows = this.db
      .prepare(
        "SELECT id,value FROM team_executions WHERE state IN ('prepared','queued','running','unknown') AND id>? ORDER BY id LIMIT 30",
      )
      .all(this.cursor);
    this.cursor = rows.length === 30 ? String(rows.at(-1)!.id) : "";
    await Promise.allSettled(
      rows.map(async (row) => {
        const v = JSON.parse(String(row.value)) as RecordValue;
        if (this.pending.has(v.id)) return;
        if (["prepared", "queued"].includes(v.state)) {
          try {
            this.validate(v);
          } catch {
            this.write({
              ...v,
              state: "blocked",
              problem: "Доступ или контекст изменились. Этот запуск не будет отправлен.",
            });
            return;
          }
          if (v.state === "queued") await this.dispatch(v.id);
        } else {
          // No new native reads/writes. Disabled users retain their receipts until explicitly re-enabled.
          try {
            const { runtime } = await this.personal(v.userId);
            this.observe(this.raw(v.id), runtime.projectWork.get(v.privateActionId));
          } catch {
            /* Preserve active/unknown outcome. */
          }
        }
      }),
    );
  }
}

export async function verifyExecutionCheckout(
  runtime: Runtime,
  checkout: TeamCheckout,
  repository: string | null,
) {
  const project = runtime.sessions.project(checkout.personalProjectId);
  runtime.projectWork.context.assertProject({
    client: "codex",
    projectId: project.id,
    name: project.name,
  });
  if (project.machineId !== checkout.machineId) throw changed();
  const observed = (await inspectProject(
    runtime.sessions.catalog.machine(project.machineId),
    project.workingDirectory,
    { op: "repository" },
  )) as ProjectRepository;
  const remote = observed.remote
    ? `https://github.com/${observed.remote.owner}/${observed.remote.repo}`.toLowerCase()
    : null;
  if ((observed.repository && !remote) || remote !== repository)
    throw new HubError(
      409,
      "REPOSITORY_MISMATCH",
      "Рабочая папка больше не соответствует общему репозиторию. Проверь подключение.",
    );
}
