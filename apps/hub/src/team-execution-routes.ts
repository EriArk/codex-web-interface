import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TeamExecutions } from "./team-executions.js";

export function registerTeamExecutions(
  app: FastifyInstance,
  executions: TeamExecutions,
  actor: (req: FastifyRequest) => string,
) {
  const uuid = z.string().uuid(),
    params = z.object({ id: uuid, executionId: uuid }),
    confirm = z.object({ confirm: z.literal(true) }).strict();
  app.get("/api/team/projects/:id/executions", (req) => {
    const projectId = z.object({ id: uuid }).parse(req.params).id,
      query = z.object({ itemId: uuid }).strict().parse(req.query);
    return executions.list(actor(req), projectId, query.itemId);
  });
  app.put("/api/team/projects/:id/executions/:executionId", (req) => {
    const p = params.parse(req.params),
      body = z
        .object({ itemId: uuid, revision: z.number().int().positive() })
        .strict()
        .parse(req.body);
    return executions.prepare(actor(req), p.id, body.itemId, p.executionId, body.revision);
  });
  app.get("/api/team/projects/:id/executions/:executionId", (req) => {
    const p = params.parse(req.params);
    return executions.detail(actor(req), p.id, p.executionId);
  });
  app.post("/api/team/projects/:id/executions/:executionId/submit", (req) => {
    const p = params.parse(req.params);
    confirm.parse(req.body);
    return executions.submit(actor(req), p.id, p.executionId);
  });
  app.post("/api/team/projects/:id/executions/:executionId/cancel", (req) => {
    const p = params.parse(req.params);
    confirm.parse(req.body);
    return executions.cancel(actor(req), p.id, p.executionId);
  });
}
