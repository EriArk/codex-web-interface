import { existsSync } from "node:fs";
import { basename } from "node:path";
import { type HubConfig, HubError, type HubEvent, turnSettingsSchema } from "@codex-web/shared";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { ZodError, z } from "zod";
import { Artifacts } from "./artifacts.js";
import { MAX_FILE_BYTES } from "./attachments.js";
import { Auth } from "./auth.js";
import { registerNavigation } from "./navigation.js";
import { connectRemote, remoteProvider } from "./remote.js";
import { Sessions } from "./sessions.js";
import { Store } from "./store.js";

const idSchema = z.string().min(1).max(100);
const paramId = (req: FastifyRequest): string => z.object({ id: idSchema }).parse(req.params).id;
const page = (req: FastifyRequest) =>
  z
    .object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() })
    .parse(req.query);
const key = (req: FastifyRequest): string =>
  z.string().uuid().parse(req.headers["idempotency-key"]);
export async function createApp(
  config: HubConfig,
  options: {
    setupToken?: string;
    webRoot?: string;
    store?: Store;
    sessions?: Sessions;
    logger?: boolean;
  } = {},
) {
  const app = Fastify({
    logger: options.logger
      ? {
          level: "info",
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "req.headers.x-csrf-token",
            "res.headers.set-cookie",
          ],
        }
      : false,
    bodyLimit: 128 * 1024,
    trustProxy: ["127.0.0.1", "::1"],
    requestTimeout: 60000,
  });
  const store = options.store ?? new Store(config.hub.databasePath);
  const sessions = options.sessions ?? new Sessions(config, store);
  const auth = new Auth(config, store);
  const artifacts = new Artifacts(config.hub.resultsPath, store);
  await auth.prepare(options.setupToken);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        upgradeInsecureRequests: config.hub.secureCookies ? [] : null,
      },
    },
  });
  await app.register(rateLimit, {
    // Static assets and normal multi-device reading must not exhaust write/login budgets.
    max: (req) => (req.method === "GET" || req.method === "HEAD" ? 600 : 240),
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      `${req.ip}:${req.method === "GET" || req.method === "HEAD" ? "read" : "write"}`,
    allowList: (req) => !req.url.startsWith("/api/"),
  });
  await app.register(websocket, {
    options: {
      maxPayload: 4096,
      handleProtocols: (protocols) => (protocols.has("guacamole") ? "guacamole" : false),
    },
  });
  auth.install(app);
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES },
    (_req, body, done) => done(null, body),
  );
  const sockets = new Map<WebSocket, string>();
  const closeSession = (token: string) => {
    for (const [socket, owner] of sockets) if (owner === token) socket.close(1008, "Session ended");
  };
  app.setErrorHandler((error, req, reply) => {
    const status =
      error instanceof ZodError
        ? 400
        : error instanceof HubError
          ? error.statusCode
          : ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500)
      app.log.error(
        { code: error instanceof HubError ? error.code : "INTERNAL_ERROR", requestId: req.id },
        "Request failed",
      );
    return reply.code(status).send({
      error: {
        code:
          error instanceof HubError
            ? error.code
            : status === 429
              ? "RATE_LIMITED"
              : status === 400
                ? "INVALID_REQUEST"
                : "REQUEST_FAILED",
        message:
          error instanceof HubError
            ? error.message
            : status === 429
              ? "Слишком много запросов. Попробуй чуть позже"
              : status === 400
                ? "Проверь данные запроса"
                : "Не удалось выполнить запрос",
      },
    });
  });
  registerNavigation(app, store, sessions, auth, sockets);
  app.get("/api/health", async () => ({ ok: true }));
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({ password: z.string().min(1).max(1024) })
        .strict()
        .parse(req.body);
      return auth.login(body.password, reply);
    },
  );
  app.get("/api/auth/status", async () => ({ requiresSetup: !auth.configured() }));
  app.post(
    "/api/auth/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          password: z.string().min(12).max(1024),
        })
        .strict()
        .parse(req.body);
      return auth.setup(body.token, body.password, reply);
    },
  );
  app.get("/api/auth/session", async (req) => ({
    authenticated: true,
    csrf: auth.session(req).csrf,
    expires: auth.session(req).expires,
  }));
  app.post("/api/auth/logout", async (req, reply) => {
    closeSession(auth.logout(req, reply));
    return { ok: true };
  });
  app.get("/api/projects", async (req) => {
    const query = z.object({ refresh: z.enum(["1"]).optional() }).parse(req.query);
    await sessions.catalog.refresh(query.refresh === "1");
    return {
      projects: sessions.catalog.publicProjects(),
      warnings: [...sessions.catalog.errors.values()],
    };
  });
  app.get("/api/machines", async () => ({ machines: sessions.catalog.machines() }));
  app.get("/api/machines/:id/directories", async (req) => {
    const query = z.object({ path: z.string().min(1).max(2048) }).parse(req.query);
    return sessions.catalog.directories(paramId(req), query.path);
  });
  app.post("/api/projects", async (req) => {
    const body = z
      .object({
        machineId: idSchema,
        name: z.string().trim().min(1).max(120),
        workingDirectory: z.string().min(1).max(2048),
        createDirectory: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    const requestKey = key(req);
    return store.once("project:create", requestKey, body, () =>
      sessions.catalog.createProject(
        body.machineId,
        body.name,
        body.workingDirectory,
        body.createDirectory,
        requestKey,
      ),
    );
  });
  app.get("/api/projects/:id/threads", async (req) => {
    const project = sessions.project(paramId(req));
    let warning: string | undefined;
    try {
      await sessions.catalog.syncThreads(project.machineId);
    } catch {
      warning = "Компьютер недоступен. Показаны сохранённые диалоги.";
    }
    return { threads: store.threads(project.id), warning };
  });
  app.get("/api/projects/:id/capabilities", async (req) => sessions.capabilities(paramId(req)));
  app.get("/api/projects/:id/status", async (req) => {
    const p = sessions.project(paramId(req)),
      m = config.machines.find((m) => m.id === p.machineId);
    if (!m) throw new HubError(404, "MACHINE_NOT_FOUND", "Машина не настроена");
    return sessions.status(p.id);
  });
  app.post("/api/projects/:id/threads", async (req) => {
    const id = paramId(req),
      body = z
        .object({ title: z.string().trim().min(1).max(120).default("Новый диалог") })
        .parse(req.body);
    return store.once(`create:${id}`, key(req), body, () => sessions.create(id, body.title));
  });
  app.get("/api/threads/:id/history", async (req) => {
    const id = paramId(req);
    const thread = sessions.thread(id);
    const q = z
      .object({ turnId: idSchema.optional(), before: z.string().max(100).optional() })
      .parse(req.query);
    return {
      ...(thread.origin === "desktop" || thread.historyMode
        ? await sessions.catalog.history(thread, q.before, q.turnId)
        : q.turnId
          ? store.context(id, q.turnId)
          : store.history(id, page(req).before)),
      thread: store.thread(id),
      approvals: sessions.pending(id),
    };
  });
  app.get("/api/threads/:id/source", async (req) => {
    const thread = sessions.thread(paramId(req));
    if (thread.origin !== "desktop" && !thread.historyMode) return { version: 0 };
    return sessions.catalog.readThread(thread);
  });
  app.get("/api/threads/:id/results", async (req) => {
    const id = paramId(req);
    sessions.thread(id);
    return store.results(id, page(req).before);
  });
  app.get("/api/threads/:id/activity", async (req) => {
    const id = paramId(req);
    sessions.thread(id);
    return store.activity(id, page(req).before);
  });
  app.post("/api/threads/:id/resume", async (req) => sessions.resume(paramId(req)));
  app.post("/api/threads/:id/fork", async (req) => {
    const id = paramId(req);
    const body = z
      .object({ attachments: z.array(z.string().uuid()).max(8).default([]) })
      .strict()
      .parse(req.body ?? {});
    return store.once(`fork:${id}`, key(req), body, () => sessions.fork(id, body.attachments));
  });
  app.post("/api/threads/:id/turns", async (req) => {
    const id = paramId(req),
      body = z
        .object({
          text: z.string().trim().max(32000).default(""),
          settings: turnSettingsSchema.optional(),
          attachments: z.array(z.string().uuid()).max(8).default([]),
        })
        .strict()
        .refine((b) => b.text.length > 0 || b.attachments.length > 0)
        .parse(req.body);
    return store.once(`turn:${id}`, key(req), body, () =>
      sessions.startTurn(id, body.text, body.settings, body.attachments),
    );
  });
  app.patch("/api/threads/:id/settings", async (req) =>
    sessions.setSettings(paramId(req), turnSettingsSchema.parse(req.body)),
  );
  app.get("/api/threads/:id/attachments", async (req) => {
    const id = paramId(req);
    sessions.thread(id);
    return { attachments: sessions.attachments.pending(id) };
  });
  app.post(
    "/api/threads/:id/attachments",
    { bodyLimit: MAX_FILE_BYTES, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const id = paramId(req);
      sessions.thread(id);
      const { name } = z
        .object({ name: z.string().min(1).max(240) })
        .strict()
        .parse(req.query);
      if (!Buffer.isBuffer(req.body)) throw new HubError(400, "BINARY_REQUIRED", "Прикрепи файл");
      return sessions.attachments.put(id, name, req.body);
    },
  );
  app.delete("/api/attachments/:id", async (req) => {
    const id = z.string().uuid().parse(paramId(req));
    const file = sessions.attachments.get(id);
    sessions.thread(file.threadId);
    await sessions.attachments.remove(id);
    return { ok: true };
  });
  app.get("/api/attachments/:id", async (req, reply) => {
    const id = z.string().uuid().parse(paramId(req)),
      { file, stream } = sessions.attachments.stream(id);
    sessions.thread(file.threadId);
    return reply
      .type("application/octet-stream")
      .header(
        "Content-Disposition",
        "attachment; filename=\"attachment\"; filename*=UTF-8''" +
          encodeURIComponent(file.name).replace(
            /['()*]/g,
            (c) => `%${c.charCodeAt(0).toString(16)}`,
          ),
      )
      .header("X-Content-Type-Options", "nosniff")
      .send(stream);
  });
  app.get("/api/attachments/:id/preview", async (req, reply) => {
    const id = z.string().uuid().parse(paramId(req)),
      { file, stream } = sessions.attachments.stream(id, true);
    sessions.thread(file.threadId);
    return reply
      .type("image/jpeg")
      .header("Content-Disposition", 'inline; filename="preview.jpg"')
      .header("X-Content-Type-Options", "nosniff")
      .send(stream);
  });
  app.post("/api/threads/:id/interrupt", async (req) => sessions.interrupt(paramId(req)));
  app.post("/api/approvals/:id", async (req) => {
    const id = paramId(req),
      body = z.object({ decision: z.enum(["accept", "decline"]) }).parse(req.body);
    return store.once(`approval:${id}`, key(req), body, () => sessions.approve(id, body.decision));
  });
  app.post("/api/approvals/:id/answers", async (req) => {
    const id = paramId(req),
      body = z
        .object({
          answers: z.record(
            z.string().min(1).max(200),
            z.array(z.string().max(8000)).min(1).max(10),
          ),
        })
        .parse(req.body);
    return store.once(`answer:${id}`, key(req), body, () => sessions.answer(id, body.answers));
  });
  app.get("/api/artifacts/:id", async (req, reply) => {
    const id = z.string().uuid().parse(paramId(req)),
      artifact = artifacts.get(id);
    sessions.thread(artifact.threadId);
    return reply
      .header("Content-Type", artifact.mime)
      .header("Content-Disposition", 'inline; filename="screenshot.png"')
      .header("X-Content-Type-Options", "nosniff")
      .send(artifact.data);
  });
  app.post("/api/threads/:id/screenshots", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const id = paramId(req),
      body = z
        .object({
          png: z
            .string()
            .min(40)
            .max(12 * 1024 * 1024),
        })
        .parse(req.body),
      t = sessions.thread(id);
    return store.once(`screenshot:${id}`, key(req), body, async () => {
      const artifact = artifacts.putPng(id, body.png);
      const turnId = t.activeTurnId ?? store.history(id).messages.at(-1)?.turnId ?? null;
      const resultId = store.result(
        id,
        turnId,
        artifact.artifactId,
        "image",
        "Снимок рабочего стола",
        artifact,
      );
      sessions.emit(
        "event",
        store.append(id, "result.created", { id: resultId, type: "image" }, turnId),
      );
      return { id: resultId, ...artifact };
    });
  });
  app.get("/api/preferences", async () => store.preferences());
  app.patch("/api/preferences", async (req) =>
    store.setPreferences(
      z
        .object({
          theme: z.enum(["organizer", "crt-green", "hitech-2000s"]).optional(),
          projectId: idSchema.optional(),
          threadId: idSchema.optional(),
          view: z.enum(["chat", "results", "remote", "activity"]).optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.get(
    "/api/projects/:id/remote",
    {
      websocket: true,
      preValidation: async (req) => {
        auth.requireOrigin(req);
        auth.session(req);
        const p = sessions.project(paramId(req));
        const m = config.machines.find((m) => m.id === p.machineId);
        if (!m) throw new HubError(404, "MACHINE_NOT_FOUND", "Машина не настроена");
        remoteProvider(m);
      },
    },
    (socket, req) => {
      const p = sessions.project(paramId(req)),
        m = config.machines.find((m) => m.id === p.machineId);
      if (!m) {
        socket.close(1008);
        return;
      }
      const result = z
        .object({
          width: z.coerce.number().int().min(320).max(3840).default(1280),
          height: z.coerce.number().int().min(240).max(2160).default(800),
        })
        .safeParse(req.query);
      if (!result.success) {
        socket.close(1008);
        return;
      }
      const session = auth.session(req);
      sockets.set(socket, session.tokenHash);
      const close = connectRemote(socket, remoteProvider(m), result.data);
      const timer = setInterval(() => {
        try {
          auth.session(req);
        } catch {
          close();
        }
      }, 25000);
      timer.unref();
      socket.once("close", () => {
        clearInterval(timer);
        sockets.delete(socket);
      });
    },
  );
  app.get(
    "/api/events",
    {
      websocket: true,
      preValidation: async (req) => {
        auth.requireOrigin(req);
        auth.session(req);
      },
    },
    (socket, req) => {
      let cursor: number, threadId: string;
      try {
        const q = z
          .object({
            threadId: idSchema,
            after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          })
          .parse(req.query);
        sessions.thread(q.threadId);
        threadId = q.threadId;
        cursor = q.after;
      } catch {
        socket.close(1008, "Invalid subscription");
        return;
      }
      const session = auth.session(req);
      sockets.set(socket, session.tokenHash);
      const send = (event: Record<string, unknown> | HubEvent) => {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.close(1013, "Refresh history");
          return;
        }
        socket.send(JSON.stringify(event));
      };
      const onEvent = (event: HubEvent) => {
        if (event.threadId === threadId && event.seq > cursor) {
          cursor = event.seq;
          send(event);
        }
      };
      sessions.on("event", onEvent);
      const backlog = store.events(threadId, cursor, 501);
      if (backlog.length > 500) send({ type: "history.refresh" });
      else for (const event of backlog) onEvent(event);
      send({
        type: "connection.ready",
        lastSeq: store.lastSeq(threadId),
        thread: store.thread(threadId),
        approvals: sessions.pending(threadId),
      });
      const timer = setInterval(() => {
        try {
          auth.session(req);
        } catch {
          socket.close(1008, "Session expired");
          return;
        }
        if (socket.readyState === 1) socket.ping();
      }, 25000);
      timer.unref();
      const cleanup = () => {
        clearInterval(timer);
        sockets.delete(socket);
        sessions.off("event", onEvent);
      };
      socket.once("close", cleanup);
      socket.on("error", () => socket.close());
      socket.on("message", () => socket.close(1008, "Read-only stream"));
    },
  );
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(staticFiles, {
      root: options.webRoot,
      prefix: "/",
      maxAge: 0,
      setHeaders(response, path) {
        if (["index.html", "sw.js", "version.json"].includes(basename(path)))
          response.header("Cache-Control", "no-store");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Не найдено" } });
      return reply.header("Cache-Control", "no-store").sendFile("index.html");
    });
  }
  app.addHook("onClose", async () => {
    for (const socket of sockets.keys()) socket.close(1001, "Server restarting");
    await sessions.close();
    store.close();
  });
  return { app, store, sessions, auth };
}
