import {
  HubError,
  type NotebookScope,
  type NotebookTarget,
  type TaskProject,
  type TaskProjectsPage,
  type TaskRecord,
  type TasksPage,
  type TaskWrite,
  taskDueSchema,
  taskStatusSchema,
  taskWriteSchema,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Notebook } from "./notebook.js";
import type { Sessions } from "./sessions.js";

const normalized = (s: string) => s.normalize("NFKC").toLocaleLowerCase("ru");
const scopeKey = (s: NotebookScope) => (s ? `${s.client}:${s.projectId}` : "global");
const content = (t: TaskWrite) =>
  JSON.stringify({
    scope: t.scope,
    title: t.title,
    body: t.body,
    links: t.links,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt,
  });
export class WorkspaceTasks {
  readonly notebook: Notebook;
  constructor(readonly sessions: Sessions) {
    this.notebook = new Notebook(sessions);
  }
  private get db() {
    return this.sessions.store.db;
  }
  private record(row: Record<string, unknown>): TaskRecord {
    const links = JSON.parse(String(row.links)) as NotebookTarget[];
    return {
      id: String(row.id),
      scope: row.scope ? JSON.parse(String(row.scope)) : null,
      title: String(row.title),
      body: String(row.body),
      links,
      resolvedLinks: links.map((t) => this.notebook.resolve(t)),
      revision: Number(row.revision),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      status: row.status as TaskRecord["status"],
      priority: Number(row.priority),
      dueAt: row.dueAt ? String(row.dueAt) : null,
      completedAt: row.completedAt ? Number(row.completedAt) : null,
    };
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM workspace_tasks WHERE id=?").get(id);
    if (!row) throw new HubError(404, "TASK_NOT_FOUND", "Задача удалена или не найдена.");
    return this.record(row);
  }
  list(
    scope: string,
    filter: string,
    q: string,
    offset: number,
    today: string,
    limit = 30,
  ): TasksPage {
    const query =
      "%" +
      normalized(q).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_") +
      "%";
    const rows = this.db
      .prepare(
        "SELECT id,scope,title,substr(body,1,160) AS excerpt,revision,createdAt,updatedAt,status,priority,dueAt,completedAt FROM workspace_tasks WHERE (?='all' OR scopeKey=?) AND (?='all' OR (?='open' AND status!='done') OR (?='today' AND status!='done' AND dueAt<=?) OR status=?) AND search LIKE ? ESCAPE '\\' ORDER BY CASE WHEN status='done' THEN 1 ELSE 0 END, CASE WHEN status='done' THEN completedAt ELSE 0 END DESC, priority DESC, dueAt IS NULL, dueAt ASC,updatedAt DESC,id LIMIT ? OFFSET ?",
      )
      .all(scope, scope, filter, filter, filter, today, filter, query, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: String(row.id),
        scope: row.scope ? JSON.parse(String(row.scope)) : null,
        title: String(row.title),
        excerpt: String(row.excerpt),
        revision: Number(row.revision),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        status: row.status as TaskRecord["status"],
        priority: Number(row.priority),
        dueAt: row.dueAt ? String(row.dueAt) : null,
        completedAt: row.completedAt ? Number(row.completedAt) : null,
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  projects(offset = 0): TaskProjectsPage {
    const projects = new Map<string, TaskProject>();
    // One saved association per project, independent of the visible task page.
    const saved = this.db
      .prepare(
        "SELECT scope FROM (SELECT scope,row_number() OVER (PARTITION BY scopeKey ORDER BY updatedAt DESC,id) AS n FROM workspace_tasks WHERE scope IS NOT NULL) WHERE n=1 LIMIT 5000",
      )
      .all();
    for (const row of saved) {
      const scope = JSON.parse(String(row.scope)) as NonNullable<NotebookScope>;
      projects.set(scopeKey(scope), {
        scope,
        availability: scope.client === "codex" ? "missing" : "unknown",
      });
    }
    const referenced = new Set(projects.keys());
    for (const p of this.sessions.catalog.projects()) {
      if (p.unassigned) continue;
      const scope = { client: "codex" as const, projectId: p.id, name: p.name };
      projects.set(scopeKey(scope), { scope, availability: "available" });
    }
    for (const row of this.db
      .prepare(
        "SELECT client,id,value FROM library_entities WHERE kind='project' ORDER BY client,id LIMIT 5000",
      )
      .all()) {
      const entry = JSON.parse(String(row.value)),
        key = `${row.client}:${row.id}`;
      if (entry.deleted && !referenced.has(key)) {
        projects.delete(key);
        continue;
      }
      const previous = projects.get(key);
      // Hidden/deleted entries without tasks do not clutter the task picker.
      if (!previous && (entry.deleted || row.client === "codex")) continue;
      const scope = {
        client: row.client as "codex" | "gpt",
        projectId: String(row.id),
        name: entry.name || previous?.scope.name || String(row.id),
      };
      projects.set(key, {
        scope,
        availability: entry.deleted
          ? "missing"
          : entry.archived
            ? "archived"
            : (previous?.availability ?? "unknown"),
      });
    }
    const items = [...projects.values()].sort(
      (a, b) =>
        a.scope.name.localeCompare(b.scope.name, "ru") ||
        scopeKey(a.scope).localeCompare(scopeKey(b.scope)),
    );
    return {
      items: items.slice(offset, offset + 100),
      nextOffset: items.length > offset + 100 ? offset + 100 : null,
    };
  }
  save(id: string, input: TaskWrite) {
    const row = this.db.prepare("SELECT * FROM workspace_tasks WHERE id=?").get(id),
      current = row ? this.record(row) : null;
    if (current) {
      if (content(current) === content(input)) return current;
      if (input.revision !== current.revision)
        throw new HubError(
          409,
          "TASK_CONFLICT",
          "Задача изменилась на другом устройстве. Черновик сохранён.",
        );
    } else {
      if (input.revision !== 0)
        throw new HubError(
          409,
          "TASK_DELETED",
          "Задача удалена. Можно сохранить черновик как новую.",
        );
      if (Number(this.db.prepare("SELECT count(*) AS n FROM workspace_tasks").get()?.n) >= 5000)
        throw new HubError(409, "TASKS_LIMIT", "Достигнут лимит задач: 5000.");
    }
    const now = Date.now(),
      completedAt =
        input.status === "done"
          ? current?.status === "done"
            ? (current.completedAt ?? now)
            : now
          : null;
    this.db
      .prepare(
        "INSERT INTO workspace_tasks(id,scopeKey,scope,title,body,search,links,revision,createdAt,updatedAt,status,priority,dueAt,completedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scopeKey=excluded.scopeKey,scope=excluded.scope,title=excluded.title,body=excluded.body,search=excluded.search,links=excluded.links,revision=excluded.revision,updatedAt=excluded.updatedAt,status=excluded.status,priority=excluded.priority,dueAt=excluded.dueAt,completedAt=excluded.completedAt",
      )
      .run(
        id,
        scopeKey(input.scope),
        input.scope ? JSON.stringify(input.scope) : null,
        input.title,
        input.body,
        normalized(input.title + "\n" + input.body),
        JSON.stringify(input.links),
        (current?.revision ?? 0) + 1,
        current?.createdAt ?? now,
        now,
        input.status,
        input.priority,
        input.dueAt,
        completedAt,
      );
    return this.get(id);
  }
  status(id: string, status: TaskWrite["status"], revision: number) {
    const current = this.get(id);
    if (current.status === status) return current;
    return this.save(id, { ...current, status, revision });
  }
  remove(id: string, revision: number) {
    const row = this.db.prepare("SELECT revision FROM workspace_tasks WHERE id=?").get(id);
    if (!row) return { ok: true };
    if (Number(row.revision) !== revision)
      throw new HubError(409, "TASK_CONFLICT", "Задача изменилась. Открой её перед удалением.");
    this.db.prepare("DELETE FROM workspace_tasks WHERE id=?").run(id);
    return { ok: true };
  }
}
export function registerWorkspaceTasks(app: FastifyInstance, sessions: Sessions) {
  const tasks = new WorkspaceTasks(sessions),
    ids = z.object({ id: z.string().uuid() });
  app.get("/api/workspace/tasks", (req) => {
    const q = z
      .object({
        scope: z
          .string()
          .regex(/^(?:all|global|(?:codex|gpt):[a-zA-Z0-9_-]{1,100})$/)
          .default("all"),
        filter: z
          .enum(["all", "open", "today", "todo", "doing", "blocked", "done"])
          .default("open"),
        q: z.string().max(200).default(""),
        offset: z.coerce.number().int().min(0).max(5000).default(0),
        today: taskDueSchema.default(null),
      })
      .strict()
      .parse(req.query);
    if (q.filter === "today" && !q.today)
      throw new HubError(400, "TASK_DATE_REQUIRED", "Нужна локальная дата для списка на сегодня.");
    return tasks.list(q.scope, q.filter, q.q, q.offset, q.today ?? "");
  });
  app.get("/api/workspace/tasks/projects", (req) => {
    const q = z
      .object({ offset: z.coerce.number().int().min(0).max(15000).default(0) })
      .strict()
      .parse(req.query);
    return tasks.projects(q.offset);
  });
  app.get("/api/workspace/tasks/:id", (req) => tasks.get(ids.parse(req.params).id));
  app.put("/api/workspace/tasks/:id", (req) =>
    tasks.save(ids.parse(req.params).id, taskWriteSchema.parse(req.body)),
  );
  app.patch("/api/workspace/tasks/:id/status", (req) => {
    const q = z
      .object({ status: taskStatusSchema, revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return tasks.status(ids.parse(req.params).id, q.status, q.revision);
  });
  app.delete("/api/workspace/tasks/:id", (req) => {
    const q = z
      .object({ revision: z.number().int().positive(), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return tasks.remove(ids.parse(req.params).id, q.revision);
  });
  return tasks;
}
