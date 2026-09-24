import { HubError, isFileSource, type ResultItem } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { createApp } from "./app.js";
import type { Communication } from "./communication.js";
import { assertPreviewFrame, previewCsp } from "./previews.js";
import { resultCaptureMarker } from "./result-capture-limit.js";

export function registerCommunication(
  app: FastifyInstance,
  communication: Communication,
  actor: (req: FastifyRequest) => string,
  personal: (id: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>,
) {
  const uuid = z.string().uuid(),
    id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id,
    key = (req: FastifyRequest) => uuid.parse(req.headers["idempotency-key"]);
  const write = { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } };
  app.post("/api/team/communication/github", write, async (req) => {
    const user = actor(req),
      input = z
        .object({
          projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          url: z
            .string()
            .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9]\d*$/),
        })
        .strict()
        .parse(req.body);
    const { runtime } = await personal(user);
    actor(req);
    const match = input.url.match(/^https:\/\/github\.com\/(.+)\/(issues|pull)\/(\d+)$/)!;
    const kind = match[2] === "pull" ? "pr" : "issue",
      key = kind + ":" + match[3];
    const value = await runtime.intake.source(input.projectId, key);
    actor(req);
    if (value.repository.toLowerCase() !== match[1]!.toLowerCase() || !value.record)
      throw new HubError(
        409,
        "REFERENCE_REPOSITORY",
        "Выбери рабочую копию указанного репозитория.",
      );
    return {
      projectId: input.projectId,
      repositoryId: value.repositoryId,
      source: { key, kind, title: value.record.title, url: input.url, number: Number(match[3]) },
    };
  });
  app.get("/api/team/conversations", (req) => ({ items: communication.list(actor(req)) }));
  app.post("/api/team/conversations", write, (req) =>
    communication.create(
      actor(req),
      key(req),
      z
        .object({ title: z.string().trim().max(120), members: z.array(uuid).min(1).max(7) })
        .strict()
        .parse(req.body),
    ),
  );
  app.get("/api/team/conversations/:id", (req) => communication.detail(actor(req), id(req)));
  app.put("/api/team/conversations/:id", write, (req) =>
    communication.preferences(
      actor(req),
      id(req),
      z.object({ muted: z.boolean() }).strict().parse(req.body).muted,
    ),
  );
  app.delete("/api/team/conversations/:id", write, (req) =>
    communication.leave(actor(req), id(req)),
  );
  app.register(async (chat) => {
    chat.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: 32 * 1024 ** 2 },
      (_req, body, done) => done(null, body),
    );
    chat.get("/api/team/conversations/:id/chat", (req) =>
      communication.chat.page(
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
    chat.post("/api/team/conversations/:id/chat", write, (req) =>
      communication.chat.send(
        actor(req),
        id(req),
        key(req),
        z
          .object({
            text: z.string().trim().max(16000),
            files: z.array(uuid).max(8),
            mentions: z.array(uuid).max(8).optional(),
          })
          .strict()
          .refine((v) => !!v.text || !!v.files.length)
          .refine((v) => new Set(v.files).size === v.files.length)
          .parse(req.body),
      ),
    );
    chat.post("/api/team/conversations/:id/chat/read", (req) =>
      communication.chat.markRead(
        actor(req),
        id(req),
        z.object({ seq: z.number().int().positive() }).strict().parse(req.body).seq,
      ),
    );
    chat.post(
      "/api/team/conversations/:id/chat/files",
      { ...write, bodyLimit: 32 * 1024 ** 2 },
      (req) => {
        const q = z
          .object({ name: z.string().min(1).max(300), mime: z.string().max(100) })
          .strict()
          .parse(req.query);
        if (!Buffer.isBuffer(req.body)) throw new HubError(400, "FILE_REQUIRED", "Выбери файл.");
        return communication.chat.stage(actor(req), id(req), q.name, q.mime, req.body);
      },
    );
    chat.get("/api/team/conversations/:id/chat/files/:file", (req, reply) => {
      const file = communication.chat.readFile(
        actor(req),
        id(req),
        z.object({ file: uuid }).parse(req.params).file,
      );
      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        )
        .type(file.mime)
        .send(file.data);
    });
  });
  app.post(
    "/api/team/result-snapshots",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = actor(req),
        operation = key(req),
        source = z
          .object({
            client: z.enum(["codex", "gpt", "human"]),
            threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
            resultId: z.string().regex(/^[a-zA-Z0-9_:-]{1,300}$/),
          })
          .strict()
          .parse(req.body);
      const prior = communication.db
        .prepare("SELECT 1 FROM team_receipts WHERE userId=? AND scope='result.capture' AND key=?")
        .get(user, operation);
      if (prior)
        return communication.team.once(user, "result.capture", operation, source, () => {
          throw Error("unreachable");
        });
      if (source.client === "human") {
        const row = communication.db
          .prepare(
            "SELECT 1 FROM conversation_chat_files WHERE id=? AND spaceId=? AND authorId=? AND messageSeq IS NOT NULL",
          )
          .get(source.resultId, source.threadId, user);
        if (!row) throw new HubError(404, "FILE_UNAVAILABLE", "Файл недоступен для пересылки.");
        const file = communication.chat.readFile(user, source.threadId, source.resultId);
        const snapshot = communication.capture(user, source, file);
        return communication.team.once(user, "result.capture", operation, source, () => snapshot);
      }
      const { runtime } = await personal(user);
      actor(req);
      const headers = {
        cookie: req.headers.cookie ?? "",
        "x-workspace-id": user,
        "sec-fetch-site": "same-origin",
        "sec-fetch-dest": "iframe",
        "x-result-capture": resultCaptureMarker,
      };
      // Resolve exact canonical metadata inside the sender's own runtime. No client URL/path is used.
      const path =
        source.client === "codex"
          ? `/api/threads/${source.threadId}/results/${encodeURIComponent(source.resultId)}`
          : `/api/gpt/conversations/${source.threadId}/results/${encodeURIComponent(source.resultId)}`;
      const metadata = await runtime.app.inject({ method: "GET", url: path, headers });
      if (metadata.statusCode !== 200)
        throw new HubError(404, "RESULT_UNAVAILABLE", "Результат недоступен.");
      const result = metadata.json<ResultItem>(),
        url = result.payload.url;
      if (
        !["file", "image", "artifact", "preview"].includes(result.type) ||
        !url ||
        (!(isFileSource(url) && !url.startsWith("/api/team/")) &&
          !/^\/api\/(?:gpt\/)?previews\/[a-f0-9]{64}$/.test(url))
      )
        throw new HubError(
          409,
          "RESULT_CAPTURE_REQUIRED",
          "Сначала сохрани результат в Files или Demos.",
        );
      if ((result.payload.bytes ?? 0) > 32 * 1024 ** 2)
        throw new HubError(413, "SHARE_TOO_LARGE", "Материал больше 32 МБ.");
      const content = await runtime.app.inject({ method: "GET", url, headers });
      actor(req);
      if (content.statusCode !== 200)
        throw new HubError(
          409,
          "RESULT_UNAVAILABLE",
          "Не удалось прочитать сохранённый результат.",
        );
      const file = {
        name:
          result.type === "preview" && !/\.html?$/i.test(result.title)
            ? result.title + ".html"
            : result.title,
        mime: String(
          content.headers["content-type"] ?? result.payload.mime ?? "application/octet-stream",
        ).split(";")[0]!,
        data: content.rawPayload,
      };
      const snapshot = communication.capture(user, source, file);
      const saved = communication.team.once(
        user,
        "result.capture",
        operation,
        source,
        () => snapshot,
      );
      return reply.header("Cache-Control", "no-store").send(saved);
    },
  );
  const native = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
  const binding = (runtime: Awaited<ReturnType<typeof createApp>>, threadId: string) => {
    runtime.gpt.library.assertExists("thread", threadId);
    if (!runtime.gpt.library.get("thread", threadId))
      throw new HubError(404, "GPT_DESTINATION_UNAVAILABLE", "Выбери чат из своего каталога GPT.");
    const rows = runtime.store.db
      .prepare(
        "SELECT id,revision,visibility FROM ai_conversation_bindings WHERE provider='gpt' AND nativeId=? ORDER BY id",
      )
      .all(threadId);
    if (rows.some((r) => r.visibility !== "normal"))
      throw new HubError(404, "GPT_DESTINATION_UNAVAILABLE", "Этот чат недоступен для пересылки.");
    return JSON.stringify(rows);
  };
  app.post("/api/team/result-handoffs", write, async (req) => {
    const user = actor(req),
      operation = key(req),
      input = z.object({ snapshotId: uuid, threadId: native }).strict().parse(req.body);
    communication.ownerSnapshot(user, input.snapshotId);
    const { runtime } = await personal(user);
    actor(req);
    const scope = binding(runtime, input.threadId);
    return communication.team.once(user, "result.ai.handoff", operation, input, () => {
      communication.db
        .prepare("INSERT INTO result_ai_handoffs VALUES(?,?,?,?,?,0,?)")
        .run(operation, user, input.snapshotId, input.threadId, scope, Date.now());
      return { id: operation };
    });
  });
  app.get("/api/team/result-handoffs", async (req) => {
    const user = actor(req),
      threadId = z.object({ threadId: native }).strict().parse(req.query).threadId;
    const { runtime } = await personal(user);
    actor(req);
    const scope = binding(runtime, threadId);
    return {
      items: communication.db
        .prepare(
          "SELECT h.id,h.snapshotId,f.name title,f.bytes,f.sha256 FROM result_ai_handoffs h JOIN shared_result_files f ON f.id=h.snapshotId WHERE h.ownerId=? AND h.threadId=? AND h.binding=? AND h.dismissed=0 ORDER BY h.createdAt DESC LIMIT 8",
        )
        .all(user, threadId, scope),
    };
  });
  app.post("/api/team/result-handoffs/:id/attachment", write, async (req) => {
    const user = actor(req),
      handoff = communication.db
        .prepare("SELECT * FROM result_ai_handoffs WHERE id=? AND ownerId=? AND dismissed=0")
        .get(id(req), user);
    if (!handoff) throw new HubError(404, "HANDOFF_UNAVAILABLE", "Материал недоступен.");
    const { runtime } = await personal(user);
    actor(req);
    if (binding(runtime, String(handoff.threadId)) !== handoff.binding)
      throw new HubError(
        409,
        "HANDOFF_BINDING_CHANGED",
        "Привязка чата изменилась. Выбери получателя заново.",
      );
    const snapshot = communication.ownerSnapshot(user, String(handoff.snapshotId));
    // Only native GPT attachment staging duplicates bytes; it retains the exact snapshot hash.
    // The human share continues to reference its single immutable object.
    const file = await runtime.gpt.putFile(snapshot.title, snapshot.data, String(handoff.id));
    actor(req);
    if (binding(runtime, String(handoff.threadId)) !== handoff.binding)
      throw new HubError(409, "HANDOFF_BINDING_CHANGED", "Привязка чата изменилась.");
    return { file, snapshotId: snapshot.id, sha256: snapshot.sha256 };
  });
  app.delete("/api/team/result-handoffs/:id", write, (req) => {
    communication.db
      .prepare("UPDATE result_ai_handoffs SET dismissed=1 WHERE id=? AND ownerId=?")
      .run(id(req), actor(req));
    return { ok: true };
  });
  app.get("/api/team/result-snapshots/:id/grants", (req) => ({
    items: communication.grants(actor(req), id(req)),
  }));
  app.post("/api/team/result-shares", write, (req) =>
    communication.share(
      actor(req),
      key(req),
      z
        .object({
          snapshotId: uuid,
          destination: z
            .object({ kind: z.enum(["conversation", "brainstorm", "space"]), id: uuid })
            .strict(),
          publicRoom: z.boolean(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.delete("/api/team/result-shares/:id", write, (req) =>
    communication.revoke(actor(req), id(req)),
  );
  app.get("/api/team/result-shares/:id", (req, reply) => {
    const file = communication.describe(actor(req), id(req));
    return reply.header("Cache-Control", "no-store").send(file);
  });
  app.get("/api/team/result-shares/:id/content", (req, reply) => {
    const file = communication.read(actor(req), id(req));
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.title)}`,
      )
      .type(file.mime)
      .send(file.data);
  });
  app.get("/api/team/result-shares/:id/preview", (req, reply) => {
    assertPreviewFrame(req.headers);
    const file = communication.read(actor(req), id(req));
    if (!/\.html?$/i.test(file.title) && file.mime !== "text/html")
      throw new HubError(415, "NOT_HTML", "Это не HTML-демо.");
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", previewCsp)
      .header("X-Content-Type-Options", "nosniff")
      .type("text/html; charset=utf-8")
      .send(file.data);
  });
}
