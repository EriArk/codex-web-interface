import { inspectProject } from "@codex-web/machines";
import { HubError, type ProjectRepository } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { createApp } from "./app.js";
import { CollaborationSpaces, type VerifiedSpaceProject } from "./collaboration-spaces.js";
import type { TeamProjects } from "./team-projects.js";

export function registerCollaborationSpaces(
  app: FastifyInstance,
  team: TeamProjects,
  actor: (req: FastifyRequest) => string,
  personal: (userId: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>,
) {
  const spaces = new CollaborationSpaces(team);
  const id = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  const key = (req: FastifyRequest) => z.string().uuid().parse(req.headers["idempotency-key"]);
  const projectId = z.string().min(1).max(100),
    access = z.enum(["collaborate", "direct"]);
  const revision = z.number().int().positive(),
    title = z.string().trim().min(1).max(120);
  const replay = (user: string, scope: string, receipt: string, input: unknown) => {
    if (
      !team.db
        .prepare("SELECT 1 FROM team_receipts WHERE userId=? AND scope=? AND key=?")
        .get(user, scope, receipt)
    )
      return null;
    return team.once(user, scope, receipt, input, () => {
      throw new Error("Receipt disappeared");
    });
  };
  // One existing repository read, only for the user's chosen local Project; no native chat reads.
  const verify = async (user: string, personalProjectId: string): Promise<VerifiedSpaceProject> => {
    const { runtime } = await personal(user),
      project = runtime.sessions.project(personalProjectId);
    runtime.projectWork.context.assertProject({
      client: "codex",
      projectId: project.id,
      name: project.name,
    });
    const machine = runtime.sessions.catalog.machine(project.machineId);
    const observed = (await inspectProject(machine, project.workingDirectory, {
      op: "repository",
    })) as ProjectRepository;
    if (!observed.repository || !observed.remote)
      throw new HubError(
        409,
        "SPACE_GITHUB_REQUIRED",
        "Сначала подключи репозиторий GitHub в настройке этого проекта.",
      );
    const repository = z
      .string()
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
      .parse(`https://github.com/${observed.remote.owner}/${observed.remote.repo}`)
      .toLowerCase();
    return { personalProjectId, name: project.name, repository };
  };
  app.get("/api/team/spaces", (req) => spaces.catalog(actor(req)));
  app.post("/api/team/spaces", async (req) => {
    const user = actor(req),
      receipt = key(req);
    const input = z
      .object({
        title,
        kind: z.enum(["project", "space"]),
        userId: z.string().uuid(),
        personalProjectId: projectId,
        access,
        requestedAccess: access.default("collaborate"),
      })
      .strict()
      .parse(req.body);
    const previous = replay(user, "spaces.create", receipt, input);
    if (previous) return previous;
    const verified = await verify(user, input.personalProjectId);
    actor(req);
    return spaces.create(user, receipt, input, verified);
  });
  app.post("/api/team/spaces/:id/answer", async (req) => {
    const user = actor(req),
      spaceId = id(req),
      receipt = key(req);
    const input = z
      .object({
        revision,
        accept: z.boolean(),
        personalProjectId: projectId.optional(),
        access: access.optional(),
      })
      .strict()
      .refine((v) => !v.accept || !!v.personalProjectId)
      .parse(req.body);
    const previous = replay(user, "spaces.answer:" + spaceId, receipt, input);
    if (previous) return previous;
    spaces.invitation(user, spaceId, input.revision);
    const verified = input.accept ? await verify(user, input.personalProjectId!) : undefined;
    actor(req);
    return spaces.answer(user, spaceId, receipt, input, verified);
  });
  app.patch("/api/team/spaces/:id", (req) =>
    spaces.rename(
      actor(req),
      id(req),
      key(req),
      z.object({ revision, title }).strict().parse(req.body),
    ),
  );
  app.post("/api/team/spaces/:id/leave", (req) =>
    spaces.leave(actor(req), id(req), key(req), z.object({ revision }).strict().parse(req.body)),
  );
}
