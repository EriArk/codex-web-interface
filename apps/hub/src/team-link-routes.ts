import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TeamLinks } from "./team-links.js";

export function registerTeamLinks(
  app: FastifyInstance,
  links: TeamLinks,
  actor: (req: FastifyRequest) => string,
) {
  const uuid = z.string().uuid(),
    params = z.object({ id: uuid }),
    key = (req: FastifyRequest) => uuid.parse(req.headers["idempotency-key"]);
  app.get("/api/team/contacts", (req) => {
    const userId = actor(req),
      q = z
        .object({
          q: z.string().trim().max(100).default(""),
          offset: z.coerce.number().int().min(0).max(1000).default(0),
        })
        .strict()
        .parse(req.query);
    const search = q.q.normalize("NFKC").toLocaleLowerCase("ru");
    const rows = links.db
      .prepare("SELECT id,name FROM team_users WHERE state='active' ORDER BY name,id LIMIT 1000")
      .all()
      .filter((r) => String(r.name).normalize("NFKC").toLocaleLowerCase("ru").includes(search))
      .slice(q.offset, q.offset + 21);
    return {
      items: rows.slice(0, 20).map((r) => ({ id: r.id, name: r.name, own: r.id === userId })),
      nextOffset: rows.length > 20 ? q.offset + 20 : null,
    };
  });
  app.get("/api/team/link-invitations", (req) => links.invitations(actor(req)));
  app.get("/api/team/projects/:id/links", (req) => {
    const q = z
      .object({ offset: z.coerce.number().int().min(0).max(10000).default(0) })
      .strict()
      .parse(req.query);
    return links.page(actor(req), params.parse(req.params).id, q.offset);
  });
  app.put("/api/team/links/:id", (req) =>
    links.propose(actor(req), params.parse(req.params).id, req.body),
  );
  app.post("/api/team/links/:id/answer", (req) =>
    links.answer(
      actor(req),
      params.parse(req.params).id,
      key(req),
      z
        .object({
          revision: z.number().int().positive(),
          accept: z.boolean(),
          projectId: uuid.optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.post("/api/team/links/:id/revoke", (req) => {
    const b = z
      .object({ projectId: uuid, revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return links.revoke(actor(req), b.projectId, params.parse(req.params).id, key(req), b.revision);
  });
}
