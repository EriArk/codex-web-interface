import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type {
  inspectMachineStaging,
  runGuiPreview,
  runProjectDelivery,
  runProjectSetup,
} from "@codex-web/machines";
import { bindMachineAuthority, projectPathAllowed } from "@codex-web/machines";
import {
  caseColorIds,
  type HubConfig,
  HubError,
  type HubEvent,
  resultCategorySchema,
  turnSettingsSchema,
} from "@codex-web/shared";
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
import { registerBridgeDoctor } from "./bridge-doctor.js";
import { registerChunkUploads } from "./chunk-uploads.js";
import { registerCommandOutput } from "./command-output.js";
import { registerContentSearch } from "./content-search.js";
import { registerDeploymentStatus } from "./deployment-status.js";
import { type DesktopTransport, registerDesktop } from "./desktop.js";
import { type DeviceDependencies, registerDevices } from "./devices.js";
import { registerDictation, type Transcribe } from "./dictation.js";
import { ENGINE_PROTOCOL } from "./engine-client.js";
import { registerFilePreviews } from "./filePreviews.js";
import { registerGpt } from "./gpt.js";
import { configuredNativeGpt } from "./gpt-native-config.js";
import type { NativeGptWorkspace } from "./gpt-native-provider.js";
import { registerGuiPreviews } from "./gui-previews.js";
import { ProjectIntake, registerIntake } from "./intake.js";
import { IssueDrawer, registerIssueDrawer } from "./issue-drawer.js";
import { entityAction, libraryMutation } from "./library.js";
import { type MachineProbeDependencies, registerMachineHealth } from "./machineHealth.js";
import { NativePlans, registerNativePlans } from "./native-plan.js";
import { registerNavigation } from "./navigation.js";
import { registerNotebook } from "./notebook.js";
import { registerProjectOverview } from "./overview.js";
import { assertPreviewFrame, previewCsp } from "./previews.js";
import type { ProjectActionPolicy } from "./project-actions.js";
import { registerProjectCores } from "./project-core.js";
import { registerProjectDelivery } from "./project-delivery.js";
import { registerProjectGpt } from "./project-gpt.js";
import { registerProjectSetup } from "./project-setup.js";
import { registerProjectWork } from "./project-work.js";
import { registerProjectInspector } from "./projectInspector.js";
import { type PushOptions, registerPush } from "./push.js";
import { registerQueue } from "./queue.js";
import { registerQuickCapture } from "./quick-capture.js";
import { registerRelays } from "./relay-routes.js";
import { connectRemote, remoteProvider } from "./remote.js";
import { resolveResultReference, resultReferenceSchema } from "./result-references.js";
import { Sessions } from "./sessions.js";
import { registerSpeech } from "./speech.js";
import { registerStagingStorage } from "./staging-storage.js";
import { storageReport } from "./storage.js";
import { Store } from "./store.js";
import { registerWorkspaceTasks } from "./tasks.js";
import { registerUsageResets } from "./usage-resets.js";
import { webSecurity } from "./web-security.js";

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
    executionService?: boolean;
    webRoot?: string;
    store?: Store;
    sessions?: Sessions;
    logger?: boolean;
    push?: PushOptions;
    desktopTransport?: DesktopTransport;
    machineDiagnostics?: MachineProbeDependencies;
    projectSetupProbe?: typeof runProjectSetup;
    projectDeliveryProbe?: typeof runProjectDelivery;
    guiPreviewProbe?: typeof runGuiPreview;
    stagingProbe?: typeof inspectMachineStaging;
    devices?: DeviceDependencies;
    transcribe?: Transcribe;
    nativeGpt?: NativeGptWorkspace;
    auth?: Auth;
    authorizeExecution?: () => void;
    ownerUserId?: string;
    projectActionPolicy?: ProjectActionPolicy;
    collaborationPolicy?: {
      gptContext?: (projectId: string) => unknown;
      gptScope?: (projectId: string) => unknown;
      issuesPublished?: (
        projectId: string,
        batchId: string,
        issues: { number: number; url: string }[],
      ) => void;
      instructions: (projectId: string) => string | null;
      delivery: NonNullable<Parameters<typeof registerProjectDelivery>[3]>;
    };
    keepStoreOpen?: boolean;
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
  if (options.authorizeExecution) sessions.authorizeExecution = options.authorizeExecution;
  if (options.collaborationPolicy)
    sessions.projectInstructions = options.collaborationPolicy.instructions;
  const releaseAuthorities = options.authorizeExecution
    ? config.machines.map((machine) => bindMachineAuthority(machine, options.authorizeExecution!))
    : [];
  app.addHook("onClose", async () => {
    for (const release of releaseAuthorities) release();
  });
  const auth = options.auth ?? new Auth(config, store);
  if (options.executionService) {
    const instance = randomUUID();
    app.get("/internal/runtime", async () => ({
      protocol: ENGINE_PROTOCOL,
      schema: store.schemaVersion,
      revision: process.env.HUB_REVISION ?? "unknown",
      instance,
    }));
  }
  const artifacts = new Artifacts(config.hub.resultsPath, store, config.hub.storage.artifactBytes);
  await auth.prepare(options.setupToken);
  await app.register(cookie);
  await app.register(helmet, webSecurity(config));
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
  registerCommandOutput(app, sessions);
  const devices = registerDevices(app, config, store, auth, options.devices);
  registerDeploymentStatus(app, store, () => devices.maintenance(), {
    auth,
    databasePath: config.hub.databasePath,
  });
  if (options.executionService) {
    app.get("/internal/terminals/maintenance", () => devices.maintenance());
    app.post("/internal/terminals/maintenance", () => devices.maintenance(true));
  }
  registerSpeech(app, config, auth);
  const nativeGpt =
    options.nativeGpt ?? configuredNativeGpt(config, options.authorizeExecution ?? (() => {}));
  registerDictation(app, config, auth, options.transcribe ?? nativeGpt?.transcribe);
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES },
    (_req, body, done) => done(null, body),
  );
  const sockets = new Map<WebSocket, string>();
  const closeSession = (token: string) => {
    devices.sweep();
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
  const gpt = registerGpt(app, config, store, options.authorizeExecution, nativeGpt);
  const projectGpts = registerProjectGpt(
    app,
    sessions,
    gpt,
    options.collaborationPolicy?.gptContext,
    options.ownerUserId,
    options.collaborationPolicy?.gptScope,
  );
  registerChunkUploads(app, config, store, sessions.attachments, gpt, options.authorizeExecution);
  registerContentSearch(app, sessions, gpt);
  const bridgeDoctor = registerBridgeDoctor(app, sessions, gpt);
  const push = registerPush(app, store, auth, config.hub.publicBaseUrl, {
    ...options.push,
    projectName: (id) => sessions.catalog.projects().find((project) => project.id === id)?.name,
  });
  registerNavigation(app, store, sessions, auth, sockets);
  const queue = registerQueue(app, sessions, store);
  registerDesktop(app, config, store, sessions, options.desktopTransport);
  let storageCache: { until: number; pending: ReturnType<typeof storageReport> } | undefined;
  app.get("/api/storage", async () => {
    if (!storageCache || storageCache.until < Date.now()) {
      const pending = storageReport(config, store.db);
      storageCache = { until: Date.now() + 60000, pending };
      void pending.catch(() => {
        if (storageCache?.pending === pending) storageCache = undefined;
      });
    }
    return storageCache.pending;
  });
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
  const closeAllSessions = () => {
    devices.sweep();
    for (const socket of sockets.keys()) socket.close(1008, "Session ended");
  };
  const unsubscribeRevocation = auth.subscribeRevocation((hash) =>
    hash ? closeSession(hash) : closeAllSessions(),
  );
  app.post(
    "/api/auth/password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          currentPassword: z.string().min(1).max(1024),
          password: z.string().min(12).max(1024),
        })
        .strict()
        .parse(req.body);
      const result = await auth.changePassword(req, body.currentPassword, body.password, reply);
      closeAllSessions();
      return result;
    },
  );
  app.post(
    "/api/auth/logout-all",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      auth.logoutAll(req, reply);
      closeAllSessions();
      return { ok: true };
    },
  );
  app.post(
    "/api/auth/recover",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          password: z.string().min(12).max(1024),
        })
        .strict()
        .parse(req.body);
      const result = await auth.recover(body.token, body.password, reply);
      closeAllSessions();
      return result;
    },
  );
  // The private GPT gateway watches only its own session, not owner data.
  app.get(
    "/api/auth/watch",
    {
      websocket: true,
      preValidation: async (req) => {
        auth.requireOrigin(req);
        auth.session(req);
      },
    },
    (socket, req) => {
      sockets.set(socket, auth.session(req).tokenHash);
      socket.send(JSON.stringify({ type: "session.ready" }));
      const timer = setInterval(() => {
        try {
          auth.session(req);
          socket.ping();
        } catch {
          socket.close(1008, "Session expired");
        }
      }, 25000);
      timer.unref();
      socket.once("close", () => {
        clearInterval(timer);
        sockets.delete(socket);
      });
      socket.on("error", () => socket.close());
      socket.on("message", () => socket.close(1008, "Read-only stream"));
    },
  );
  app.post("/api/library/codex/:kind/:id", async (req) => {
    const params = z
      .object({ kind: z.enum(["thread", "project"]), id: idSchema })
      .parse(req.params);
    const action = entityAction.parse(req.body);
    return store.once(
      "library:codex:" + params.kind + ":" + params.id,
      key(req),
      action,
      async () => {
        await libraryMutation(() => sessions.manageEntity(params.kind, params.id, action));
        return { ok: true };
      },
    );
  });
  app.get("/api/library/codex/archived", async (req) => {
    const q = z
      .object({ machineId: idSchema.optional(), cursor: z.string().max(4000).optional() })
      .parse(req.query);
    const machine = q.machineId ?? config.machines[0]?.id;
    if (!machine) return { items: [], nextCursor: null };
    const page = await sessions.catalog.archivedThreads(machine, q.cursor);
    return {
      ...page,
      items: [
        ...(!q.cursor
          ? sessions.catalog.library
              .archived()
              .filter((e) => e.kind === "project" || e.localArchive)
              .map((e) => ({ ...e, id: e.localId ?? e.id }))
          : []),
        ...page.items,
      ],
      machines: sessions.catalog.machines().map((m) => ({ id: m.id, name: m.name })),
    };
  });
  app.get("/api/projects", async (req) => {
    const query = z.object({ refresh: z.enum(["1"]).optional() }).parse(req.query);
    await sessions.catalog.refresh(query.refresh === "1");
    return {
      projects: sessions.catalog.publicProjects(),
      warnings: [...sessions.catalog.errors.values()],
    };
  });
  app.get("/api/machines", async () => {
    await sessions.catalog.refresh();
    return { machines: sessions.catalog.machines() };
  });
  registerUsageResets(app, sessions);
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
    return {
      threads: store
        .threads(project.id)
        .filter((t) => !t.diagnostic)
        .filter((t) =>
          projectPathAllowed(
            sessions.catalog.machine(project.machineId),
            t.workingDirectory || project.workingDirectory,
          ),
        )
        .map((t) => ({
          ...t,
          pinned: sessions.catalog.library.get("thread", t.codexThreadId)?.pinned === true,
        })),
      warning,
    };
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
      .object({
        turnId: idSchema.optional(),
        messageId: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z0-9_:.-]+$/)
          .optional(),
        before: z.string().max(100).optional(),
      })
      .parse(req.query);
    return {
      ...(thread.origin === "desktop" || thread.historyMode
        ? q.messageId
          ? await sessions.catalog.messageContext(thread, q.messageId, q.turnId)
          : await sessions.catalog.history(thread, q.before, q.turnId)
        : q.turnId || q.messageId
          ? store.context(id, q.turnId ?? "", q.messageId)
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
  app.get("/api/projects/:id/results", async (req) => {
    const id = paramId(req);
    sessions.project(id);
    const category = z
      .object({ category: resultCategorySchema.default("all") })
      .parse(req.query).category;
    return store.projectResults(id, page(req).before, category);
  });
  app.get("/api/projects/:id/results/:resultId", async (req) => {
    const p = z.object({ id: idSchema, resultId: idSchema }).parse(req.params);
    sessions.project(p.id);
    const row = store.db
      .prepare(
        "SELECT r.threadId FROM results r JOIN threads t ON t.id=r.threadId WHERE r.id=? AND t.projectId=?",
      )
      .get(p.resultId, p.id);
    if (!row) throw new HubError(404, "RESULT_NOT_FOUND", "Результат не найден.");
    return store.resultById(String(row.threadId), p.resultId);
  });
  app.post("/api/artifact-captures/:id/retry", async (req, reply) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(paramId(req));
    const capture = sessions.catalog.artifacts.get(id);
    sessions.thread(capture.threadId);
    void sessions.catalog.artifacts.capture(id).catch(() => {});
    return reply.code(202).send({ status: sessions.catalog.artifacts.get(id).status });
  });
  app.post("/api/threads/:id/results/reveal", async (req) => {
    const thread = sessions.thread(paramId(req));
    const project = sessions.project(thread.projectId);
    const machine = sessions.catalog.machine(project.machineId);
    return resolveResultReference(
      store,
      thread,
      machine,
      thread.workingDirectory || project.workingDirectory,
      resultReferenceSchema.parse(req.body),
    );
  });
  app.get("/api/threads/:id/results", async (req) => {
    const id = paramId(req);
    sessions.thread(id);
    const category = z
      .object({ category: resultCategorySchema.default("all") })
      .parse(req.query).category;
    return store.results(id, page(req).before, category);
  });
  app.get("/api/threads/:id/results/:resultId", async (req) => {
    const p = z.object({ id: idSchema, resultId: idSchema }).parse(req.params);
    sessions.thread(p.id);
    return store.resultById(p.id, p.resultId);
  });
  app.get("/api/threads/:id/progress", async (req) => {
    const id = paramId(req),
      thread = sessions.thread(id);
    const query = z.object({ turnId: idSchema.optional() }).strict().parse(req.query);
    const turnId = query.turnId ?? thread.activeTurnId;
    const work = sessions.nativeWork.snapshot(id, turnId);
    return { ...store.progressDetails(id, turnId || work.turnId), ...work };
  });
  app.get("/api/threads/:id/context", async (req) => {
    const id = paramId(req);
    sessions.thread(id);
    return { usage: sessions.nativeWork.snapshot(id).usage };
  });
  app.get("/api/projects/:id/native-inventory", async (req) => sessions.inventory(paramId(req)));
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
  app.get("/api/threads/:id/settings", async (req) => {
    const t = sessions.thread(paramId(req));
    return store.threadSettings(t.id) ?? (await sessions.capabilities(t.projectId)).defaults;
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
  app.get("/api/approvals/:id/open", async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return reply.redirect(sessions.elicitationUrl(paramId(req)));
  });
  app.post("/api/approvals/:id/elicitation", async (req) => {
    const id = paramId(req),
      body = z
        .object({
          action: z.enum(["accept", "decline", "cancel"]),
          content: z
            .record(
              z.string().max(200),
              z.union([
                z.string().max(8000),
                z.number().finite(),
                z.boolean(),
                z.array(z.string().max(2000)).max(100),
              ]),
            )
            .optional(),
        })
        .strict()
        .parse(req.body);
    return store.once(`elicitation:${id}`, key(req), body, () =>
      sessions.elicit(id, body.action, body.content),
    );
  });
  app.get("/api/native-images/:id", async (req, reply) => {
    const id = z.string().uuid().parse(paramId(req));
    sessions.thread(sessions.catalog.images.thread(id));
    const image = await sessions.catalog.images.get(id);
    return reply
      .type(image.mime)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", 'inline; filename="image.png"')
      .send(image.data);
  });
  registerFilePreviews(app, auth);
  registerProjectInspector(app, sessions);
  registerProjectSetup(app, sessions, options.projectSetupProbe);
  registerProjectDelivery(
    app,
    sessions,
    options.projectDeliveryProbe,
    options.collaborationPolicy?.delivery,
  );
  registerMachineHealth(app, sessions, options.machineDiagnostics);
  registerStagingStorage(app, config, options.stagingProbe);
  registerNotebook(app, sessions);
  registerProjectCores(app, sessions);
  const projectWork = registerProjectWork(app, sessions, gpt, queue, options.projectActionPolicy);
  const intake = new ProjectIntake(
    sessions,
    projectGpts.bindings,
    projectWork,
    options.collaborationPolicy?.gptScope,
  );
  registerIntake(app, intake);
  const issueDrawer = new IssueDrawer(
    sessions,
    gpt,
    projectGpts,
    options.collaborationPolicy?.gptScope,
    options.collaborationPolicy?.issuesPublished,
  );
  registerIssueDrawer(app, issueDrawer);
  registerNativePlans(app, new NativePlans(sessions, projectWork.context));
  registerRelays(app, sessions, projectWork, queue);
  registerGuiPreviews(app, sessions, artifacts, projectWork.context, options.guiPreviewProbe);
  registerWorkspaceTasks(app, sessions);
  registerQuickCapture(app, sessions);
  registerProjectOverview(app, sessions, projectWork);
  app.get("/api/previews/:id/ready", async (req) => {
    const id = paramId(req);
    sessions.thread(sessions.catalog.previews.thread(id));
    await sessions.catalog.previews.document(id);
    return { ready: true };
  });
  app.get("/api/previews/:id", async (req, reply) => {
    assertPreviewFrame(req.headers);
    const id = paramId(req);
    sessions.thread(sessions.catalog.previews.thread(id));
    const document = await sessions.catalog.previews.document(id);
    return reply
      .header("Content-Security-Policy", previewCsp)
      .removeHeader("X-Frame-Options")
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
      .type("text/html; charset=utf-8")
      .send(document);
  });
  app.get("/api/artifacts/:id", async (req, reply) => {
    const id = z.string().uuid().parse(paramId(req)),
      artifact = artifacts.describe(id);
    sessions.thread(artifact.threadId);
    let range: { start: number; end: number } | undefined;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, artifact.bytes - Number(match[2]));
        const end =
          match[1] && match[2]
            ? Math.min(Number(match[2]), artifact.bytes - 1)
            : artifact.bytes - 1;
        if (
          Number.isSafeInteger(start) &&
          Number.isSafeInteger(end) &&
          start >= 0 &&
          start <= end &&
          start < artifact.bytes
        )
          range = { start, end };
      }
      if (!range)
        return reply.code(416).header("Content-Range", `bytes */${artifact.bytes}`).send();
      reply
        .code(206)
        .header("Content-Range", `bytes ${range.start}-${range.end}/${artifact.bytes}`);
    }
    // Open only after authorization. Fastify streams with backpressure through the
    // gateway; a 400 MB export never becomes a Buffer in either server.
    const stream = artifacts.stream(id, range);
    return reply
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "private, no-store")
      .header("Content-Length", range ? range.end - range.start + 1 : artifact.bytes)
      .header(
        "Content-Type",
        /^image\/(png|jpeg|webp|gif)$/.test(artifact.mime)
          ? artifact.mime
          : "application/octet-stream",
      )
      .header(
        "Content-Disposition",
        (/^image\/(png|jpeg|webp|gif)$/.test(artifact.mime) ? "inline" : "attachment") +
          "; filename*=UTF-8''" +
          encodeURIComponent(artifact.name),
      )
      .header("X-Content-Type-Options", "nosniff")
      .send(stream);
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
          theme: z.enum(["organizer", "crt-green", "hitech-2000s", "classic-dark"]).optional(),
          crtCaseColor: z.enum(caseColorIds).optional(),
          hitechCaseColor: z.enum(caseColorIds).optional(),
          organizerAccentColor: z.enum(caseColorIds).optional(),
          darkAccentColor: z.enum(caseColorIds).optional(),
          projectId: idSchema.optional(),
          threadId: idSchema.nullable().optional(),
          view: z.enum(["chat", "results", "remote", "activity", "files", "overview"]).optional(),
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
    unsubscribeRevocation();
    for (const socket of sockets.keys()) socket.close(1001, "Server restarting");
    await bridgeDoctor.close();
    await issueDrawer.close();
    await push.close();
    await sessions.close();
    if (!options.keepStoreOpen) store.close();
  });
  return { app, store, sessions, auth, push, gpt, projectWork, projectGpts, intake, issueDrawer };
}
