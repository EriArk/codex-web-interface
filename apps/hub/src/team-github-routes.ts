import { githubWorkQuerySchema, teamGitHubSourceSchema } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TeamGitHub } from "./team-github.js";

export function registerTeamGitHub(
  app: FastifyInstance,
  github: TeamGitHub,
  actor: (req: FastifyRequest) => string,
) {
  const base = "/api/team/projects/:projectId/github",
    uuid = z.string().uuid(),
    project = (req: FastifyRequest) => z.object({ projectId: uuid }).parse(req.params).projectId,
    id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id,
    key = (req: FastifyRequest) => uuid.parse(req.headers["idempotency-key"]),
    confirm = (body: unknown) =>
      z
        .object({ confirm: z.literal(true) })
        .strict()
        .parse(body),
    limited = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.addHook("onSend", async (req, reply, payload) => {
    if (
      /^\/api\/team\/projects\/[^/]+\/github(?:\/|\?|$)/.test(req.url) &&
      reply.statusCode < 400
    ) {
      github.projects.access(actor(req), project(req));
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });
  app.get(base, (req) =>
    github.page(
      actor(req),
      project(req),
      z
        .object({ offset: z.coerce.number().int().min(0).max(5000).default(0) })
        .strict()
        .parse(req.query).offset,
    ),
  );
  app.post(base + "/observe", limited, async (req) => {
    const v = await github.observe(actor(req), project(req), githubWorkQuerySchema.parse(req.body));
    return { id: v.id, value: v.value };
  });
  app.post(base + "/identity", limited, (req) => {
    const b = z
      .object({ observationId: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return github.confirmIdentity(actor(req), project(req), b.observationId, key(req));
  });
  app.post(base + "/source", (req) =>
    github.source(actor(req), project(req), teamGitHubSourceSchema.parse(req.body)),
  );
  app.put(base + "/operations/:id", limited, (req) =>
    github.prepare(actor(req), project(req), id(req), req.body),
  );
  app.get(base + "/operations/:id", (req) => github.get(actor(req), project(req), id(req)));
  app.post(base + "/operations/:id/discard", limited, (req) => {
    confirm(req.body);
    return github.discard(actor(req), project(req), id(req));
  });
  app.post(base + "/operations/:id/confirm", limited, (req) => {
    confirm(req.body);
    return github.confirm(actor(req), project(req), id(req));
  });
  app.post(base + "/operations/:id/status", limited, (req) => {
    confirm(req.body);
    return github.status(actor(req), project(req), id(req));
  });
  app.post(base + "/links", (req) =>
    github.link(
      actor(req),
      project(req),
      key(req),
      z
        .object({
          observationId: z.string().regex(/^[a-f0-9]{64}$/),
          source: teamGitHubSourceSchema.optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.post(base + "/links/:id/work", (req) => {
    const body = z
      .object({ confirm: z.literal(true), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    return github.work(actor(req), project(req), id(req), key(req), body.fingerprint);
  });
}
