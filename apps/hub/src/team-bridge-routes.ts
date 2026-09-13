import { projectScopeSchema, teamBridgeFields } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TeamBridgeRuns } from "./team-bridge-runs.js";
import type { TeamBridgeSources } from "./team-bridge-sources.js";
import type { TeamBridges } from "./team-bridges.js";

export function registerTeamBridges(
  app: FastifyInstance,
  rooms: TeamBridges,
  runs: TeamBridgeRuns,
  actor: (req: FastifyRequest) => string,
  sources: TeamBridgeSources,
) {
  const uuid = z.string().uuid(),
    base = "/api/team/bridges",
    id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id,
    key = (req: FastifyRequest) => uuid.parse(req.headers["idempotency-key"]),
    rev = z.number().int().positive();
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith(base) && reply.statusCode < 400) actor(req);
    return payload;
  });
  app.get(base, (req) => {
    const q = z
      .object({ projectId: uuid, offset: z.coerce.number().int().min(0).max(10000).default(0) })
      .strict()
      .parse(req.query);
    return rooms.page(actor(req), q.projectId, q.offset);
  });
  app.get(base + "/invitations", (req) => ({ items: rooms.invitations(actor(req)) }));
  app.get(base + "/:id", (req) => {
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        filter: z.enum(["all", "question", "decision", "work"]).default("all"),
      })
      .strict()
      .parse(req.query);
    return {
      ...rooms.get(actor(req), id(req), q.before, q.filter),
      run: runs.view(actor(req), id(req)),
    };
  });
  app.get(base + "/:id/source", (req) => runs.source(actor(req), id(req)));
  const sourceKind = z.enum(["note", "plan", "review", "report"]);
  app.get(base + "/:id/sources", (req) => {
    const q = projectScopeSchema
      .extend({ kind: sourceKind, offset: z.coerce.number().int().min(0).max(5000).default(0) })
      .parse(req.query);
    return sources.list(
      actor(req),
      id(req),
      { client: q.client, projectId: q.projectId, name: q.name },
      q.kind,
      q.offset,
    );
  });
  app.post(base + "/:id/source-preview", (req) =>
    sources.prepare(
      actor(req),
      id(req),
      key(req),
      z
        .object({ scope: projectScopeSchema, kind: sourceKind, id: z.string().min(1).max(200) })
        .strict()
        .parse(req.body),
    ),
  );
  app.get(base + "/:id/entries/:entryId/source", (req) =>
    sources.entry(actor(req), id(req), z.object({ entryId: uuid }).parse(req.params).entryId),
  );
  app.put(base + "/:id", (req) => {
    const b = teamBridgeFields.extend({ projectId: uuid }).parse(req.body),
      { projectId, ...fields } = b;
    return rooms.create(actor(req), projectId, id(req), fields);
  });
  app.patch(base + "/:id", (req) =>
    rooms.edit(
      actor(req),
      id(req),
      key(req),
      teamBridgeFields.extend({ revision: rev }).parse(req.body),
    ),
  );
  app.post(base + "/:id/invite", (req) =>
    rooms.invite(
      actor(req),
      id(req),
      key(req),
      z.object({ revision: rev, linkId: uuid }).strict().parse(req.body),
    ),
  );
  app.post(base + "/:id/answer", (req) =>
    rooms.answer(
      actor(req),
      id(req),
      key(req),
      z.object({ revision: rev, accept: z.boolean() }).strict().parse(req.body),
    ),
  );
  app.post(base + "/:id/entries", (req) => rooms.post(actor(req), id(req), key(req), req.body));
  app.post(base + "/:id/entries/:entryId/plan", (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return rooms.workPlan(
      actor(req),
      id(req),
      z.object({ entryId: uuid }).parse(req.params).entryId,
      key(req),
    );
  });
  app.post(base + "/:id/action", (req) =>
    rooms.action(
      actor(req),
      id(req),
      key(req),
      z
        .object({ revision: rev, action: z.enum(["stop", "resolve", "reopen", "adopt"]) })
        .strict()
        .parse(req.body),
    ),
  );
  app.post(base + "/:id/prepare", (req) =>
    runs.prepare(
      actor(req),
      id(req),
      key(req),
      z.object({ revision: rev }).strict().parse(req.body).revision,
    ),
  );
  app.post(base + "/:id/confirm", (req) =>
    runs.confirm(
      actor(req),
      id(req),
      z
        .object({ runId: uuid, confirm: z.literal(true) })
        .strict()
        .parse(req.body).runId,
      key(req),
    ),
  );
}
