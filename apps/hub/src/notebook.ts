import { createHash } from "node:crypto";
import {
  HubError,
  type NotebookLink,
  type NotebookPin,
  type NotebookScope,
  type NotebookTarget,
  type NoteRecord,
  type NotesPage,
  type NoteWrite,
  notebookScopeSchema,
  notebookTargetSchema,
  noteWriteSchema,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";

type Row = Record<string, unknown>;
const scopeKey = (scope: NotebookScope) =>
  scope ? `${scope.client}:${scope.projectId}` : "global";
const targetKey = (target: NotebookTarget) =>
  JSON.stringify([target.client, target.kind, target.id, target.threadId ?? ""]);
const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru");
export class Notebook {
  constructor(readonly sessions: Sessions) {}
  private get db() {
    return this.sessions.store.db;
  }
  resolve(target: NotebookTarget): NotebookLink {
    let availability: NotebookLink["availability"] = "unknown";
    if (target.kind === "task") {
      const task = this.db
        .prepare("SELECT title,scope FROM workspace_tasks WHERE id=?")
        .get(target.id);
      return {
        ...target,
        ...(task ? { title: String(task.title) } : {}),
        availability: task ? "available" : "missing",
      };
    }
    if (target.kind === "note") {
      const note = this.db
        .prepare("SELECT title,scope FROM workspace_notes WHERE id=?")
        .get(target.id);
      return {
        ...target,
        ...(note ? { title: String(note.title) } : {}),
        availability: note ? "available" : "missing",
      };
    }
    if (target.client === "codex") {
      if (target.kind === "project") {
        const project = this.sessions.catalog.projects().find((p) => p.id === target.id);
        availability =
          project && !this.sessions.catalog.library.get("project", target.id)?.deleted
            ? "available"
            : "missing";
        return {
          ...target,
          ...(project ? { title: project.name, projectId: project.id } : {}),
          availability,
        };
      }
      const thread =
        target.kind === "thread"
          ? this.db.prepare("SELECT * FROM threads WHERE id=?").get(target.id)
          : target.threadId
            ? this.db.prepare("SELECT * FROM threads WHERE id=?").get(target.threadId)
            : undefined;
      if (target.kind === "thread") {
        availability = thread ? "available" : "missing";
        if (
          thread &&
          this.sessions.catalog.library.get("thread", String(thread.codexThreadId))?.deleted
        )
          availability = "missing";
        return {
          ...target,
          ...(thread
            ? {
                projectId: String(thread.projectId),
                threadId: String(thread.id),
                title: String(thread.title),
              }
            : {}),
          availability,
        };
      }
      if (target.kind === "result") {
        const result = this.db
          .prepare(
            "SELECT r.id,r.threadId,r.turnId,r.title,t.projectId FROM results r JOIN threads t ON t.id=r.threadId WHERE r.id=?",
          )
          .get(target.id);
        return {
          ...target,
          ...(result
            ? {
                threadId: String(result.threadId),
                projectId: String(result.projectId),
                turnId: result.turnId ? String(result.turnId) : undefined,
                title: String(result.title),
              }
            : {}),
          availability: result ? "available" : "missing",
        };
      }
      if (target.kind === "file")
        availability = this.sessions.catalog.projects().some((p) => p.id === target.projectId)
          ? "unknown"
          : "missing";
    } else {
      const kind = target.kind === "project" ? "project" : "thread",
        native = target.kind === "project" ? target.id : (target.threadId ?? target.id);
      const entry = this.db
        .prepare("SELECT value FROM library_entities WHERE client='gpt' AND kind=? AND id=?")
        .get(kind, native);
      if (entry && JSON.parse(String(entry.value)).deleted) availability = "missing";
      const job = this.db.prepare("SELECT nativeId FROM gpt_jobs WHERE id=?").get(native);
      if (job?.nativeId)
        return {
          ...target,
          threadId: String(job.nativeId),
          ...(target.kind === "thread" ? { id: String(job.nativeId) } : {}),
          availability,
        };
    }
    return { ...target, availability };
  }
  private note(row: Row): NoteRecord {
    const links = JSON.parse(String(row.links)) as NotebookTarget[];
    return {
      id: String(row.id),
      scope: row.scope ? JSON.parse(String(row.scope)) : null,
      title: String(row.title),
      body: String(row.body),
      links,
      resolvedLinks: links.map((link) => this.resolve(link)),
      revision: Number(row.revision),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM workspace_notes WHERE id=?").get(id);
    if (!row) throw new HubError(404, "NOTE_NOT_FOUND", "Заметка удалена или не найдена.");
    return this.note(row);
  }
  list(scope: string, query: string, offset: number, limit = 30): NotesPage {
    const search =
      "%" +
      normalized(query).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_") +
      "%";
    const rows = this.db
      .prepare(
        "SELECT id,scope,title,substr(body,1,160) AS excerpt,revision,createdAt,updatedAt FROM workspace_notes WHERE (?='all' OR scopeKey=?) AND search LIKE ? ESCAPE '\\' ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?",
      )
      .all(scope, scope, search, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: String(row.id),
        scope: row.scope ? JSON.parse(String(row.scope)) : null,
        title: String(row.title),
        excerpt: String(row.excerpt),
        revision: Number(row.revision),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  save(id: string, input: NoteWrite): NoteRecord {
    const existing = this.db.prepare("SELECT * FROM workspace_notes WHERE id=?").get(id);
    if (existing) {
      const current = this.note(existing);
      // A retry after a lost response is already saved if the complete content matches.
      if (
        JSON.stringify({
          scope: current.scope,
          title: current.title,
          body: current.body,
          links: current.links,
        }) ===
        JSON.stringify({
          scope: input.scope,
          title: input.title,
          body: input.body,
          links: input.links,
        })
      )
        return current;
      if (current.revision !== input.revision)
        throw new HubError(
          409,
          "NOTE_CONFLICT",
          "Заметка изменилась на другом устройстве. Твой текст сохранён в черновике.",
        );
    } else {
      if (input.revision !== 0)
        throw new HubError(
          409,
          "NOTE_DELETED",
          "Заметка удалена. Можно сохранить черновик как новую.",
        );
      if (Number(this.db.prepare("SELECT count(*) AS n FROM workspace_notes").get()?.n) >= 1000)
        throw new HubError(409, "NOTES_LIMIT", "Достигнут лимит заметок: 1000.");
    }
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO workspace_notes(id,scopeKey,scope,title,body,search,links,revision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scopeKey=excluded.scopeKey,scope=excluded.scope,title=excluded.title,body=excluded.body,search=excluded.search,links=excluded.links,revision=excluded.revision,updatedAt=excluded.updatedAt",
      )
      .run(
        id,
        scopeKey(input.scope),
        input.scope ? JSON.stringify(input.scope) : null,
        input.title,
        input.body,
        normalized(input.title + "\n" + input.body),
        JSON.stringify(input.links),
        Number(existing?.revision ?? 0) + 1,
        Number(existing?.createdAt ?? now),
        now,
      );
    return this.get(id);
  }
  remove(id: string, revision: number) {
    const row = this.db.prepare("SELECT revision FROM workspace_notes WHERE id=?").get(id);
    if (!row) return { ok: true };
    if (Number(row.revision) !== revision)
      throw new HubError(409, "NOTE_CONFLICT", "Заметка изменилась. Открой её перед удалением.");
    this.db.prepare("DELETE FROM workspace_notes WHERE id=?").run(id);
    return { ok: true };
  }
  pinId(scope: NotebookScope, target: NotebookTarget) {
    return createHash("sha256")
      .update(scopeKey(scope) + "\n" + targetKey(target))
      .digest("hex");
  }
  pinned(scope: NotebookScope, target: NotebookTarget) {
    return !!this.db
      .prepare("SELECT 1 FROM workspace_pins WHERE id=?")
      .get(this.pinId(scope, target));
  }
  pin(scope: NotebookScope, target: NotebookTarget, value: boolean) {
    const id = this.pinId(scope, target);
    if (value) {
      if (
        !this.pinned(scope, target) &&
        Number(this.db.prepare("SELECT count(*) AS n FROM workspace_pins").get()?.n) >= 2000
      )
        throw new HubError(409, "PINS_LIMIT", "Достигнут лимит сохранённых ссылок: 2000.");
      this.db
        .prepare(
          "INSERT INTO workspace_pins(id,scopeKey,scope,targetKey,target,createdAt) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target=excluded.target",
        )
        .run(
          id,
          scopeKey(scope),
          scope ? JSON.stringify(scope) : null,
          targetKey(target),
          JSON.stringify(target),
          Date.now(),
        );
    } else this.db.prepare("DELETE FROM workspace_pins WHERE id=?").run(id);
    return { id, pinned: value };
  }
  pins(scope: string, offset: number, limit = 30) {
    const rows = this.db
      .prepare(
        "SELECT * FROM workspace_pins WHERE (?='all' OR scopeKey=?) ORDER BY createdAt DESC,id LIMIT ? OFFSET ?",
      )
      .all(scope, scope, limit + 1, offset);
    const items: NotebookPin[] = rows.slice(0, limit).map((row) => ({
      id: String(row.id),
      scope: row.scope ? JSON.parse(String(row.scope)) : null,
      target: this.resolve(JSON.parse(String(row.target))),
      createdAt: Number(row.createdAt),
      pinned: true,
    }));
    return { items, nextOffset: rows.length > limit ? offset + limit : null };
  }
}
export function registerNotebook(app: FastifyInstance, sessions: Sessions) {
  const book = new Notebook(sessions),
    id = z.object({ id: z.string().uuid() });
  const scope = z
    .string()
    .regex(/^(?:global|all|(?:codex|gpt):[a-zA-Z0-9_-]{1,100})$/)
    .default("all");
  const page = z
    .object({ scope, offset: z.coerce.number().int().min(0).max(2000).default(0) })
    .strict();
  app.get("/api/workspace/notes", (req) => {
    const q = page.extend({ q: z.string().max(200).default("") }).parse(req.query);
    return book.list(q.scope, q.q, q.offset);
  });
  app.get("/api/workspace/notes/:id", (req) => book.get(id.parse(req.params).id));
  app.put("/api/workspace/notes/:id", (req) =>
    book.save(id.parse(req.params).id, noteWriteSchema.parse(req.body)),
  );
  app.delete("/api/workspace/notes/:id", (req) => {
    const body = z
      .object({ revision: z.number().int().positive(), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return book.remove(id.parse(req.params).id, body.revision);
  });
  app.get("/api/workspace/pins", (req) => {
    const q = page.parse(req.query);
    return book.pins(q.scope, q.offset);
  });
  app.post("/api/workspace/pins/status", (req) => {
    const body = z
      .object({ scope: notebookScopeSchema, target: notebookTargetSchema })
      .strict()
      .parse(req.body);
    return { pinned: book.pinned(body.scope, body.target) };
  });
  app.put("/api/workspace/pins", (req) => {
    const body = z
      .object({ scope: notebookScopeSchema, target: notebookTargetSchema, value: z.boolean() })
      .strict()
      .parse(req.body);
    return book.pin(body.scope, body.target, body.value);
  });
  app.post("/api/workspace/resolve", (req) => book.resolve(notebookTargetSchema.parse(req.body)));
  return book;
}
