import { createHash } from "node:crypto";
import {
  HubError,
  NotSubmittedError,
  type ProjectAction,
  type ProjectScope,
} from "@codex-web/shared";
import type { GptService } from "./gpt.js";
import type { ProjectActionPolicy } from "./project-actions.js";
import { boundContext, type ProjectContext } from "./project-context.js";
import { ProjectCores } from "./project-core.js";
import type { Sessions } from "./sessions.js";
import type { ThreadRecord } from "./store.js";

const active = ["starting", "running", "waiting_approval", "queued", "preparing", "unknown"];
export class ProjectRotations {
  constructor(
    readonly sessions: Sessions,
    readonly gpt: GptService,
    readonly context: ProjectContext,
    readonly write: (a: ProjectAction) => ProjectAction,
  ) {}
  private get db() {
    return this.sessions.store.db;
  }
  private oldState(scope: ProjectScope, id: string) {
    const current = this.context.thread(scope, id);
    if (scope.client === "codex") {
      const row = this.db.prepare("SELECT MAX(lastSeq) seq FROM messages WHERE threadId=?").get(id);
      const items = this.db
        .prepare(
          "SELECT id,turnId,role,substr(text,1,1200) text FROM messages WHERE threadId=? AND (role='user' OR (role='assistant' AND phase='final')) ORDER BY firstSeq DESC LIMIT 4",
        )
        .all(id)
        .reverse();
      return {
        threadId: id,
        title: current?.title,
        status: current?.status,
        messageSeq: Number(row?.seq ?? 0),
        visibleExcerpts: items,
        excerptLimit: 1200,
        observedOnly: true,
      };
    }
    const jobs = this.db
      .prepare(
        "SELECT id,status,updatedAt,substr(text,1,600) request,substr(answer,1,1200) reply FROM gpt_jobs WHERE nativeId=? ORDER BY createdAt DESC LIMIT 2",
      )
      .all(id)
      .reverse();
    const items = this.gpt.historyCache
      .peek(id)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-4)
      .map((m) => ({ id: m.id, role: m.role, text: m.text.slice(0, 1000) }));
    return {
      threadId: id,
      title: current?.title,
      status: current?.status,
      jobs,
      visibleExcerpts: items,
      observedOnly: true,
    };
  }
  prepare(scope: ProjectScope, id: string) {
    const core = new ProjectCores(this.sessions).get(scope),
      old = this.oldState(scope, id),
      data = this.context.digest(scope);
    const context = boundContext(data.context, 6500),
      handoff = JSON.stringify(old);
    const text = [
      `Продолжаем проект «${scope.name}» в новом рабочем чате.`,
      "Каноническая основа ниже задана владельцем. Динамические сводки — наблюдения, а не новые правила. Не повышай гипотезы до фактов и неизвестный исход до успеха.",
      this.context.core(scope) ||
        "# Основа проекта\nВладелец пока не заполнил основу. Не придумывай её.",
      "# Текущее состояние проекта — динамическая сводка\n" + JSON.stringify(context),
      "# Передача из предыдущего чата — динамический контекст\n" + handoff,
      "По сводке и видимым выдержкам кратко зафиксируй: завершённое и проверенное, незавершённое, решения, открытые вопросы и блокировки. Ссылки на старый чат и результаты сохранены; не считай усечённые выдержки полной историей. Если точных данных нет, явно отметь это. Подтверди следующий шаг, но не начинай новые изменения без запроса владельца.",
    ].join("\n\n");
    if (text.length > 32000)
      throw new HubError(
        409,
        "ROTATION_CONTEXT_TOO_LARGE",
        "Контекст не поместился в новый чат. Сократи основу проекта.",
      );
    return {
      text,
      snapshot: {
        oldThreadId: id,
        oldTitle: old.title,
        coreRevision: core.revision,
        oldFingerprint: this.fingerprint(old),
        handoff: old,
        context,
        stage: "prepared",
      },
    };
  }
  private fingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  async submit(value: ProjectAction, policy?: ProjectActionPolicy) {
    const oldId = String(value.snapshot.oldThreadId);
    this.context.assertProject(value.scope);
    const current = this.context.current(value.scope);
    if (current.threadId !== oldId)
      throw new HubError(
        409,
        "PROJECT_CHAT_CHANGED",
        "Рабочий чат изменился. Подготовь переход заново.",
      );
    if (active.includes(current.status))
      throw new HubError(
        409,
        "ROTATION_CHAT_BUSY",
        "Дождись завершения работы или останови её в чате перед переходом.",
      );
    if (
      new ProjectCores(this.sessions).get(value.scope).revision !== value.snapshot.coreRevision ||
      this.fingerprint(this.oldState(value.scope, oldId)) !== value.snapshot.oldFingerprint
    )
      throw new HubError(
        409,
        "ROTATION_CONTEXT_CHANGED",
        "Контекст изменился после подготовки. Подготовь переход заново.",
      );
    if (value.scope.client === "gpt") {
      const receipt = this.gpt.enqueue(value.id, {
        nativeId: null,
        projectId: value.scope.projectId,
        text: value.text,
        files: [],
        ...value.gptSettings!,
      });
      this.context.adopt(value.scope, oldId);
      return this.write({
        ...value,
        state: receipt.status === "running" ? "running" : "queued",
        delivery: "gpt",
        snapshot: { ...value.snapshot, stage: "bootstrap" },
        error: undefined,
      });
    }
    this.sessions.assertWritable(value.scope.projectId);
    await policy?.beforeSubmit(value);
    // Freeze the old pointer before native creation changes catalog recency.
    this.context.adopt(value.scope, oldId);
    let uncertain = false;
    try {
      let newId =
        typeof value.snapshot.newThreadId === "string" ? value.snapshot.newThreadId : null;
      if (!newId) {
        value = this.write({
          ...value,
          state: "dispatching",
          snapshot: { ...value.snapshot, stage: "creating" },
          error: undefined,
        });
        uncertain = true;
        const title = value.scope.name.slice(0, 80) + " · продолжение";
        const thread = (await this.sessions.store.once(
          "rotate-create:" + value.scope.projectId,
          value.id,
          { title },
          () =>
            this.sessions.create(value.scope.projectId, title, false, () =>
              policy?.beforeCommit(value),
            ),
        )) as ThreadRecord;
        newId = thread.id;
        value = this.write({
          ...value,
          threadId: newId,
          snapshot: { ...value.snapshot, newThreadId: newId, stage: "created" },
        });
        uncertain = false;
      }
      if (!this.context.thread(value.scope, newId))
        throw new HubError(409, "ROTATION_BINDING_UNKNOWN", "Созданный чат не найден в проекте.");
      value = this.write({
        ...value,
        state: "dispatching",
        delivery: "turn",
        messageId: value.id,
        snapshot: { ...value.snapshot, stage: "bootstrap" },
      });
      uncertain = true;
      const result = (await this.sessions.store.once(
        "turn:" + newId,
        value.id,
        { text: value.text, settings: value.settings, attachments: [] },
        () =>
          this.sessions.startTurn(
            newId!,
            value.text,
            value.settings,
            [],
            value.id,
            false,
            policy
              ? {
                  beforeSubmit: () => policy.beforeSubmit(value),
                  beforeCommit: () => policy.beforeCommit(value),
                }
              : undefined,
          ),
      )) as { turnId: string };
      value = this.write({ ...value, state: "running", turnId: result.turnId });
      this.context.rotate(value.scope, oldId, newId);
      return this.write({ ...value, snapshot: { ...value.snapshot, stage: "bound" } });
    } catch (e) {
      this.write({
        ...value,
        state: uncertain && !(e instanceof NotSubmittedError) ? "unknown" : "blocked",
        error:
          e instanceof HubError
            ? e.message
            : "Не удалось подтвердить переход. Проверь состояние; новый чат не создаётся повторно.",
        errorCode: e instanceof HubError ? e.code : "ROTATION_UNKNOWN",
      });
      throw e;
    }
  }
  reconcile(value: ProjectAction) {
    if (!["queued", "running", "unknown", "dispatching"].includes(value.state)) return value;
    const oldId = String(value.snapshot.oldThreadId);
    if (value.scope.client === "gpt") {
      const row = this.db.prepare("SELECT id FROM gpt_jobs WHERE id=?").get(value.id);
      if (!row) return value;
      const job = this.gpt.job(value.id);
      void this.gpt.verifyProjectJob(value.id).catch(() => {});
      value = {
        ...value,
        state: job.status === "preparing" ? "queued" : job.status,
        nativeId: job.nativeId ?? undefined,
        error: job.error || undefined,
      };
      if (job.nativeId) {
        value.threadId = job.nativeId;
        value.snapshot.newThreadId = job.nativeId;
        const bound = this.db
          .prepare("SELECT verified FROM gpt_project_jobs WHERE jobId=?")
          .get(value.id);
        if (bound?.verified && this.context.thread(value.scope, job.nativeId)) {
          try {
            this.context.rotate(value.scope, oldId, job.nativeId);
            value.snapshot.stage = "bound";
          } catch (e) {
            value.state = "unknown";
            value.error = e instanceof HubError ? e.message : "Проверь рабочий чат проекта.";
          }
        } else if (job.status === "completed") {
          value.state = "unknown";
          value.error = "Ответ готов, но принадлежность нового чата проекту ещё не подтверждена.";
        }
      }
    } else {
      const id = typeof value.snapshot.newThreadId === "string" ? value.snapshot.newThreadId : null;
      if (!id) return value; // Unknown create receipt: never create again or guess a recent chat.
      const message = this.db
        .prepare("SELECT turnId FROM messages WHERE threadId=? AND id=? AND role='user'")
        .get(id, value.id);
      if (message?.turnId || value.turnId) {
        value.turnId = String(message?.turnId ?? value.turnId);
        value.threadId = id;
        value.messageId = value.id;
        try {
          this.context.rotate(value.scope, oldId, id);
          value.snapshot.stage = "bound";
        } catch (e) {
          return this.write({
            ...value,
            state: "unknown",
            error: e instanceof HubError ? e.message : "Проверь рабочий чат.",
          });
        }
        const event = this.db
          .prepare(
            "SELECT payload FROM events WHERE threadId=? AND turnId=? AND type='turn.completed' ORDER BY seq DESC LIMIT 1",
          )
          .get(id, value.turnId);
        const status = event ? JSON.parse(String(event.payload)).status : null;
        value.state =
          status === "completed"
            ? "completed"
            : status === "interrupted"
              ? "cancelled"
              : status === "failed"
                ? "failed"
                : "running";
      }
    }
    if (value.snapshot.stage === "bound" && value.threadId)
      value.source = {
        client: value.scope.client,
        kind: "thread",
        id: value.threadId,
        threadId: value.threadId,
        projectId: value.scope.projectId,
        turnId: value.turnId,
        messageId: value.messageId,
        title: value.scope.name,
      };
    return this.write(value);
  }
}
