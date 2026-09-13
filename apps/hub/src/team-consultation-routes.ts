import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TeamConsultations } from "./team-consultations.js";
export function registerTeamConsultations(
  app: FastifyInstance,
  service: TeamConsultations,
  actor: (req: FastifyRequest) => string,
) {
  const uuid = z.string().uuid(),
    base = "/api/team/projects/:projectId/consultations",
    project = (req: FastifyRequest) => z.object({ projectId: uuid }).parse(req.params).projectId,
    id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id,
    key = (req: FastifyRequest) => uuid.parse(req.headers["idempotency-key"]);
  app.get(base, (req) =>
    service.page(
      actor(req),
      project(req),
      z
        .object({ offset: z.coerce.number().int().min(0).max(10000).default(0) })
        .strict()
        .parse(req.query).offset,
    ),
  );
  app.get(base + "/:id", (req) => service.get(actor(req), project(req), id(req)));
  app.get(base + "/:id/source", (req) => service.source(actor(req), project(req), id(req)));
  app.put(base + "/:id", (req) => {
    const b = z
      .object({
        linkId: uuid,
        title: z.string(),
        question: z.string(),
        kind: z.enum(["consult", "work"]),
      })
      .strict()
      .parse(req.body);
    return service.create(actor(req), id(req), { ...b, projectId: project(req) });
  });
  app.post(base + "/:id/action", (req) =>
    service.action(
      actor(req),
      project(req),
      id(req),
      key(req),
      z
        .object({
          revision: z.number().int().positive(),
          action: z.enum(["approve", "stop", "retry"]),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.post(base + "/:id/plan", (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return service.workPlan(actor(req), project(req), id(req), key(req));
  });
}
