import {
  actionPrepareSchema,
  HubError,
  type NotebookTarget,
  planWriteSchema,
  projectScopeSchema,
  reviewDecisionSchema,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GptService } from "./gpt.js";
import { Notebook } from "./notebook.js";
import { ProjectActions } from "./project-actions.js";
import type { QueueService } from "./queue.js";
import type { Sessions } from "./sessions.js";
export function registerProjectWork(
  app: FastifyInstance,
  sessions: Sessions,
  gpt: GptService,
  queue: QueueService,
) {
  const actions = new ProjectActions(sessions, gpt, queue),
    id = z.object({ id: z.string().uuid() }),
    confirm = z.object({ confirm: z.literal(true) }).strict();
  const page = z
    .object({
      scope: z
        .string()
        .regex(/^(?:all|(?:codex|gpt):[a-zA-Z0-9_-]{1,100})$/)
        .default("all"),
      offset: z.coerce.number().int().min(0).max(10000).default(0),
    })
    .strict();
  app.get("/api/workspace/reviews", (req) => {
    const q = page.extend({ threadId: z.string().max(100).default("") }).parse(req.query);
    actions.synchronize();
    // Bounded backfill also catches terminal-before-final projection ordering and old work.
    for (const row of sessions.store.db
      .prepare(
        "SELECT value FROM project_work_actions WHERE state='completed' AND kind IN ('plan','correction') AND (?='all' OR scopeKey=?) AND NOT EXISTS(SELECT 1 FROM work_reviews r WHERE r.id=project_work_actions.id) ORDER BY createdAt DESC LIMIT 30",
      )
      .all(q.scope, q.scope)) {
      try {
        actions.reviews.capture(JSON.parse(String(row.value)));
      } catch {}
    }
    return actions.reviews.list(q.scope, q.offset, q.threadId);
  });
  app.get("/api/workspace/reviews/:id", (req) => {
    const key = id.parse(req.params).id;
    try {
      actions.get(key);
    } catch {}
    const review = actions.reviews.get(key),
      current = actions.context.current(review.scope);
    const row = sessions.store.db
      .prepare(
        "SELECT id FROM project_work_actions WHERE kind='correction' AND json_extract(value,'$.reviewId')=? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(key);
    return {
      review,
      currentThreadId: current.threadId,
      currentTitle: current.title,
      ...(row ? { correction: actions.get(String(row.id)) } : {}),
    };
  });
  app.post("/api/workspace/reviews/:id/decision", (req) =>
    actions.reviews.decide(id.parse(req.params).id, reviewDecisionSchema.parse(req.body)),
  );
  app.get("/api/workspace/plans", (req) => {
    const q = page.extend({ q: z.string().max(200).default("") }).parse(req.query);
    return actions.plans.list(q.scope, q.q, q.offset);
  });
  app.get("/api/workspace/plans/:id", (req) => {
    actions.synchronize();
    return actions.plans.get(id.parse(req.params).id);
  });
  app.put("/api/workspace/plans/:id", (req) =>
    actions.plans.save(id.parse(req.params).id, planWriteSchema.parse(req.body)),
  );
  app.delete("/api/workspace/plans/:id", (req) => {
    const b = z
      .object({ revision: z.number().int().positive(), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return actions.plans.remove(id.parse(req.params).id, b.revision);
  });
  app.get("/api/workspace/reports", (req) => {
    const q = page.parse(req.query);
    actions.synchronize();
    return actions.context.reports(q.scope, q.offset);
  });
  app.get("/api/workspace/reports/:id", (req) => actions.context.report(id.parse(req.params).id));
  app.get("/api/workspace/references", (req) => {
    const q = projectScopeSchema
        .omit({ name: true })
        .extend({ offset: z.coerce.number().int().min(0).max(2000).default(0) })
        .parse(req.query),
      scope = { client: q.client, projectId: q.projectId, name: "Проект" },
      key = `${q.client}:${q.projectId}`;
    const book = new Notebook(sessions),
      notes = book.list(key, "", q.offset, 20),
      reports = actions.context.reports(key, q.offset),
      pins = book.pins(key, q.offset, 20);
    const items: NotebookTarget[] = [
      ...notes.items.map((n) => ({
        client: q.client,
        kind: "note" as const,
        id: n.id,
        title: n.title,
        projectId: q.projectId,
      })),
      ...reports.items.slice(0, 20).map((n) => ({
        client: q.client,
        kind: "report" as const,
        id: n.id,
        title: n.title + " · " + new Date(n.createdAt).toLocaleDateString("ru"),
        projectId: q.projectId,
      })),
      ...pins.items.map((p) => {
        const { availability: _availability, ...target } = p.target;
        return target;
      }),
    ];
    const results =
      q.client === "codex"
        ? sessions.store.db
            .prepare(
              "SELECT r.id,r.threadId,r.turnId,r.title FROM results r JOIN threads t ON t.id=r.threadId WHERE t.projectId=? ORDER BY r.rowid DESC LIMIT 21 OFFSET ?",
            )
            .all(q.projectId, q.offset)
        : [];
    items.push(
      ...results.slice(0, 20).map((r) => ({
        client: q.client,
        kind: "result" as const,
        id: String(r.id),
        title: String(r.title),
        threadId: String(r.threadId),
        ...(r.turnId ? { turnId: String(r.turnId) } : {}),
        projectId: q.projectId,
      })),
    );
    return {
      items: [...new Map(items.map((t) => [t.kind + ":" + t.id, t])).values()],
      nextOffset:
        notes.nextOffset !== null ||
        reports.items.length > 20 ||
        reports.nextOffset !== null ||
        pins.nextOffset !== null ||
        results.length > 20
          ? q.offset + 20
          : null,
    };
  });
  app.post("/api/workspace/current/restore", (req) => {
    const body = z
      .object({
        scope: projectScopeSchema,
        threadId: z.string().uuid(),
        revision: z.number().int().positive(),
        confirm: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return actions.context.restoreCurrent(body.scope, body.threadId, body.revision);
  });
  app.get("/api/workspace/current", (req) => {
    const scope = projectScopeSchema.omit({ name: true }).parse(req.query);
    return actions.context.current({ ...scope, name: "Проект" });
  });
  app.put("/api/workspace/actions/:id", (req) =>
    actions.prepare(id.parse(req.params).id, actionPrepareSchema.parse(req.body)),
  );
  app.get("/api/workspace/actions", (req) => {
    const q = page.parse(req.query);
    return actions.list(q.scope);
  });
  app.get("/api/workspace/actions/:id", (req) => actions.get(id.parse(req.params).id));
  app.post("/api/workspace/actions/:id/submit", (req) => {
    confirm.parse(req.body);
    return actions.submit(id.parse(req.params).id);
  });
  app.post("/api/workspace/actions/:id/cancel", (req) => {
    confirm.parse(req.body);
    return actions.cancel(id.parse(req.params).id);
  });
  app.post("/api/workspace/actions/:id/keep-current", (req) => {
    confirm.parse(req.body);
    return actions.keepCurrent(id.parse(req.params).id);
  });
  const timer = setInterval(() => actions.synchronize(), 3000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  return actions;
}
