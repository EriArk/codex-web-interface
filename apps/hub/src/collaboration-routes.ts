import { createHash } from "node:crypto";
import { inspectProject } from "@codex-web/machines";
import { HubError, type ProjectRepository } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { createApp } from "./app.js";
import { CollaborationSpaces, type VerifiedSpaceProject } from "./collaboration-spaces.js";
import { projectGptSendSchema, rulesSchema } from "./project-gpt.js";
import { SpaceActivity } from "./space-activity.js";
import type { GitHubProbe } from "./team-github.js";
import type { TeamProjects } from "./team-projects.js";

export function registerCollaborationSpaces(
  app: FastifyInstance,
  team: TeamProjects,
  actor: (req: FastifyRequest) => string,
  personal: (userId: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>,
  spaces = new CollaborationSpaces(team),
  githubProbe?: GitHubProbe,
) {
  const activity = new SpaceActivity(spaces, personal, githubProbe);
  const socialSource = z.object({
    projectId: z.string().uuid(),
    repositoryId: z.number().int().positive(),
    source: z.string().regex(/^(commit:[a-f0-9]{40,64}|(?:pr|issue):[1-9][0-9]{0,9})$/),
  });
  const socialReadLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  app.post("/api/team/spaces/:id/activity/source", socialReadLimit, async (req, reply) => {
    const body = socialSource
        .extend({ page: z.number().int().min(1).max(50).default(1) })
        .strict()
        .parse(req.body),
      user = actor(req);
    const value = await activity.sourceDetails(
      user,
      id(req),
      body.projectId,
      body.repositoryId,
      body.source,
      body.page,
    );
    actor(req);
    spaces.access(user, id(req));
    return reply.header("Cache-Control", "no-store").send(value);
  });
  app.post("/api/team/spaces/:id/activity/replies", socialReadLimit, async (req, reply) => {
    const body = socialSource
        .extend({ before: z.number().int().positive().optional() })
        .strict()
        .parse(req.body),
      user = actor(req);
    const scope = await activity.socialScope(
      user,
      id(req),
      body.projectId,
      body.repositoryId,
      body.source,
    );
    actor(req);
    return reply
      .header("Cache-Control", "no-store")
      .send(spaces.social.page(user, scope, body.before));
  });
  app.post(
    "/api/team/spaces/:id/activity/reply",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = socialSource
          .extend({
            text: z.string().trim().min(1).max(2000),
            replyTo: z.number().int().positive().optional(),
            recipientId: z.string().uuid().optional(),
          })
          .strict()
          .parse(req.body),
        user = actor(req);
      const scope = await activity.socialScope(
        user,
        id(req),
        body.projectId,
        body.repositoryId,
        body.source,
      );
      actor(req);
      const result = spaces.social.reply(user, scope, key(req), {
        text: body.text,
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        ...(body.recipientId ? { recipientId: body.recipientId } : {}),
      });
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );
  app.post(
    "/api/team/spaces/:id/activity/react",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = socialSource
          .extend({ kind: z.enum(["like", "seen", "thanks", "question"]).nullable() })
          .strict()
          .parse(req.body),
        user = actor(req);
      const scope = await activity.socialScope(
        user,
        id(req),
        body.projectId,
        body.repositoryId,
        body.source,
      );
      actor(req);
      return reply
        .header("Cache-Control", "no-store")
        .send(spaces.social.react(user, scope, key(req), body.kind));
    },
  );
  app.post("/api/team/spaces/:id/activity/read", socialReadLimit, async (req, reply) => {
    const body = socialSource
        .extend({ seqs: z.array(z.number().int().positive()).max(20) })
        .strict()
        .parse(req.body),
      user = actor(req);
    const scope = await activity.socialScope(
      user,
      id(req),
      body.projectId,
      body.repositoryId,
      body.source,
    );
    actor(req);
    spaces.social.markRead(user, scope, body.seqs);
    return reply.send({ ok: true });
  });
  app.post("/api/team/spaces/:id/activity/attention", socialReadLimit, async (req, reply) => {
    const body = z.object({ seq: z.number().int().positive() }).strict().parse(req.body),
      user = actor(req);
    const s = spaces.social.notification(user, id(req), body.seq);
    const scope = await activity.socialScope(
      user,
      s.spaceId,
      s.projectId,
      s.repositoryId,
      s.source.key,
    );
    actor(req);
    return reply
      .header("Cache-Control", "no-store")
      .send(spaces.social.page(user, scope, body.seq + 1));
  });
  app.post(
    "/api/team/spaces/:id/activity/discuss",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          projectId: z.string().uuid(),
          sources: z
            .array(z.string().regex(/^(commit:[a-f0-9]{40,64}|(?:pr|issue):[1-9][0-9]{0,9})$/))
            .min(1)
            .max(30),
        })
        .strict()
        .parse(req.body);
      if (new Set(body.sources).size !== body.sources.length)
        throw new HubError(400, "ACTIVITY_SOURCES", "Выбери разные источники.");
      const result = await activity.prepare(
        actor(req),
        id(req),
        body.projectId,
        key(req),
        body.sources,
      );
      actor(req);
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );
  app.get("/api/team/activity-handoffs/:handoff", async (req, reply) => {
    const handoff = z.object({ handoff: z.string().uuid() }).parse(req.params).handoff;
    const result = await activity.handoff(actor(req), handoff);
    actor(req);
    return reply.header("Cache-Control", "no-store").send(result);
  });
  app.post("/api/team/activity-handoffs/:handoff/send", async (req, reply) => {
    const handoff = z.object({ handoff: z.string().uuid() }).parse(req.params).handoff;
    const user = actor(req);
    const job = await activity.sendHandoff(
      user,
      handoff,
      key(req),
      projectGptSendSchema.parse(req.body),
    );
    actor(req);
    return reply.code(202).header("Cache-Control", "no-store").send({ job });
  });
  app.post(
    "/api/team/spaces/:id/activity",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = actor(req);
      const body = z
        .object({
          projectId: z.string().uuid(),
          source: z
            .string()
            .regex(/^(commit:[a-f0-9]{40,64}|(?:pr|issue):[1-9][0-9]{0,9})$/)
            .optional(),
          known: z
            .object({
              repositoryId: z.number().int().positive(),
              versions: z
                .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
                .refine((v) => Object.keys(v).length <= 200),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(req.body);
      const result = await activity.page(user, id(req), body.projectId, body.source);
      actor(req);
      spaces.access(user, id(req));
      const social = Object.fromEntries(
        result.items.map((source) => [
          source.key,
          spaces.social.summary(user, {
            spaceId: id(req),
            projectId: body.projectId,
            repositoryId: result.repositoryId,
            source,
          }),
        ]),
      );
      const versions = Object.fromEntries(
        result.items.map((item) => [
          item.key,
          createHash("sha256")
            .update(JSON.stringify([item, social[item.key]]))
            .digest("hex"),
        ]),
      );
      const delta = body.known?.repositoryId === result.repositoryId;
      const items = delta
        ? result.items.filter((item) => body.known!.versions[item.key] !== versions[item.key])
        : result.items;
      return reply.header("Cache-Control", "no-store").send({
        ...result,
        items,
        social: Object.fromEntries(items.map((item) => [item.key, social[item.key]])),
        versions,
        keys: result.items.map((item) => item.key),
        delta,
      });
    },
  );
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
  app.post("/api/team/spaces/:id/projects/:projectId/chat", async (req) => {
    const user = actor(req);
    const params = z.object({ id: z.string().uuid(), projectId }).parse(req.params);
    const space = spaces.catalog(user).spaces.find((s) => s.id === params.id);
    const project = space?.projects.find((p) => p.id === params.projectId);
    if (!space || !project || project.access === "none" || !project.personalProjectId)
      throw new HubError(
        409,
        "SPACE_COPY_REQUIRED",
        "Сначала подключи свою рабочую копию проекта.",
      );
    const { runtime } = await personal(user);
    const local = runtime.sessions.project(project.personalProjectId);
    const scope = `space-intro:${space.id}:${project.id}:${local.id}`;
    // The account-local receipt is shared across devices; opening never duplicates a turn.
    const thread = (await runtime.store.once(scope, "create", {}, () =>
      runtime.sessions.create(local.id, `Изучение ${project.name}`.slice(0, 120)),
    )) as { id: string; projectId: string };
    actor(req);
    await runtime.store.once(scope, "intro", {}, async () => {
      const current = spaces.catalog(user).spaces.find((s) => s.id === params.id);
      const bound = current?.projects.find((p) => p.id === params.projectId);
      if (!bound || bound.access === "none" || bound.personalProjectId !== local.id)
        throw new HubError(403, "SPACE_ACCESS_CHANGED", "Доступ к проекту изменился.");
      return runtime.sessions.startTurn(
        thread.id,
        `Работаем с проектом ${project.name}. Репозиторий GitHub: ${project.repository}.\n` +
          `Пространство: ${space.title}. Связанные проекты: ${
            space.projects
              .filter((p) => p.id !== project.id)
              .map((p) => `${p.name} — ${p.repository}`)
              .join("; ") || "нет"
          }.\n` +
          "Изучи инструкции проекта и структуру текущей рабочей копии. Кратко объясни назначение проекта и основные части. Пока ничего не изменяй.",
        undefined,
        [],
      );
    });
    return thread;
  });
  app.register(async (chat) => {
    chat.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: 32 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    chat.get("/api/team/spaces/:id/chat", (req) => {
      const cursor = z
        .object({
          before: z.coerce.number().int().positive().optional(),
          after: z.coerce.number().int().nonnegative().optional(),
        })
        .strict()
        .refine((v) => v.before === undefined || v.after === undefined)
        .parse(req.query);
      return spaces.chat.page(actor(req), id(req), cursor);
    });
    chat.post("/api/team/spaces/:id/chat", (req) => {
      const input = z
        .object({ text: z.string().trim().max(16000), files: z.array(z.string().uuid()).max(8) })
        .strict()
        .refine((v) => !!v.text || !!v.files.length)
        .refine((v) => new Set(v.files).size === v.files.length)
        .parse(req.body);
      return spaces.chat.send(actor(req), id(req), key(req), input);
    });
    chat.post("/api/team/spaces/:id/chat/read", (req) =>
      spaces.chat.markRead(
        actor(req),
        id(req),
        z.object({ seq: z.number().int().positive() }).strict().parse(req.body).seq,
      ),
    );
    chat.post("/api/team/spaces/:id/chat/files", { bodyLimit: 32 * 1024 * 1024 }, (req) => {
      const { name, mime } = z
        .object({ name: z.string().min(1).max(300), mime: z.string().max(100) })
        .strict()
        .parse(req.query);
      if (!Buffer.isBuffer(req.body))
        throw new HubError(400, "SPACE_FILE_REQUIRED", "Выбери файл.");
      return spaces.chat.stage(actor(req), id(req), name, mime, req.body);
    });
    chat.get("/api/team/spaces/:id/chat/files/:fileId", (req, reply) => {
      const params = z
        .object({ id: z.string().uuid(), fileId: z.string().uuid() })
        .parse(req.params);
      const file = spaces.chat.readFile(actor(req), params.id, params.fileId);
      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          `${file.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        )
        .type(file.mime)
        .send(file.data);
    });
  });
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
        recommendations: rulesSchema.optional(),
      })
      .strict()
      .parse(req.body);
    const previous = replay(user, "spaces.create", receipt, input);
    if (previous) return previous;
    const verified = await verify(user, input.personalProjectId);
    if (input.recommendations) {
      const { runtime } = await personal(user);
      await runtime.projectGpts.invitationRules(
        input.personalProjectId,
        receipt,
        input.recommendations,
      );
    }
    actor(req);
    return spaces.create(user, receipt, input, verified);
  });
  app.post("/api/team/spaces/:id/invite", (req) =>
    spaces.invite(
      actor(req),
      id(req),
      key(req),
      z
        .object({
          revision,
          userId: z.string().uuid(),
          grants: z
            .array(z.object({ projectId, access }).strict())
            .max(30)
            .refine((v) => new Set(v.map((g) => g.projectId)).size === v.length),
          requestedAccess: access.default("collaborate"),
          recommendations: rulesSchema.optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
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
        grants: z
          .array(z.object({ userId: z.string().uuid(), access }).strict())
          .max(30)
          .optional(),
        rules: rulesSchema.optional(),
      })
      .strict()
      .refine((v) => !v.accept || !!v.personalProjectId)
      .parse(req.body);
    const previous = replay(user, "spaces.answer:" + spaceId, receipt, input);
    if (previous) return previous;
    const pending = spaces.invitation(user, spaceId, input.revision);
    const verified = input.accept ? await verify(user, input.personalProjectId!) : undefined;
    if (
      verified &&
      pending.space.kind === "project" &&
      pending.space.projects[0]?.repository !== verified.repository
    )
      throw new HubError(
        409,
        "SPACE_REPOSITORY_MISMATCH",
        "Выбери свою локальную копию того же репозитория.",
      );
    if (input.accept && input.rules) {
      const { runtime } = await personal(user);
      await runtime.projectGpts.invitationRules(input.personalProjectId!, receipt, input.rules);
    }
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
  for (const operation of ["add-project", "bind"] as const) {
    app.post(`/api/team/spaces/:id/${operation}`, async (req) => {
      const user = actor(req),
        spaceId = id(req),
        receipt = key(req);
      const input = (
        operation === "add-project"
          ? z.object({ revision, personalProjectId: projectId, access })
          : z.object({ revision, personalProjectId: projectId, projectId })
      )
        .strict()
        .parse(req.body);
      const previous = replay(user, `spaces.${operation}:` + spaceId, receipt, input);
      if (previous) return previous;
      spaces.access(user, spaceId, input.revision);
      const verified = await verify(user, input.personalProjectId);
      actor(req);
      return "access" in input
        ? spaces.addProject(user, spaceId, receipt, input, verified)
        : spaces.bindCopy(user, spaceId, receipt, input, verified);
    });
  }
  app.post("/api/team/spaces/:id/remove-project", (req) =>
    spaces.removeProject(
      actor(req),
      id(req),
      key(req),
      z.object({ revision, projectId }).strict().parse(req.body),
    ),
  );
  app.post("/api/team/spaces/:id/grant", (req) =>
    spaces.grant(
      actor(req),
      id(req),
      key(req),
      z.object({ revision, projectId, userId: z.string().uuid(), access }).strict().parse(req.body),
    ),
  );
  app.post("/api/team/spaces/:id/request-access", (req) =>
    spaces.requestAccess(
      actor(req),
      id(req),
      key(req),
      z.object({ revision, projectId }).strict().parse(req.body),
    ),
  );
  app.post("/api/team/spaces/:id/remove-member", (req) =>
    spaces.removeMember(
      actor(req),
      id(req),
      key(req),
      z.object({ revision, userId: z.string().uuid() }).strict().parse(req.body),
    ),
  );
  app.post("/api/team/spaces/:id/leave", (req) =>
    spaces.leave(actor(req), id(req), key(req), z.object({ revision }).strict().parse(req.body)),
  );
}
