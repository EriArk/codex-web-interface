import { inspectProject } from "@codex-web/machines";
import { type BrainstormConversion, HubError } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import type { createApp } from "./app.js";
import { type BrainstormRooms, brainstormSnapshotContext } from "./brainstorm.js";
import type { BrainstormGpts } from "./brainstorm-gpt.js";
import type { CollaborationSpaces } from "./collaboration-spaces.js";

export function registerBrainstorm(
  app: FastifyInstance,
  rooms: BrainstormRooms,
  spaces: CollaborationSpaces,
  actor: (req: FastifyRequest) => string,
  personal: (userId: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>,
  gpts: (actor: string, runtime: Awaited<ReturnType<typeof createApp>>) => BrainstormGpts,
) {
  const id = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  const key = (req: FastifyRequest) => z.string().uuid().parse(req.headers["idempotency-key"]);
  const title = z.string().trim().min(1).max(160),
    description = z.string().max(4000);
  const readLimit = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  const writeLimit = { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } };
  app.get("/api/team/brainstorm", (req) =>
    rooms.catalog(
      actor(req),
      z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0) }).parse(req.query)
        .offset,
    ),
  );
  app.post("/api/team/brainstorm", writeLimit, (req) =>
    rooms.create(actor(req), key(req), z.object({ title, description }).strict().parse(req.body)),
  );
  app.get("/api/team/brainstorm/:id", readLimit, (req) =>
    rooms.state(
      actor(req),
      id(req),
      z.object({ since: z.coerce.number().int().nonnegative().optional() }).parse(req.query).since,
    ),
  );
  app.put("/api/team/brainstorm/:id", writeLimit, (req) =>
    rooms.edit(
      actor(req),
      id(req),
      key(req),
      z
        .object({ title, description, revision: z.number().int().positive(), closed: z.boolean() })
        .strict()
        .parse(req.body),
    ),
  );
  app.put("/api/team/brainstorm/:id/follow", writeLimit, (req) =>
    rooms.follow(
      actor(req),
      id(req),
      z.object({ following: z.boolean(), muted: z.boolean() }).strict().parse(req.body),
    ),
  );
  app.put("/api/team/brainstorm/:id/cards/:card", writeLimit, (req) =>
    rooms.put(
      actor(req),
      id(req),
      z.object({ card: z.string().uuid() }).parse(req.params).card,
      key(req),
      req.body,
    ),
  );
  app.delete("/api/team/brainstorm/:id/cards/:card", writeLimit, (req) =>
    rooms.remove(
      actor(req),
      id(req),
      z.object({ card: z.string().uuid() }).parse(req.params).card,
      key(req),
      z.object({ revision: z.number().int().positive() }).strict().parse(req.body).revision,
    ),
  );
  app.get("/api/team/brainstorm/:id/gpt", async (req) => {
    const user = actor(req);
    rooms.access(user, id(req));
    const { runtime } = await personal(user);
    actor(req);
    return gpts(user, runtime).get(id(req));
  });
  app.post("/api/team/brainstorm/:id/gpt/send", writeLimit, async (req, reply) => {
    const user = actor(req);
    rooms.access(user, id(req), true);
    const { runtime } = await personal(user);
    actor(req);
    return reply.code(202).send({ job: gpts(user, runtime).send(id(req), key(req), req.body) });
  });
  app.register(async (chat) => {
    chat.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: 32 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    chat.get("/api/team/brainstorm/:id/chat", readLimit, (req) =>
      rooms.chat.page(
        actor(req),
        id(req),
        z
          .object({
            before: z.coerce.number().int().positive().optional(),
            after: z.coerce.number().int().nonnegative().optional(),
          })
          .strict()
          .refine((v) => v.before === undefined || v.after === undefined)
          .parse(req.query),
      ),
    );
    chat.post("/api/team/brainstorm/:id/chat", writeLimit, (req) => {
      rooms.access(actor(req), id(req), true);
      return rooms.chat.send(
        actor(req),
        id(req),
        key(req),
        z
          .object({ text: z.string().trim().max(16000), files: z.array(z.string().uuid()).max(8) })
          .strict()
          .refine((v) => !!v.text || !!v.files.length)
          .refine((v) => new Set(v.files).size === v.files.length)
          .parse(req.body),
      );
    });
    chat.post("/api/team/brainstorm/:id/chat/read", (req) =>
      rooms.chat.markRead(
        actor(req),
        id(req),
        z.object({ seq: z.number().int().positive() }).strict().parse(req.body).seq,
      ),
    );
    chat.post(
      "/api/team/brainstorm/:id/chat/files",
      { ...writeLimit, bodyLimit: 32 * 1024 * 1024 },
      (req) => {
        rooms.access(actor(req), id(req), true);
        const q = z
          .object({ name: z.string().min(1).max(300), mime: z.string().max(100) })
          .strict()
          .parse(req.query);
        if (!Buffer.isBuffer(req.body))
          throw new HubError(400, "ROOM_FILE_REQUIRED", "Выбери файл.");
        return rooms.chat.stage(actor(req), id(req), q.name, q.mime, req.body);
      },
    );
    chat.get("/api/team/brainstorm/:id/chat/files/:file", (req, reply) => {
      const file = rooms.chat.readFile(
        actor(req),
        id(req),
        z.object({ file: z.string().uuid() }).parse(req.params).file,
      );
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
  app.post("/api/team/brainstorm/:id/snapshots", writeLimit, (req) =>
    rooms.snapshot(
      actor(req),
      id(req),
      key(req),
      z
        .object({
          title,
          cardIds: z.array(z.string().uuid()).max(200),
          messageIds: z.array(z.string().uuid()).max(20),
          summary: z.string().max(8000),
          participants: z
            .array(
              z
                .object({ userId: z.string().uuid(), access: z.enum(["collaborate", "direct"]) })
                .strict(),
            )
            .max(20),
        })
        .strict()
        .refine(
          (v) =>
            new Set(v.cardIds).size === v.cardIds.length &&
            new Set(v.messageIds).size === v.messageIds.length &&
            new Set(v.participants.map((p) => p.userId)).size === v.participants.length,
        )
        .parse(req.body),
    ),
  );
  app.get("/api/team/brainstorm/:id/snapshots", (req) => {
    const user = actor(req);
    rooms.access(user, id(req), false, true);
    return {
      items: rooms.team.db
        .prepare(
          "SELECT value FROM brainstorm_conversions WHERE roomId=? AND ownerId=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(id(req), user)
        .map((r) => {
          const v = JSON.parse(String(r.value));
          return { id: v.id, title: v.title, projectId: v.projectId, createdAt: v.createdAt };
        }),
    };
  });
  app.get("/api/team/brainstorm-conversions/:id", (req) => rooms.conversion(actor(req), id(req)));
  app.get("/api/team/brainstorm-conversions/:id/export", (req, reply) => {
    const user = actor(req),
      value = rooms.conversion(user, id(req));
    // Explicit export contains shared material only. Personal GPT handoff never enters the archive.
    const entries: Record<string, Uint8Array> = {
      "manifest.json": strToU8(
        JSON.stringify({ id: value.id, createdAt: value.createdAt, ...value.snapshot }, null, 2),
      ),
      "room.md": strToU8(
        `# ${value.snapshot.room.title}\n\n${value.snapshot.room.description}\n\n` +
          value.snapshot.cards.map((c) => `## ${c.title}\n${c.text}\n${c.url}`).join("\n\n"),
      ),
      "messages.md": strToU8(
        value.snapshot.messages.map((m) => `${m.author.name}\n${m.text}`).join("\n\n"),
      ),
    };
    const fileIds = new Set([
      ...value.snapshot.cards.flatMap((c) => (c.fileId ? [c.fileId] : [])),
      ...value.snapshot.messages.flatMap((m) => m.files.map((f) => f.id)),
    ]);
    let bytes = 0;
    for (const fileId of fileIds) {
      const file = rooms.chat.readFile(user, value.roomId, fileId);
      bytes += file.bytes;
      if (bytes > 64 * 1024 ** 2)
        throw new HubError(
          413,
          "ROOM_EXPORT_LIMIT",
          "Для одного архива выбери до 64 МБ материалов.",
        );
      entries[`files/${fileId}/${file.name}`] = file.data;
    }
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="brainstorm-export.zip"')
      .type("application/zip")
      .send(Buffer.from(zipSync(entries, { level: 1 })));
  });
  app.post("/api/team/brainstorm-conversions/:id/reset-review", writeLimit, async (req) => {
    const user = actor(req),
      value = rooms.conversion(user, id(req)),
      input = z
        .object({ fingerprint: z.string().min(1).max(256) })
        .strict()
        .parse(req.body);
    rooms.access(user, value.roomId, true, true);
    if (value.projectId) throw new HubError(409, "ROOM_PROJECT_EXISTS", "Проект уже создан.");
    const { runtime } = await personal(user);
    actor(req);
    rooms.access(user, value.roomId, true, true);
    runtime.sessions.authorizeExecution();
    // Prepared inspection has made no machine mutations. Executing/uncertain receipts cannot reset.
    const removed = runtime.store.db
      .prepare(
        "DELETE FROM project_setup_operations WHERE id=? AND state='prepared' AND json_extract(value,'$.inspection.fingerprint')=?",
      )
      .run(value.id, input.fingerprint);
    if (!removed.changes)
      throw new HubError(409, "ROOM_SETUP_CHANGED", "Мастер уже изменился. Открой его снова.");
    return { reset: true };
  });
  app.post("/api/team/brainstorm-conversions/:id/complete", writeLimit, async (req) => {
    const user = actor(req),
      conversionId = id(req),
      value = rooms.conversion(user, conversionId);
    const input = z
      .object({ projectId: z.string().min(1).max(100) })
      .strict()
      .parse(req.body);
    rooms.access(user, value.roomId, true, true);
    if (value.projectId) {
      if (value.projectId !== input.projectId)
        throw new HubError(409, "ROOM_PROJECT_EXISTS", "Для этого снимка уже выбран проект.");
      return value;
    }
    const { runtime } = await personal(user),
      project = runtime.sessions.project(input.projectId);
    actor(req);
    rooms.access(user, value.roomId, true, true);
    const receipt = runtime.store.db
      .prepare("SELECT value FROM project_setup_operations WHERE id=? AND state='complete'")
      .get(conversionId);
    if (!receipt || JSON.parse(String(receipt.value)).project?.id !== project.id)
      throw new HubError(
        409,
        "ROOM_SETUP_REQUIRED",
        "Продолжи создание через сохранённый мастер этой комнаты.",
      );
    // The setup receipt permanently binds this snapshot to one exact personal project.
    runtime.projectGpts.handoff(project.id, {
      sourceRoomId: value.roomId,
      snapshotId: value.id,
      room: brainstormSnapshotContext(value.snapshot),
      personalSummary: value.summary,
    });
    const repository = (await inspectProject(
      runtime.sessions.catalog.machine(project.machineId),
      project.workingDirectory,
      { op: "repository" },
    )) as { remote?: { url?: string } };
    actor(req);
    rooms.access(user, value.roomId, true, true);
    const url =
      repository.remote?.url
        ?.replace(/^git@github.com:/, "https://github.com/")
        .replace(/\.git$/, "") ?? null;
    if (
      value.participants.length &&
      (!url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url))
    )
      throw new HubError(
        409,
        "ROOM_REPOSITORY_REQUIRED",
        "Для приглашения участников подключи GitHub-репозиторий проекта.",
      );
    // Separate ordinary invitation receipts; retries recover each completed step.
    let spaceId: string | null = null;
    if (value.participants.length) {
      const first = value.participants[0]!;
      spaceId = spaces.create(
        user,
        conversionId,
        {
          title: value.title,
          kind: "project",
          userId: first.userId,
          access: first.access,
          requestedAccess: "collaborate",
          personalProjectId: project.id,
        },
        { personalProjectId: project.id, name: project.name, repository: url! },
      ).id;
      for (const person of value.participants.slice(1)) {
        const space = spaces.access(user, spaceId);
        if (
          space.members.includes(person.userId) ||
          space.invitations.some((i) => i.userId === person.userId)
        )
          continue;
        spaces.invite(user, spaceId, conversionId + ":" + person.userId, {
          revision: space.revision,
          userId: person.userId,
          grants: [{ projectId: space.projects[0]!.id, access: person.access }],
          requestedAccess: "collaborate",
        });
      }
    }

    const completed: BrainstormConversion & { repository: string | null } = {
      ...value,
      projectId: project.id,
      spaceId,
      repository: url,
    };
    rooms.team.db
      .prepare("UPDATE brainstorm_conversions SET value=? WHERE id=? AND ownerId=?")
      .run(JSON.stringify(completed), conversionId, user);
    return completed;
  });
}
