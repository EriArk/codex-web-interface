import {
  HubError,
  type PlanPage,
  type PlanSummary,
  type PlanWrite,
  type ProjectAction,
  type ProjectPlan,
} from "@codex-web/shared";
import { projectKey } from "./project-core.js";
import type { Sessions } from "./sessions.js";
export class ProjectPlans {
  constructor(readonly sessions: Sessions) {}
  private get db() {
    return this.sessions.store.db;
  }
  get(id: string): ProjectPlan {
    const row = this.db.prepare("SELECT * FROM project_plans WHERE id=?").get(id);
    if (!row) throw new HubError(404, "PLAN_MISSING", "План удалён или не найден.");
    const run = this.db
      .prepare(
        "SELECT value FROM project_work_actions WHERE planId=? ORDER BY createdAt DESC,id DESC LIMIT 1",
      )
      .get(id);
    return {
      ...JSON.parse(String(row.value)),
      scope: JSON.parse(String(row.scope)),
      revision: Number(row.revision),
      id,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      ...(run ? { latestAction: JSON.parse(String(run.value)) as ProjectAction } : {}),
    };
  }
  list(scope: string, query: string, offset = 0): PlanPage {
    const rows = this.db
      .prepare(
        "SELECT id,scope,json_extract(value,'$.title') title,substr(json_extract(value,'$.description'),1,160) excerpt,json_extract(value,'$.status') status,revision,createdAt,updatedAt FROM project_plans WHERE (?='all' OR scopeKey=?) AND instr(search,?)>0 ORDER BY updatedAt DESC,id LIMIT 31 OFFSET ?",
      )
      .all(scope, scope, query.normalize("NFKC").toLocaleLowerCase("ru"), offset);
    return {
      items: rows.slice(0, 30).map((row) => {
        const plan = this.get(String(row.id)),
          items = plan.sections.flatMap((s) => s.items);
        const {
          text: _text,
          snapshot: _snapshot,
          ...run
        } = plan.latestAction ?? ({} as ProjectAction);
        return {
          id: plan.id,
          scope: plan.scope,
          title: plan.title,
          excerpt: String(row.excerpt ?? ""),
          status: plan.status,
          revision: plan.revision,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          checked: items.filter((i) => i.checked).length,
          total: items.length,
          ...(plan.latestAction ? { latestAction: run } : {}),
        } as PlanSummary;
      }),
      nextOffset: rows.length > 30 ? offset + 30 : null,
    };
  }
  save(id: string, input: PlanWrite): ProjectPlan {
    const row = this.db.prepare("SELECT * FROM project_plans WHERE id=?").get(id),
      value = JSON.stringify({ ...input, revision: undefined });
    if (row && row.scopeKey !== projectKey(input.scope))
      throw new HubError(
        409,
        "PLAN_PROJECT_CHANGED",
        "План принадлежит другому проекту. Сохрани копию в выбранном проекте.",
      );
    if (row && row.value === value) return this.get(id);
    if ((row ? Number(row.revision) : 0) !== input.revision)
      throw new HubError(
        409,
        row ? "PLAN_CONFLICT" : "PLAN_DELETED",
        row
          ? "План изменился на другом устройстве. Черновик сохранён."
          : "План удалён. Можно сохранить черновик как новый.",
      );
    if (!row && Number(this.db.prepare("SELECT count(*) n FROM project_plans").get()?.n) >= 2000)
      throw new HubError(409, "PLANS_LIMIT", "Достигнут лимит планов: 2000.");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO project_plans VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scopeKey=excluded.scopeKey,scope=excluded.scope,value=excluded.value,search=excluded.search,revision=excluded.revision,updatedAt=excluded.updatedAt",
      )
      .run(
        id,
        projectKey(input.scope),
        JSON.stringify(input.scope),
        value,
        (input.title + "\n" + input.description).normalize("NFKC").toLocaleLowerCase("ru"),
        input.revision + 1,
        Number(row?.createdAt ?? now),
        now,
      );
    return this.get(id);
  }
  remove(id: string, revision: number) {
    const row = this.db.prepare("SELECT revision FROM project_plans WHERE id=?").get(id);
    if (!row) return { ok: true };
    if (Number(row.revision) !== revision)
      throw new HubError(409, "PLAN_CONFLICT", "План изменился. Открой его перед удалением.");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM project_work_actions WHERE planId=? AND state IN ('dispatching','queued','running','unknown') LIMIT 1",
        )
        .get(id)
    )
      throw new HubError(
        409,
        "PLAN_ACTIVE",
        "Сначала дождись завершения или проверь отправку плана.",
      );
    this.db.prepare("DELETE FROM project_plans WHERE id=?").run(id);
    return { ok: true };
  }
}
