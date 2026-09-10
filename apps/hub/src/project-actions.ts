import { createHash, randomUUID } from "node:crypto";
import {
  type ActionPrepare,
  HubError,
  type NotebookTarget,
  NotSubmittedError,
  type ProjectAction,
  type ProjectScope,
} from "@codex-web/shared";
import type { GptService } from "./gpt.js";
import { Notebook } from "./notebook.js";
import { ProjectContext } from "./project-context.js";
import { projectKey } from "./project-core.js";
import { ProjectPlans } from "./project-plans.js";
import { ProjectRotations } from "./project-rotation.js";
import type { QueueService } from "./queue.js";
import type { Sessions } from "./sessions.js";

const live = ["dispatching", "queued", "running", "unknown"];
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class ProjectActions {
  readonly plans: ProjectPlans;
  readonly rotations: ProjectRotations;
  readonly context: ProjectContext;
  private locks = new Set<string>();
  private submissionGroups = new Set<string>();
  constructor(
    readonly sessions: Sessions,
    readonly gpt: GptService,
    readonly queue: QueueService,
  ) {
    this.plans = new ProjectPlans(sessions);
    this.context = new ProjectContext(sessions, gpt);
    this.rotations = new ProjectRotations(sessions, gpt, this.context, (a) => this.write(a));
    // A process restart is not evidence that a native submission failed.
    for (const row of this.db
      .prepare("SELECT value FROM project_work_actions WHERE state='dispatching'")
      .all())
      this.write({
        ...JSON.parse(String(row.value)),
        state: "unknown",
        error: "Проверь состояние отправки после перезапуска Hub.",
      });
  }
  private get db() {
    return this.sessions.store.db;
  }
  private write(value: ProjectAction) {
    value.updatedAt = Date.now();
    this.db
      .prepare("UPDATE project_work_actions SET value=?,state=?,updatedAt=? WHERE id=?")
      .run(JSON.stringify(value), value.state, value.updatedAt, value.id);
    return value;
  }
  raw(id: string): ProjectAction {
    const row = this.db.prepare("SELECT value FROM project_work_actions WHERE id=?").get(id);
    if (!row) throw new HubError(404, "ACTION_MISSING", "Задание не найдено.");
    return JSON.parse(String(row.value));
  }
  get(id: string) {
    return this.reconcile(this.raw(id));
  }
  list(scope: string) {
    return {
      items: this.db
        .prepare(
          "SELECT id FROM project_work_actions WHERE (?='all' OR scopeKey=?) ORDER BY createdAt DESC LIMIT 30",
        )
        .all(scope, scope)
        .map((row) => {
          const { text: _text, snapshot: _snapshot, ...value } = this.get(String(row.id));
          return value;
        }),
    };
  }
  async prepare(id: string, input: ActionPrepare): Promise<ProjectAction> {
    const fingerprint = digest(input),
      existing = this.db.prepare("SELECT fingerprint FROM project_work_actions WHERE id=?").get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new HubError(
          409,
          "ACTION_KEY_REUSED",
          "Это подтверждение относится к другому заданию.",
        );
      return this.get(id);
    }
    this.context.assertProject(input.scope);

    const current = this.context.current(input.scope);
    if (!current.threadId)
      throw new HubError(
        409,
        "PROJECT_CHAT_REQUIRED",
        "Создай рабочий чат проекта перед запуском.",
      );
    const duplicate = this.db
      .prepare(
        "SELECT id FROM project_work_actions WHERE scopeKey=? AND kind=? AND COALESCE(planId,'')=? AND state IN ('dispatching','queued','running','unknown') ORDER BY createdAt DESC LIMIT 1",
      )
      .get(projectKey(input.scope), input.kind, input.planId ?? "");
    if (duplicate) return this.get(String(duplicate.id));
    let text = "",
      title = "",
      snapshot: Record<string, unknown> = { currentRevision: current.revision };
    if (input.kind === "plan") {
      const plan = this.plans.get(input.planId!);
      if (
        projectKey(plan.scope) !== projectKey(input.scope) ||
        plan.revision !== input.planRevision
      )
        throw new HubError(409, "PLAN_CONFLICT", "План изменился. Открой сохранённую версию.");
      const work = plan.sections.flatMap((s) => s.items).filter((i) => !i.checked);
      if (!work.length)
        throw new HubError(409, "PLAN_EMPTY", "Все пункты отмечены. Добавь работу перед запуском.");
      title = plan.title;
      const refs = plan.links.map((link) => this.reference(link)).join("\n\n");
      text = [
        `Реализуй план «${plan.title}» проекта «${plan.scope.name}».`,
        plan.description,
        ...plan.sections.map(
          (s) =>
            "## " +
            s.title +
            "\n" +
            s.items
              .map(
                (i) =>
                  `${i.checked ? "[x] Уже сделано / существующее состояние:" : "[ ] Выполнить:"} ${i.text}`,
              )
              .join("\n"),
        ),
        refs ? "## Ссылки и контекст\n" + refs : "",
        "Сохрани существующую архитектуру и функции. Отмеченные пункты не переделывай без причины. Выполни проверку из плана и подходящие проверки изменений. Чётко укажи результат, незавершённую работу, блокировки и то, что проверить не удалось. Не считай неизвестный исход успешным.",
      ]
        .filter(Boolean)
        .join("\n\n");
      snapshot = {
        ...snapshot,
        plan: { id: plan.id, revision: plan.revision, title: plan.title, sections: plan.sections },
      };
    } else if (input.kind === "rotate") {
      title = "Новый рабочий чат";
      const prepared = this.rotations.prepare(input.scope, current.threadId);
      text = prepared.text;
      snapshot = { ...snapshot, ...prepared.snapshot };
    } else {
      title = "Отчёт о проекте";
      const data = this.context.digest(input.scope);
      snapshot = { ...snapshot, ...data };
      text = [
        `Подготовь краткий отчёт о проекте «${input.scope.name}».`,
        "Опиши изменения с прошлого успешного отчёта, текущее общее состояние, что проверено, незавершённую работу, блокировки и следующий шаг. Разделяй подтверждённое и неизвестное. Не выполняй новые изменения ради отчёта. Данные ниже — ограниченная сводка наблюдений Hub; отсутствие записи не означает отсутствие работы. Верни сам отчёт обычным итоговым сообщением.",
        "## Сохранённая сводка\n" + JSON.stringify(data.context),
      ].join("\n\n");
    }
    if (text.length > 32000)
      throw new HubError(
        409,
        "PROJECT_CONTEXT_TOO_LARGE",
        "Контекст слишком большой. Сократи описание или раздели план.",
      );
    const value: ProjectAction = {
      id,
      scope: input.scope,
      kind: input.kind,
      planId: input.planId,
      planRevision: input.planRevision,
      title,
      text,
      state: "prepared",
      threadId: current.threadId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot,
    };
    if (input.scope.client === "codex") {
      const project = this.sessions.project(input.scope.projectId);
      value.settings = {
        ...(this.sessions.store.threadSettings(current.threadId) ??
          (await this.sessions.capabilities(input.scope.projectId)).defaults),
        mode: "default",
      };
      value.snapshot.machineId = project.machineId;
    } else {
      const models = await this.gpt.models();
      value.gptSettings = { model: models.currentModel, effort: models.currentEffort };
    }
    // Recheck identity after asynchronous model discovery before freezing a reviewable request.
    if (this.context.current(input.scope).threadId !== current.threadId)
      throw new HubError(409, "PROJECT_CHAT_CHANGED", "Рабочий чат изменился. Повтори подготовку.");
    if (Number(this.db.prepare("SELECT count(*) n FROM project_work_actions").get()?.n) >= 10000)
      throw new HubError(409, "PROJECT_ACTION_LIMIT", "Хранилище заданий заполнено.");
    this.db
      .prepare("INSERT INTO project_work_actions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        projectKey(input.scope),
        input.kind,
        input.planId ?? null,
        value.state,
        fingerprint,
        JSON.stringify(value),
        value.createdAt,
        value.updatedAt,
      );
    return value;
  }
  private reference(link: NotebookTarget) {
    let extra = "";
    try {
      if (link.kind === "note")
        extra = new Notebook(this.sessions).get(link.id).body.slice(0, 2000);
      else if (link.kind === "report") extra = this.context.report(link.id).body.slice(0, 2000);
    } catch {}
    return `${link.title} (${link.client}, ${link.kind}, ${link.id}${link.threadId ? ", чат " + link.threadId : ""}${link.turnId ? ", ход " + link.turnId : ""})${extra ? "\n" + extra : ""}`;
  }
  async submit(id: string): Promise<ProjectAction> {
    let value = this.get(id);
    if (["queued", "running", "completed"].includes(value.state)) return value;
    if (value.state === "unknown")
      throw new HubError(
        409,
        "ACTION_OUTCOME_UNKNOWN",
        "Исход отправки неизвестен. Открой диалог или проверь состояние; задание не будет отправлено повторно.",
      );
    if (!["prepared", "blocked"].includes(value.state))
      throw new HubError(409, "ACTION_NOT_READY", "Это задание уже обработано.");
    const duplicate = this.db
      .prepare(
        "SELECT id FROM project_work_actions WHERE scopeKey=? AND kind=? AND COALESCE(planId,'')=? AND id<>? AND state IN ('dispatching','queued','running','unknown') ORDER BY createdAt DESC LIMIT 1",
      )
      .get(projectKey(value.scope), value.kind, value.planId ?? "", id);
    if (duplicate) return this.get(String(duplicate.id));
    const group = projectKey(value.scope) + ":" + value.kind + ":" + (value.planId ?? "");
    if (this.submissionGroups.has(group))
      throw new HubError(409, "ACTION_PENDING", "Это задание уже отправляется.");
    if (this.locks.has(id)) throw new HubError(409, "ACTION_PENDING", "Задание уже отправляется.");
    this.locks.add(id);
    this.submissionGroups.add(group);
    let committed = false;
    try {
      this.context.assertProject(value.scope);
      if (value.kind === "rotate") return await this.rotations.submit(value);
      const rotation = this.db
        .prepare(
          "SELECT 1 FROM project_work_actions WHERE scopeKey=? AND kind='rotate' AND state IN ('dispatching','queued','running','unknown') LIMIT 1",
        )
        .get(projectKey(value.scope));
      if (rotation)
        throw new HubError(
          409,
          "PROJECT_ROTATING",
          "Сначала заверши или проверь переход в новый чат.",
        );
      if (!value.threadId || this.context.current(value.scope).threadId !== value.threadId)
        throw new HubError(
          409,
          "PROJECT_CHAT_CHANGED",
          "Рабочий чат изменился. Подготовь задание заново.",
        );
      if (value.planId && this.plans.get(value.planId).revision !== value.planRevision)
        throw new HubError(
          409,
          "PLAN_CONFLICT",
          "План изменился после подготовки. Открой его и подтверди новую версию.",
        );
      if (
        value.kind === "report" &&
        (this.context.latestReport(value.scope)?.id ?? null) !== value.snapshot.previousReportId
      )
        throw new HubError(
          409,
          "REPORT_PERIOD_CHANGED",
          "Уже появился новый отчёт. Обнови период перед запуском.",
        );
      if (value.scope.client === "codex") {
        this.sessions.assertWritable(value.scope.projectId);
        const thread = this.sessions.thread(value.threadId);
        if (thread.status === "unknown")
          throw new HubError(409, "THREAD_STATE_UNKNOWN", "Сначала восстанови рабочий диалог.");
        const queued = ["starting", "running", "waiting_approval"].includes(thread.status);
        if (queued && this.sessions.store.threadSettings(value.threadId)?.mode === "plan")
          throw new HubError(
            409,
            "WORK_MODE_REQUIRED",
            "Сейчас идёт планирование. Дождись его завершения перед запуском работы.",
          );
        value = this.write({
          ...value,
          state: "dispatching",
          delivery: queued ? "queue" : "turn",
          messageId: value.id,
          error: undefined,
          errorCode: undefined,
        });
        committed = true;
        if (queued) {
          const body = { text: value.text, attachments: [], clientId: value.id };
          await this.sessions.store.once("queue:" + value.threadId, value.id, body, () =>
            this.queue.add(value.threadId!, value.text, [], value.id),
          );
          value = this.write({ ...value, state: "queued" });
        } else {
          const body = { text: value.text, settings: value.settings, attachments: [] };
          const result = (await this.sessions.store.once(
            "turn:" + value.threadId,
            value.id,
            body,
            () =>
              this.sessions.startTurn(value.threadId!, value.text, value.settings, [], value.id),
          )) as { turnId: string };
          value = this.write({ ...value, state: "running", turnId: result.turnId });
        }
      } else {
        value = this.write({
          ...value,
          state: "dispatching",
          delivery: "gpt",
          error: undefined,
          errorCode: undefined,
        });
        const job = this.gpt.enqueue(value.id, {
          nativeId: value.threadId,
          text: value.text,
          files: [],
          ...value.gptSettings!,
        });
        value = this.write({
          ...value,
          state: job.status === "running" ? "running" : "queued",
          nativeId: job.nativeId ?? undefined,
        });
      }
      this.context.adopt(value.scope, value.threadId!);
      return this.reconcile(value);
    } catch (e) {
      value = this.raw(id);
      if (value.kind === "rotate" && ["unknown", "blocked"].includes(value.state)) throw e;
      const uncertain = committed && !(e instanceof NotSubmittedError);
      this.write({
        ...value,
        state: uncertain ? "unknown" : "blocked",
        error:
          e instanceof HubError
            ? e.message
            : "Не удалось подтвердить отправку. Проверь состояние задания.",
        errorCode: e instanceof HubError ? e.code : "ACTION_FAILED",
      });
      throw e;
    } finally {
      this.locks.delete(id);
      this.submissionGroups.delete(group);
    }
  }
  reconcile(value: ProjectAction): ProjectAction {
    if (!live.includes(value.state) || this.locks.has(value.id)) return value;
    if (value.kind === "rotate") return this.rotations.reconcile(value);
    let state = value.state,
      body = "",
      source = value.source;
    if (value.scope.client === "codex") {
      const message = this.db
        .prepare("SELECT id,turnId FROM messages WHERE threadId=? AND id=? AND role='user'")
        .get(value.threadId!, value.id);
      if (value.delivery === "queue" && !message?.turnId) {
        const held = this.db
          .prepare(
            "SELECT state FROM queue_transfers WHERE threadId=? AND json_extract(value,'$.clientUserMessageId')=?",
          )
          .get(value.threadId!, value.id);
        const change = this.db
          .prepare(
            "SELECT payload FROM events WHERE threadId=? AND type='queue.changed' AND json_extract(payload,'$.clientMessageId')=? AND json_extract(payload,'$.action') IN ('delete','dismissed') ORDER BY seq DESC LIMIT 1",
          )
          .get(value.threadId!, value.id);
        const action = change ? JSON.parse(String(change.payload)).action : null;
        if (action === "delete") state = "cancelled";
        else if (
          action === "dismissed" ||
          (held && ["unknown", "enqueue_unknown"].includes(String(held.state)))
        ) {
          state = "unknown";
          value.error = "Исход отправки из очереди нужно проверить в диалоге.";
        }
      }
      if (message?.turnId) {
        value.turnId = String(message.turnId);
        value.messageId = String(message.id);
        state = "running";
      }
      if (value.turnId) {
        const terminal = this.db
          .prepare(
            "SELECT payload FROM events WHERE threadId=? AND turnId=? AND type='turn.completed' ORDER BY seq DESC LIMIT 1",
          )
          .get(value.threadId!, value.turnId);
        if (terminal) {
          const status = JSON.parse(String(terminal.payload)).status;
          state =
            status === "completed"
              ? "completed"
              : status === "interrupted"
                ? "cancelled"
                : status === "failed"
                  ? "failed"
                  : "unknown";
        }
        const messages = this.db
          .prepare(
            "SELECT id,text FROM messages WHERE threadId=? AND turnId=? AND role='assistant' AND phase='final' ORDER BY firstSeq LIMIT 20",
          )
          .all(value.threadId!, value.turnId);
        body = messages
          .map((m) => String(m.text))
          .join("\n\n")
          .slice(0, 100000);
        source = {
          client: "codex",
          kind: "thread",
          id: value.threadId!,
          threadId: value.threadId!,
          projectId: value.scope.projectId,
          turnId: value.turnId,
          messageId:
            value.kind === "report" && messages.length
              ? String(messages.at(-1)!.id)
              : value.messageId,
          title: value.title,
        };
      }
    } else {
      const row = this.db.prepare("SELECT id FROM gpt_jobs WHERE id=?").get(value.id);
      if (row) {
        const job = this.gpt.job(value.id);
        state = job.status === "preparing" ? "queued" : job.status;
        value.nativeId = job.nativeId ?? undefined;
        body = job.answer;
        const final = job.nativeId
          ? this.gpt.historyCache
              .peek(job.nativeId)
              .filter(
                (m) =>
                  m.role === "assistant" &&
                  body.includes(m.text) &&
                  m.text.trim() &&
                  Number(m.createdAt) * 1000 >= job.createdAt - 10000,
              )
              .at(-1)
          : undefined;
        if (job.nativeId)
          source = {
            client: "gpt",
            kind: "thread",
            id: job.nativeId,
            threadId: job.nativeId,
            projectId: value.scope.projectId,
            messageId: final?.id,
            title: value.title,
          };
        if (job.error) value.error = job.error;
      }
    }
    value = { ...value, state, source };
    if (state === "completed" && value.kind === "report") {
      if (!body.trim() || !source) {
        const first = Number(value.snapshot.finalPendingAt ?? Date.now());
        value.snapshot.finalPendingAt = first;
        value.state = Date.now() - first < 30000 ? "running" : "failed";
        value.error =
          value.state === "failed"
            ? "Ответ завершён без текста отчёта. Контрольная точка не изменена."
            : undefined;
      } else this.saveReport(value, body, source);
    }
    return this.write(value);
  }
  private saveReport(value: ProjectAction, body: string, source: NotebookTarget) {
    if (this.db.prepare("SELECT 1 FROM project_reports WHERE actionId=?").get(value.id)) return;
    this.db
      .prepare("INSERT INTO project_reports VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        value.id,
        projectKey(value.scope),
        JSON.stringify(value.scope),
        value.title,
        body,
        value.id,
        JSON.stringify(source),
        Number(value.snapshot.periodFrom ?? 0),
        Number(value.snapshot.periodTo ?? value.createdAt),
        JSON.stringify(value.snapshot.watermarks ?? {}),
        Date.now(),
      );
  }
  synchronize() {
    for (const row of this.db
      .prepare(
        "SELECT value FROM project_work_actions WHERE state IN ('queued','running','unknown') ORDER BY updatedAt LIMIT 50",
      )
      .all()) {
      try {
        this.reconcile(JSON.parse(String(row.value)));
      } catch {}
    }
  }
  keepCurrent(id: string) {
    const value = this.get(id);
    if (
      value.kind !== "rotate" ||
      !["blocked", "unknown"].includes(value.state) ||
      this.context.current(value.scope).threadId !== value.snapshot.oldThreadId
    )
      throw new HubError(
        409,
        "ROTATION_ALREADY_BOUND",
        "Рабочий чат уже изменился или переход ещё выполняется. Обнови состояние.",
      );
    return this.write({
      ...value,
      state: "cancelled",
      error: undefined,
      errorCode: undefined,
      snapshot: { ...value.snapshot, ownerKeptPrevious: true },
    });
  }
  cancel(id: string) {
    const value = this.get(id);
    if (!["prepared", "blocked"].includes(value.state))
      throw new HubError(
        409,
        "ACTION_ALREADY_SENT",
        "Отправленное задание останавливается в его диалоге.",
      );
    return this.write({ ...value, state: "cancelled" });
  }
}
