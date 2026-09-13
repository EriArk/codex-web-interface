import { createHash, randomUUID } from "node:crypto";
import { HubError, type SharedReportDraft, sharedReportPublishSchema } from "@codex-web/shared";
import type { TeamProjects } from "./team-projects.js";

type Draft = SharedReportDraft & {
  userId: string;
  memberRevision: number;
  epoch: number;
  publishHash?: string;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = () => new HubError(404, "SHARED_REPORT_MISSING", "Подготовка отчёта недоступна.");
const changed = () =>
  new HubError(
    409,
    "SHARED_REPORT_CHANGED",
    "Период отчёта или доступ изменились. Подготовь новую сводку; твой текст сохранён.",
  );
const labels: Record<string, string> = {
  "material.created": "Добавлен материал",
  "material.updated": "Изменён материал",
  "material.removed": "Удалён материал",
  "execution.prepared": "Подготовлен запуск",
  "execution.queued": "Запуск в очереди",
  "execution.running": "Начата работа",
  "execution.completed": "Работа завершена",
  "execution.failed": "Работа не завершилась",
  "execution.unknown": "Исход работы не подтверждён",
  "execution.blocked": "Работа заблокирована",
  "execution.cancelled": "Запуск отменён",
  "github.linked": "Связана версия Issue/PR",
  "github.completed": "Выполнено действие в GitHub",
  "github.unknown": "Исход действия GitHub не подтверждён",
  "report.published": "Опубликован отчёт",
  "review.accepted": "Работа принята",
  "review.needs_fixes": "Запрошены исправления",
  "task.plan_created": "Подготовлен план по задаче",
};
/** A bounded shared-ledger snapshot, never a read of any member's private runtime. */
export class TeamReports {
  constructor(readonly projects: TeamProjects) {}
  private get db() {
    return this.projects.db;
  }
  private own(actor: string, projectId: string, id: string): Draft {
    this.projects.access(actor, projectId);
    const row = this.db
      .prepare("SELECT value FROM team_report_drafts WHERE id=? AND projectId=? AND userId=?")
      .get(id, projectId, actor);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  private view(v: Draft): SharedReportDraft {
    const {
      userId: _user,
      memberRevision: _member,
      epoch: _epoch,
      publishHash: _hash,
      ...result
    } = v;
    return result;
  }
  get(actor: string, projectId: string, id: string) {
    return this.view(this.own(actor, projectId, id));
  }
  list(actor: string, projectId: string) {
    this.projects.access(actor, projectId);
    return {
      items: this.db
        .prepare(
          "SELECT value FROM team_report_drafts WHERE projectId=? AND userId=? ORDER BY createdAt DESC,id LIMIT 20",
        )
        .all(projectId, actor)
        .map((r) => {
          const v = this.view(JSON.parse(String(r.value)));
          return {
            id: v.id,
            state: v.state,
            createdAt: v.createdAt,
            title: v.content.title,
            itemId: v.itemId,
          };
        }),
    };
  }
  private write(v: Draft) {
    this.db
      .prepare("UPDATE team_report_drafts SET state=?,value=? WHERE id=?")
      .run(v.state, JSON.stringify(v), v.id);
  }
  prepare(actor: string, projectId: string, id: string) {
    const project = this.projects.access(actor, projectId, "write");
    if (this.db.prepare("SELECT 1 FROM team_report_drafts WHERE id=?").get(id))
      return this.get(actor, projectId, id);
    return this.projects.registry.transaction(() => {
      if (
        Number(
          this.db
            .prepare("SELECT count(*) n FROM team_report_drafts WHERE projectId=? AND userId=?")
            .get(projectId, actor)?.n,
        ) >= 500
      )
        throw new HubError(
          409,
          "SHARED_REPORT_LIMIT",
          "Достигнут лимит подготовленных отчётов проекта: 500.",
        );
      const previous = this.db
          .prepare("SELECT * FROM team_report_checkpoints WHERE projectId=?")
          .get(projectId),
        fromSeq = Number(previous?.seq ?? 0),
        toSeq = Number(
          this.db
            .prepare("SELECT max(seq) n FROM team_project_activity WHERE projectId=?")
            .get(projectId)?.n ?? fromSeq,
        ),
        now = Date.now(),
        events = this.db
          .prepare(
            "SELECT a.seq,a.actorName,a.action,a.createdAt,json_extract(m.content,'$.title') title FROM team_project_activity a LEFT JOIN team_materials m ON m.id=a.itemId AND m.projectId=a.projectId WHERE a.projectId=? AND a.seq>? AND a.seq<=? ORDER BY a.seq DESC LIMIT 60",
          )
          .all(projectId, fromSeq, toSeq)
          .reverse(),
        observed = Number(
          this.db
            .prepare(
              "SELECT count(*) n FROM team_project_activity WHERE projectId=? AND seq>? AND seq<=?",
            )
            .get(projectId, fromSeq, toSeq)?.n,
        ),
        removedThrough = Number(
          this.db
            .prepare("SELECT removedThroughSeq n FROM team_activity_bounds WHERE projectId=?")
            .get(projectId)?.n ?? 0,
        ),
        counts = this.db
          .prepare(
            "SELECT kind,coalesce(json_extract(content,'$.status'),json_extract(content,'$.outcome'),'') status,count(*) n FROM team_materials WHERE projectId=? AND deleted=0 GROUP BY kind,status",
          )
          .all(projectId),
        pending = this.db
          .prepare(
            "SELECT kind,json_extract(content,'$.title') title,json_extract(content,'$.status') status,coalesce(u.name,'Не назначен') assignee FROM team_materials m LEFT JOIN team_users u ON u.id=m.assigneeId WHERE m.projectId=? AND m.deleted=0 AND m.kind IN ('task','plan') AND json_extract(m.content,'$.status')!='done' ORDER BY m.updatedAt DESC LIMIT 20",
          )
          .all(projectId),
        runs = this.db
          .prepare(
            "SELECT json_extract(value,'$.title') title,json_extract(value,'$.userName') name,state FROM team_executions WHERE projectId=? AND state IN ('prepared','queued','dispatching','running','unknown','blocked') ORDER BY updatedAt DESC LIMIT 10",
          )
          .all(projectId),
        truncated = observed > events.length || removedThrough > fromSeq;
      const count = (kind: string, state?: string) =>
          counts
            .filter((r) => r.kind === kind && (!state || r.status === state))
            .reduce((n, r) => n + Number(r.n), 0),
        safe = (v: unknown, max = 120) =>
          String(v ?? "")
            .replace(/[\r\n]/g, " ")
            .slice(0, max),
        states: Record<string, string> = {
          todo: "нужно сделать",
          doing: "в работе",
          blocked: "ждёт",
          draft: "план",
          prepared: "подготовлено",
          queued: "в очереди",
          dispatching: "отправляется",
          running: "в работе",
          unknown: "исход неизвестен",
        },
        lines = [
          `# ${project.title}`,
          `Сводка общего журнала на ${new Date(now).toISOString()}.`,
          "## Состояние",
          `Задачи: ${count("task", "done")} из ${count("task")} завершены. Планы: ${count("plan", "done")} из ${count("plan")} завершены.`,
          `Приёмка: ${count("review", "accepted")} принято, ${count("review", "needs_fixes")} требуют исправлений, ${count("review", "pending")} на проверке.`,
          "## Изменения за период",
          ...(events.length
            ? events.map(
                (e) =>
                  `- ${new Date(Number(e.createdAt)).toISOString()} · ${safe(e.actorName, 80)}: ${labels[String(e.action)] ?? "Обновлён общий проект"}${e.title ? " · " + safe(e.title) : ""}`,
              )
            : ["В общем журнале за этот период новых записей нет."]),
          "## Осталось сделать",
          ...(pending.length
            ? pending.map(
                (m) =>
                  `- ${safe(m.title)} · ${states[String(m.status)] ?? "не завершено"} · ${safe(m.assignee, 80)}`,
              )
            : ["Открытых общих задач и планов нет."]),
          ...(runs.length
            ? [
                "## Текущее выполнение",
                ...runs.map(
                  (r) =>
                    `- ${safe(r.title)} · ${safe(r.name, 80)} · ${states[String(r.state)] ?? "проверь состояние"}`,
                ),
              ]
            : []),
          "## Границы сводки",
          "Только сохранённое общее состояние. Личные чаты, команды, неопубликованные результаты и история GitHub не читаются. Завершение запуска само по себе не означает приёмку работы или успешные проверки.",
          `Показано ${events.length} из ${observed} доступных событий, до 20 открытых задач/планов и до 10 незавершённых запусков. Общий журнал хранит последние 1000 событий.${truncated ? " Часть периода сокращена или уже вне сохранённого журнала." : ""}`,
        ];
      const v: Draft = {
        id,
        projectId,
        userId: actor,
        memberRevision: project.memberRevision,
        epoch: this.projects.registry.active(actor).executionEpoch,
        state: "prepared",
        authorName: this.projects.registry.user(actor).name,
        createdAt: now,
        content: {
          kind: "report",
          title: "Отчёт · " + new Date(now).toISOString().slice(0, 10),
          body: lines.join("\n\n").slice(0, 32000),
          periodFrom: Number(previous?.capturedAt ?? project.createdAt ?? now),
          periodTo: now,
        },
        checkpoint: {
          previousReportId: previous ? String(previous.itemId) : null,
          fromSeq,
          toSeq,
          observedEvents: observed,
          includedEvents: events.length,
          truncated,
        },
      };
      this.db
        .prepare("INSERT INTO team_report_drafts VALUES(?,?,?,?,?,?)")
        .run(id, projectId, actor, v.state, JSON.stringify(v), now);
      return this.view(v);
    });
  }
  publish(actor: string, projectId: string, id: string, raw: unknown) {
    const input = sharedReportPublishSchema.parse(raw),
      v = this.own(actor, projectId, id),
      project = this.projects.access(actor, projectId, "write");
    if (v.state === "published") {
      if (v.publishHash !== hash(input)) throw changed();
      this.projects.get(actor, projectId, v.itemId!);
      return this.view(v);
    }
    if (
      v.state !== "prepared" ||
      v.memberRevision !== project.memberRevision ||
      v.epoch !== this.projects.registry.active(actor).executionEpoch
    )
      throw changed();
    const previous = this.db
      .prepare("SELECT itemId FROM team_report_checkpoints WHERE projectId=?")
      .get(projectId);
    if ((previous?.itemId ?? null) !== v.checkpoint.previousReportId) throw changed();
    const itemId = randomUUID(),
      content = { ...v.content, title: input.title, body: input.body };
    this.projects.put(
      actor,
      projectId,
      itemId,
      id,
      { revision: 0, assigneeId: null, content },
      undefined,
      () => {
        this.db
          .prepare(
            "INSERT INTO team_report_checkpoints VALUES(?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET itemId=excluded.itemId,seq=excluded.seq,capturedAt=excluded.capturedAt",
          )
          .run(projectId, itemId, v.checkpoint.toSeq, v.content.periodTo);
        this.write({ ...v, content, state: "published", itemId, publishHash: hash(input) });
        this.projects.changed(actor, projectId, "report.published", itemId);
      },
    );
    return this.get(actor, projectId, id);
  }
  cancel(actor: string, projectId: string, id: string) {
    const v = this.own(actor, projectId, id);
    if (v.state === "published") throw changed();
    this.write({ ...v, state: "cancelled" });
    return this.get(actor, projectId, id);
  }
}
