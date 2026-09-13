import { inspectProject } from "@codex-web/machines";
import {
  HubError,
  type ProjectRepository,
  projectScopeSchema,
  sharedMaterialWriteSchema,
  teamLoginSchema,
} from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { createApp } from "./app.js";
import type { TeamProjects } from "./team-projects.js";
import { publicationPreview, publicationSources } from "./team-publication.js";
import { workspaceProjects } from "./workspace-projects.js";

export function registerTeamProjects(
  app: FastifyInstance,
  projects: TeamProjects,
  actor: (req: FastifyRequest) => string,
  personal: (userId: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>,
) {
  const uuid = z.string().uuid(),
    id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id;
  const key = (req: FastifyRequest) => uuid.parse(req.headers["idempotency-key"]);
  const page = z.object({ offset: z.coerce.number().int().min(0).max(5000).default(0) }).strict();
  const before = z
    .object({ before: z.coerce.number().int().positive().default(Number.MAX_SAFE_INTEGER) })
    .strict();
  const repository = z
    .string()
    .regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
    .transform((v) => v.toLowerCase())
    .nullable();
  const identity = z
    .object({ title: z.string().trim().min(1).max(120), visibility: z.enum(["private", "shared"]) })
    .strict();
  app.get("/api/team/projects", (req) => projects.list(actor(req), page.parse(req.query).offset));
  app.put("/api/team/projects/:id", (req) =>
    projects.create(
      actor(req),
      id(req),
      identity.extend({ repository: repository.default(null) }).parse(req.body),
    ),
  );
  app.get("/api/team/projects/:id", (req) => projects.detail(actor(req), id(req)));
  app.patch("/api/team/projects/:id", (req) =>
    projects.edit(
      actor(req),
      id(req),
      key(req),
      identity
        .extend({ revision: z.number().int().positive(), archived: z.boolean() })
        .parse(req.body),
    ),
  );
  app.get("/api/team/project-invitations", (req) => projects.invitations(actor(req)));
  app.post("/api/team/project-invitations/:id", (req) =>
    projects.answerInvitation(
      actor(req),
      id(req),
      key(req),
      z.object({ accept: z.boolean() }).strict().parse(req.body).accept,
    ),
  );
  app.post("/api/team/projects/:id/invitations", (req) =>
    projects.invite(
      actor(req),
      id(req),
      key(req),
      z
        .object({
          login: teamLoginSchema,
          role: z.enum(["owner", "collaborator", "viewer"]),
          revision: z.number().int().positive(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.delete("/api/team/projects/:id/invitations/:invitationId", (req) =>
    projects.revokeInvitation(
      actor(req),
      id(req),
      z.object({ invitationId: uuid }).parse(req.params).invitationId,
      key(req),
    ),
  );
  app.patch("/api/team/projects/:id/members/:userId", (req) =>
    projects.member(
      actor(req),
      id(req),
      z.object({ userId: uuid }).parse(req.params).userId,
      key(req),
      z
        .object({
          revision: z.number().int().positive(),
          role: z.enum(["collaborator", "viewer"]),
          remove: z.boolean(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.get("/api/team/personal-projects", async (req) => {
    const userId = actor(req),
      q = page.parse(req.query),
      { runtime } = await personal(userId);
    actor(req);
    return workspaceProjects(runtime.sessions, q.offset);
  });
  app.get("/api/team/project-association", (req) => {
    const query = z
      .object({ personalProjectId: z.string().min(1).max(100) })
      .strict()
      .parse(req.query);
    return { project: projects.association(actor(req), query.personalProjectId) };
  });
  const binding = new Set<string>();
  app.put("/api/team/projects/:id/checkout", async (req) => {
    const userId = actor(req),
      projectId = id(req),
      receipt = key(req);
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        personalProjectId: z.string().min(1).max(100),
      })
      .strict()
      .parse(req.body);
    projects.access(userId, projectId, "write");
    if (binding.has(userId))
      throw new HubError(409, "CHECKOUT_CHECKING", "Проверка рабочей папки уже идёт.");
    binding.add(userId);
    try {
      const { runtime } = await personal(userId),
        project = runtime.sessions.project(input.personalProjectId);
      runtime.projectWork.context.assertProject({
        client: "codex",
        projectId: project.id,
        name: project.name,
      });
      const machine = runtime.sessions.catalog.machine(project.machineId);
      const observed = (await inspectProject(machine, project.workingDirectory, {
        op: "repository",
      })) as ProjectRepository;
      actor(req);
      const remote = observed.remote;
      const canonical = remote
        ? repository.parse(`https://github.com/${remote.owner}/${remote.repo}`)
        : null;
      if (observed.repository && !canonical)
        throw new HubError(
          409,
          "REPOSITORY_IDENTITY_UNKNOWN",
          "У Git-проекта не подтверждён репозиторий GitHub. Подключи его обычным мастером проекта и повтори проверку.",
        );
      return {
        checkout: projects.bind(userId, projectId, receipt, input, {
          machineId: project.machineId,
          repository: canonical,
        }),
      };
    } finally {
      binding.delete(userId);
    }
  });
  app.get("/api/team/projects/:id/materials", (req) => {
    const q = page
      .extend({
        kind: z
          .enum(["all", "core", "note", "task", "plan", "report", "review", "result"])
          .default("all"),
        q: z.string().max(200).default(""),
      })
      .parse(req.query);
    return projects.items(actor(req), id(req), q.kind, q.q, q.offset);
  });
  const item = (req: FastifyRequest) => z.object({ itemId: uuid }).parse(req.params).itemId;
  app.get("/api/team/projects/:id/materials/:itemId", (req) =>
    projects.get(actor(req), id(req), item(req)),
  );
  app.put("/api/team/projects/:id/materials/:itemId", (req) =>
    projects.put(
      actor(req),
      id(req),
      item(req),
      key(req),
      sharedMaterialWriteSchema.parse(req.body),
    ),
  );
  app.delete("/api/team/projects/:id/materials/:itemId", (req) => {
    const b = z
      .object({ revision: z.number().int().positive(), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return projects.remove(actor(req), id(req), item(req), key(req), b.revision);
  });
  app.get("/api/team/projects/:id/materials/:itemId/history", (req) =>
    projects.history(actor(req), id(req), item(req), before.parse(req.query).before),
  );
  app.get("/api/team/projects/:id/activity", (req) =>
    projects.activity(actor(req), id(req), before.parse(req.query).before),
  );
  const publicationKind = z.enum(["core", "note", "task", "plan", "report"]);
  const publication = z
    .object({
      scope: projectScopeSchema,
      items: z
        .array(z.object({ id: z.string().min(1).max(100), kind: publicationKind }).strict())
        .min(1)
        .max(20),
    })
    .strict();
  app.get("/api/team/projects/:id/publication-sources", async (req) => {
    const userId = actor(req),
      projectId = id(req);
    projects.access(userId, projectId, "write");
    const q = projectScopeSchema
      .extend({
        kind: publicationKind,
        offset: z.coerce.number().int().min(0).max(5000).default(0),
      })
      .parse(req.query);
    const { runtime } = await personal(userId);
    actor(req);
    projects.access(userId, projectId, "write");
    return publicationSources(
      runtime,
      { client: q.client, projectId: q.projectId, name: q.name },
      q.kind,
      q.offset,
    );
  });
  app.post("/api/team/projects/:id/publication-preview", async (req) => {
    const userId = actor(req),
      projectId = id(req),
      input = publication.parse(req.body);
    projects.access(userId, projectId, "write");
    const { runtime } = await personal(userId);
    actor(req);
    projects.access(userId, projectId, "write");
    return publicationPreview(runtime, userId, input.scope, input.items);
  });
  app.post("/api/team/projects/:id/publications", async (req) => {
    const userId = actor(req),
      projectId = id(req),
      receipt = key(req),
      input = publication
        .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(req.body);
    projects.access(userId, projectId, "write");
    const { runtime } = await personal(userId);
    actor(req);
    return projects.publish(userId, projectId, receipt, input, () =>
      publicationPreview(runtime, userId, input.scope, input.items),
    );
  });
}
