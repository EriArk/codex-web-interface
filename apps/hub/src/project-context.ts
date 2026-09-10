import {
  type CurrentProjectChat,
  HubError,
  type ProjectReport,
  type ProjectScope,
  type ReportPage,
} from "@codex-web/shared";
import type { GptService } from "./gpt.js";
import { Notebook } from "./notebook.js";
import { ProjectCores, projectKey } from "./project-core.js";
import { ProjectPlans } from "./project-plans.js";
import type { Sessions } from "./sessions.js";
import { WorkspaceTasks } from "./tasks.js";

const active = ["starting", "running", "waiting_approval", "unknown"];
export class ProjectContext {
  constructor(
    readonly sessions: Sessions,
    readonly gpt: GptService,
  ) {}
  private get db() {
    return this.sessions.store.db;
  }
  assertProject(scope: ProjectScope) {
    if (scope.client === "codex") {
      const project = this.sessions.project(scope.projectId),
        entry = this.sessions.catalog.library.get("project", scope.projectId);
      if (project.unassigned || entry?.archived || entry?.deleted)
        throw new HubError(409, "PROJECT_UNAVAILABLE", "Сначала открой доступный проект.");
    } else {
      const project = this.gpt.library.get("project", scope.projectId);
      if (!project || project.deleted || project.archived)
        throw new HubError(
          409,
          "PROJECT_UNAVAILABLE",
          "Сначала обнови или разархивируй проект GPT.",
        );
    }
  }
  thread(scope: ProjectScope, id: string) {
    if (scope.client === "codex") {
      const row = this.db
          .prepare("SELECT * FROM threads WHERE id=? AND projectId=?")
          .get(id, scope.projectId),
        entry = row
          ? this.sessions.catalog.library.get("thread", String(row.codexThreadId))
          : undefined;
      if (!row || row.archived || entry?.deleted || entry?.archived) return null;
      return { threadId: id, title: String(row.title), status: String(row.status) };
    }
    const entry = this.gpt.library.get("thread", id);
    if (!entry || entry.projectId !== scope.projectId || entry.archived || entry.deleted)
      return null;
    const run = this.db
      .prepare(
        "SELECT status FROM gpt_jobs WHERE nativeId=? AND status IN ('queued','preparing','running','unknown') ORDER BY createdAt DESC LIMIT 1",
      )
      .get(id);
    return {
      threadId: id,
      title: entry.name || "Диалог GPT",
      status: String(run?.status ?? "idle"),
    };
  }
  current(scope: ProjectScope): CurrentProjectChat {
    const key = projectKey(scope),
      saved = this.db
        .prepare("SELECT threadId,revision FROM project_current_chats WHERE scopeKey=?")
        .get(key);
    const history = this.db
      .prepare(
        "SELECT threadId,title,rotatedAt FROM project_chat_history WHERE scopeKey=? ORDER BY rotatedAt DESC LIMIT 20",
      )
      .all(key)
      .map((r) => ({
        threadId: String(r.threadId),
        title: String(r.title),
        rotatedAt: Number(r.rotatedAt),
      }));
    if (saved) {
      const t = this.thread(scope, String(saved.threadId));
      return {
        ...(t ?? { threadId: null, title: "Рабочий чат недоступен", status: "missing" }),
        explicit: true,
        revision: Number(saved.revision),
        history,
      };
    }
    const rows =
      scope.client === "codex"
        ? this.db
            .prepare(
              "SELECT t.id FROM threads t WHERE t.projectId=? AND t.archived=0 AND NOT EXISTS(SELECT 1 FROM library_entities e WHERE e.client='codex' AND e.kind='thread' AND e.id=t.codexThreadId AND (json_extract(e.value,'$.deleted')=1 OR json_extract(e.value,'$.archived')=1)) ORDER BY CASE WHEN t.status IN ('starting','running','waiting_approval','unknown') THEN 0 ELSE 1 END,COALESCE(t.activityAt,t.updatedAt) DESC,t.id LIMIT 1",
            )
            .all(scope.projectId)
        : this.db
            .prepare(
              "SELECT id FROM library_entities WHERE client='gpt' AND kind='thread' AND json_extract(value,'$.projectId')=? AND COALESCE(json_extract(value,'$.deleted'),0)=0 AND COALESCE(json_extract(value,'$.archived'),0)=0 ORDER BY COALESCE(json_extract(value,'$.activityAt'),0) DESC,id LIMIT 1",
            )
            .all(scope.projectId);
    const t = rows.length ? this.thread(scope, String(rows[0]!.id)) : null;
    return {
      ...(t ?? { threadId: null, title: "Нет рабочего чата", status: "missing" }),
      explicit: false,
      revision: 0,
      history,
    };
  }
  adopt(scope: ProjectScope, threadId: string) {
    if (!this.thread(scope, threadId))
      throw new HubError(409, "PROJECT_CHAT_CHANGED", "Рабочий чат изменился. Обнови проект.");
    this.db
      .prepare("INSERT OR IGNORE INTO project_current_chats VALUES(?,?,?,?,?)")
      .run(projectKey(scope), JSON.stringify(scope), threadId, 1, Date.now());
  }
  rotate(scope: ProjectScope, oldId: string, newId: string) {
    if (!this.thread(scope, newId))
      throw new HubError(
        409,
        "ROTATION_BINDING_UNKNOWN",
        "Новый чат ещё не подтверждён в этом проекте.",
      );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.current(scope);
      if (current.threadId === newId) {
        this.db.exec("COMMIT");
        return;
      }
      if (current.threadId !== oldId)
        throw new HubError(
          409,
          "PROJECT_CHAT_CHANGED",
          "Рабочий чат уже изменился. Проверь оба диалога.",
        );
      this.db
        .prepare("INSERT OR IGNORE INTO project_chat_history VALUES(?,?,?,?)")
        .run(projectKey(scope), oldId, current.title, Date.now());
      this.db
        .prepare(
          "INSERT INTO project_current_chats VALUES(?,?,?,?,?) ON CONFLICT(scopeKey) DO UPDATE SET threadId=excluded.threadId,revision=project_current_chats.revision+1,updatedAt=excluded.updatedAt",
        )
        .run(projectKey(scope), JSON.stringify(scope), newId, 1, Date.now());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  latestReport(scope: ProjectScope): ProjectReport | null {
    const row = this.db
      .prepare(
        "SELECT id FROM project_reports WHERE scopeKey=? ORDER BY periodTo DESC,createdAt DESC,id DESC LIMIT 1",
      )
      .get(projectKey(scope));
    return row ? this.report(String(row.id)) : null;
  }
  report(id: string): ProjectReport {
    const r = this.db.prepare("SELECT * FROM project_reports WHERE id=?").get(id);
    if (!r) throw new HubError(404, "REPORT_MISSING", "Отчёт не найден.");
    return {
      id,
      scope: JSON.parse(String(r.scope)),
      title: String(r.title),
      body: String(r.body),
      actionId: String(r.actionId),
      source: JSON.parse(String(r.source)),
      periodFrom: Number(r.periodFrom),
      periodTo: Number(r.periodTo),
      watermarks: JSON.parse(String(r.watermarks)),
      createdAt: Number(r.createdAt),
    };
  }
  reports(scope: string, offset = 0): ReportPage {
    const rows = this.db
      .prepare(
        "SELECT id,scope,title,actionId,source,periodFrom,periodTo,createdAt FROM project_reports WHERE (?='all' OR scopeKey=?) ORDER BY createdAt DESC,id LIMIT 31 OFFSET ?",
      )
      .all(scope, scope, offset);
    return {
      items: rows.slice(0, 30).map((r) => ({
        id: String(r.id),
        scope: JSON.parse(String(r.scope)),
        title: String(r.title),
        actionId: String(r.actionId),
        source: JSON.parse(String(r.source)),
        periodFrom: Number(r.periodFrom),
        periodTo: Number(r.periodTo),
        createdAt: Number(r.createdAt),
      })),
      nextOffset: rows.length > 30 ? offset + 30 : null,
    };
  }
  digest(scope: ProjectScope) {
    const key = projectKey(scope),
      previous = this.latestReport(scope),
      from = previous?.watermarks ?? {},
      until = Date.now();
    const notes = new Notebook(this.sessions)
      .list(key, "", 0, 8)
      .items.map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt, updatedAt: n.updatedAt }));
    const tasks = new WorkspaceTasks(this.sessions)
      .list(key, "all", "", 0, "", 20)
      .items.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueAt: t.dueAt,
        updatedAt: t.updatedAt,
      }));
    const plans = new ProjectPlans(this.sessions)
      .list(key, "", 0)
      .items.slice(0, 10)
      .map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        checked: p.checked,
        total: p.total,
        updatedAt: p.updatedAt,
      }));
    const pins = new Notebook(this.sessions).pins(key, 0, 6).items.map((p) => p.target);
    let turns: Record<string, unknown>[] = [],
      results: Record<string, unknown>[] = [],
      errors: Record<string, unknown>[] = [],
      watermarks: Record<string, number> = { time: until },
      counts: Record<string, number> = {};
    if (scope.client === "codex") {
      const events = this.db
        .prepare(
          "SELECT max(e.seq) n FROM events e JOIN threads t ON t.id=e.threadId WHERE t.projectId=?",
        )
        .get(scope.projectId);
      const result = this.db
        .prepare(
          "SELECT max(r.rowid) n FROM results r JOIN threads t ON t.id=r.threadId WHERE t.projectId=?",
        )
        .get(scope.projectId);
      watermarks = {
        ...watermarks,
        eventSeq: Number(events?.n ?? 0),
        resultRow: Number(result?.n ?? 0),
      };
      turns = this.db
        .prepare(
          "SELECT e.seq,e.threadId,e.turnId,e.createdAt,json_extract(e.payload,'$.status') status,t.title, (SELECT substr(m.text,1,700) FROM messages m WHERE m.threadId=e.threadId AND m.turnId=e.turnId AND m.role='assistant' AND m.phase='final' ORDER BY m.lastSeq DESC LIMIT 1) summary FROM events e JOIN threads t ON t.id=e.threadId WHERE t.projectId=? AND e.seq>? AND e.seq<=? AND e.type='turn.completed' ORDER BY e.seq DESC LIMIT 20",
        )
        .all(scope.projectId, from.eventSeq ?? 0, watermarks.eventSeq ?? 0);
      results = this.db
        .prepare(
          "SELECT r.rowid,r.id,r.threadId,r.turnId,r.title,r.type,r.createdAt FROM results r JOIN threads t ON t.id=r.threadId WHERE t.projectId=? AND r.rowid>? AND r.rowid<=? ORDER BY r.rowid DESC LIMIT 20",
        )
        .all(scope.projectId, from.resultRow ?? 0, watermarks.resultRow ?? 0);
      errors = this.db
        .prepare(
          "SELECT e.seq,e.threadId,e.turnId,e.createdAt,substr(json_extract(e.payload,'$.message'),1,240) message FROM events e JOIN threads t ON t.id=e.threadId WHERE t.projectId=? AND e.seq>? AND e.seq<=? AND e.type='error' ORDER BY e.seq DESC LIMIT 8",
        )
        .all(scope.projectId, from.eventSeq ?? 0, watermarks.eventSeq ?? 0);
      counts.turns = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM events e JOIN threads t ON t.id=e.threadId WHERE t.projectId=? AND e.seq>? AND e.seq<=? AND e.type='turn.completed'",
          )
          .get(scope.projectId, from.eventSeq ?? 0, watermarks.eventSeq ?? 0)?.n ?? 0,
      );
      counts.results = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM results r JOIN threads t ON t.id=r.threadId WHERE t.projectId=? AND r.rowid>? AND r.rowid<=?",
          )
          .get(scope.projectId, from.resultRow ?? 0, watermarks.resultRow ?? 0)?.n ?? 0,
      );
    } else {
      turns = this.db
        .prepare(
          "SELECT j.id,j.nativeId,j.status,j.updatedAt,substr(j.answer,1,700) summary FROM gpt_jobs j JOIN library_entities e ON e.client='gpt' AND e.kind='thread' AND e.id=j.nativeId WHERE json_extract(e.value,'$.projectId')=? AND j.updatedAt>? AND j.updatedAt<=? ORDER BY j.updatedAt DESC LIMIT 20",
        )
        .all(scope.projectId, from.time ?? 0, until);
      results = turns.map((t) => ({ jobId: t.id, nativeId: t.nativeId, status: t.status }));
    }
    const prefs = this.sessions.store.preferences(),
      cached = (prefs.projectGit as Record<string, Record<string, unknown>> | undefined)?.[
        scope.projectId
      ];
    const git = cached
      ? {
          branch: cached.branch,
          repository: cached.repository,
          detached: cached.detached,
          dirty: cached.dirty,
          changed: cached.changed,
          checkedAt: cached.checkedAt,
          error: cached.error,
        }
      : undefined;
    const context = boundContext({
      project: scope.name,
      previousReport: previous
        ? { id: previous.id, periodTo: previous.periodTo, body: previous.body.slice(0, 4000) }
        : null,
      observedOnly: true,
      counts,
      turns,
      results,
      errors,
      tasks,
      plans,
      notes,
      pins,
      ...(git ? { cachedGit: git } : {}),
    });
    return {
      watermarks,
      periodFrom: previous?.periodTo ?? 0,
      periodTo: until,
      previousReportId: previous?.id ?? null,
      context,
    };
  }
  isActive(scope: ProjectScope) {
    const c = this.current(scope);
    return active.includes(c.status) || ["queued", "preparing"].includes(c.status);
  }
  core(scope: ProjectScope) {
    return new ProjectCores(this.sessions).text(scope);
  }
}

// Keep explicit omission counts so a bounded snapshot cannot imply complete project coverage.
export function boundContext(
  value: Record<string, unknown>,
  budget = 20000,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(value));
  const omitted: Record<string, number> = {};
  for (const key of ["turns", "results", "tasks", "plans", "notes", "pins", "errors"]) {
    const rows = result[key];
    if (!Array.isArray(rows)) continue;
    while (JSON.stringify({ ...result, omitted }).length > budget && rows.length) {
      rows.pop();
      omitted[key] = (omitted[key] ?? 0) + 1;
    }
  }
  if (JSON.stringify({ ...result, omitted }).length > budget && result.previousReport?.body) {
    result.previousReport.body = result.previousReport.body.slice(0, 1000);
    omitted.previousReport = 1;
  }
  return { ...result, ...(Object.keys(omitted).length ? { omitted } : {}) };
}
