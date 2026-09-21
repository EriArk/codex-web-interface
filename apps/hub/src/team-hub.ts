import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type HubConfig, HubError, teamLoginSchema, teamNameSchema } from "@codex-web/shared";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import { createApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerCollaborationSpaces } from "./collaboration-routes.js";
import { deploymentBlockers } from "./deployment-status.js";
import { ENGINE_PROTOCOL, engineTerminalWork } from "./engine-client.js";
import { prepareEngineSocket } from "./engine-socket.js";
import {
  enrolledRuntime,
  enrollmentBundle,
  enrollmentKeys,
  verifyEnrollment,
} from "./machine-enrollment.js";
import { MachineEnrollmentStore } from "./machine-enrollment-store.js";
import { proxyPrivateHttp, proxyPrivateSocket } from "./private-proxy.js";
import { Store } from "./store.js";
import { sessionCookie, TeamAuth } from "./team-auth.js";
import { registerTeamBridges } from "./team-bridge-routes.js";
import { TeamBridgeRuns } from "./team-bridge-runs.js";
import { TeamBridgeSources } from "./team-bridge-sources.js";
import { TeamBridges } from "./team-bridges.js";
import { registerTeamConsultations } from "./team-consultation-routes.js";
import { TeamConsultations } from "./team-consultations.js";
import { registerTeamExecutions } from "./team-execution-routes.js";
import { TeamExecutions } from "./team-executions.js";
import { type GitHubProbe, TeamGitHub } from "./team-github.js";
import { registerTeamGitHub } from "./team-github-routes.js";
import { TeamGpt } from "./team-gpt.js";
import { registerTeamLinks } from "./team-link-routes.js";
import { TeamLinks } from "./team-links.js";
import { memberSetupStatus, saveMemberSetup } from "./team-onboarding.js";
import { registerTeamProjects } from "./team-project-routes.js";
import { TeamProjects } from "./team-projects.js";
import { attachTeamRelayTools } from "./team-relay-tools.js";
import { sharedRotationPolicy } from "./team-rotation-context.js";
import { publicUser, TeamStore } from "./team-store.js";
import { webSecurity } from "./web-security.js";

export function privateDirectory(path: string) {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(absolute) !== absolute ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("TEAM_DIRECTORY_UNSAFE");
  } else {
    // Check every existing ancestor before creating anything through it.
    let ancestor = dirname(absolute);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (realpathSync(ancestor) !== ancestor) throw new Error("TEAM_DIRECTORY_UNSAFE");
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  chmodSync(absolute, 0o700);
  return absolute;
}

/** A new account starts with no execution or consumer-account fallback. */
export function privateConfig(config: HubConfig, registry: TeamStore, userId: string): HubConfig {
  const user = registry.active(userId);
  const blocked =
    registry.db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()?.value ===
    "blocked";
  const enrolled = blocked
    ? { machines: [], devices: [] }
    : enrolledRuntime(config, registry, userId);
  if (user.id === registry.ownerId && user.legacy)
    return {
      ...config,
      nativeGpt: !blocked && config.nativeGpt?.userId === user.id ? config.nativeGpt : undefined,
      machines: blocked ? [] : [...structuredClone(config.machines), ...enrolled.machines],
      devices: blocked ? [] : [...structuredClone(config.devices), ...enrolled.devices],
      projects: blocked ? [] : structuredClone(config.projects),
      gpt: new TeamGpt(config, registry).runtime(userId),
    };
  const root = privateDirectory(join(config.team!.root, "users", user.id));
  return {
    hub: { ...config.hub, databasePath: join(root, "app.db"), resultsPath: join(root, "results") },
    auth: { username: user.login },
    gpt: new TeamGpt(config, registry).runtime(userId),
    nativeGpt: new TeamGpt(config, registry).nativeRuntime(userId),
    machines: enrolled.machines,
    projects: [],
    devices: enrolled.devices,
  };
}

type PersonalApp = Awaited<ReturnType<typeof createApp>>;
type Options = Omit<NonNullable<Parameters<typeof createApp>[1]>, "auth" | "sessions"> & {
  socketRoot: string;
  personalFactory?: typeof createApp;
  enrollmentVerifier?: typeof verifyEnrollment;
  githubProbe?: GitHubProbe;
};
const credentials = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(1024),
  })
  .strict();
const slow = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

/** Authentication router. Existing personal APIs are mounted behind private, user-bound sockets. */
export async function createTeamHub(config: HubConfig, options: Options) {
  if (!config.team?.enabled) throw new Error("TEAM_DISABLED");
  privateDirectory(config.team.root);
  const socketRoot = privateDirectory(options.socketRoot);
  const ownerStore = options.store ?? new Store(config.hub.databasePath);
  const registry = new TeamStore(join(config.team.root, "team.db"), config, ownerStore);
  const enrollments = new MachineEnrollmentStore(registry);
  const teamGpt = new TeamGpt(config, registry);
  const teamProjects = new TeamProjects(registry);
  const teamLinks = new TeamLinks(teamProjects);
  const auth = new TeamAuth(config, ownerStore, registry);
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
    bodyLimit: 256 * 1024,
    requestTimeout: 60000,
    trustProxy: false,
  });
  const instances = new Map<string, Promise<{ runtime: PersonalApp; socket: string }>>();
  const failed = new Set<string>();
  const connections = new Map<string, Map<() => void, string>>();
  const reconfiguring = new Set<string>();
  const privateMutations = new Map<string, number>();
  let closing = false,
    maintenanceUntil = 0,
    activeMutations = 0;
  const maintenanceActive = () => Date.now() < maintenanceUntil;
  const maintenanceError = () =>
    new HubError(503, "ENGINE_MAINTENANCE", "Обновление сервиса. Черновик сохранён.");
  let teamExecutions: TeamExecutions;
  let teamConsultations: TeamConsultations;
  let teamBridgeRuns: TeamBridgeRuns;
  const teamBridges = new TeamBridges(teamLinks);
  const personal = (userId: string) => {
    registry.active(userId);
    if (closing) throw new HubError(503, "WORKSPACE_CLOSING", "Сервис переподключается.");
    if (reconfiguring.has(userId))
      throw new HubError(
        503,
        "WORKSPACE_RECONFIGURING",
        "Применяется подключение. Черновики сохранены.",
      );
    let pending = instances.get(userId);
    if (!pending) {
      if (maintenanceActive()) throw maintenanceError();
      pending = (async () => {
        const selected = privateConfig(config, registry, userId);
        const initialized = registry.db
          .prepare("SELECT initialized FROM team_namespaces WHERE userId=?")
          .get(userId)?.initialized;
        if (initialized !== 0 && initialized !== 1) throw new Error("TEAM_NAMESPACE_MISSING");
        if (initialized && !existsSync(selected.hub.databasePath))
          throw new Error("TEAM_USER_STORAGE_MISSING");
        if (
          existsSync(selected.hub.databasePath) &&
          (lstatSync(selected.hub.databasePath).isSymbolicLink() ||
            !lstatSync(selected.hub.databasePath).isFile())
        )
          throw new Error("TEAM_USER_STORAGE_UNSAFE");
        const store =
          userId === registry.ownerId ? ownerStore : new Store(selected.hub.databasePath);
        registry.db.prepare("UPDATE team_namespaces SET initialized=1 WHERE userId=?").run(userId);
        const scoped = new TeamAuth(selected, store, registry, userId);
        let runtime: PersonalApp | undefined;
        try {
          const socket = join(socketRoot, `${userId}.sock`);
          if (Buffer.byteLength(socket) > 100) throw new Error("TEAM_SOCKET_PATH_TOO_LONG");
          await prepareEngineSocket(socket);
          runtime = await (options.personalFactory ?? createApp)(selected, {
            ...options,
            nativeGpt: userId === registry.ownerId ? options.nativeGpt : undefined,
            webRoot: undefined,
            store,
            auth: scoped,
            keepStoreOpen: userId === registry.ownerId,
            executionService: true,
            projectActionPolicy: {
              prepare: (action) => {
                teamExecutions.policy(userId, () => runtime).prepare(action);
                sharedRotationPolicy(teamProjects, userId, () => runtime).prepare(action);
              },
              dispatch: (action, queued) => {
                teamExecutions.policy(userId, () => runtime).dispatch(action, queued);
                sharedRotationPolicy(teamProjects, userId, () => runtime).dispatch(action, queued);
              },
              beforeSubmit: async (action) => {
                await teamExecutions.policy(userId, () => runtime).beforeSubmit(action);
                await sharedRotationPolicy(teamProjects, userId, () => runtime).beforeSubmit(
                  action,
                );
              },
              beforeCommit: (action) => {
                teamExecutions.policy(userId, () => runtime).beforeCommit(action);
                sharedRotationPolicy(teamProjects, userId, () => runtime).beforeCommit(action);
              },
            },
            authorizeExecution: () => {
              registry.active(userId);
              if (maintenanceActive()) throw maintenanceError();
              if (reconfiguring.has(userId))
                throw new HubError(503, "WORKSPACE_RECONFIGURING", "Применяется подключение.");
              if (
                registry.db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()
                  ?.value === "blocked"
              )
                throw new HubError(
                  503,
                  "RESTORE_ADMISSION_REQUIRED",
                  "После восстановления подключения проверяет администратор сервера.",
                );
            },
          });
          attachTeamRelayTools(
            userId,
            runtime,
            teamLinks,
            teamConsultations,
            (actor, threadId, turnId) => teamBridgeRuns.participating(actor, threadId, turnId),
          );
          await runtime.app.listen({ path: socket });
          chmodSync(socket, 0o600);
          return { runtime, socket };
        } catch (error) {
          scoped.dispose();
          if (runtime) await runtime.app.close().catch(() => {});
          else if (userId !== registry.ownerId) store.close();
          throw error;
        }
      })();
      instances.set(userId, pending);
      void pending.catch(() => {
        failed.add(userId);
      });
    }
    return pending;
  };
  const authorizeSharedExecution = () => {
    if (closing || maintenanceActive()) throw maintenanceError();
    if (
      registry.db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()
        ?.value === "blocked"
    )
      throw new HubError(
        503,
        "RESTORE_ADMISSION_REQUIRED",
        "После восстановления подключения проверяет администратор сервера.",
      );
  };
  teamExecutions = new TeamExecutions(teamProjects, personal, authorizeSharedExecution);
  teamConsultations = new TeamConsultations(teamLinks, personal, authorizeSharedExecution);
  teamBridgeRuns = new TeamBridgeRuns(
    teamBridges,
    teamConsultations,
    personal,
    authorizeSharedExecution,
  );
  const teamGitHub = new TeamGitHub(
    teamProjects,
    teamBridges,
    personal,
    authorizeSharedExecution,
    options.githubProbe,
  );
  const track = (
    userId: string,
    hash: string,
    cancel: () => void,
    onClose: (done: () => void) => void,
  ) => {
    let set = connections.get(userId);
    if (!set) {
      set = new Map();
      connections.set(userId, set);
    }
    set.set(cancel, hash);
    const saved = set;
    onClose(() => {
      saved.delete(cancel);
      if (!saved.size) connections.delete(userId);
    });
  };
  const revoked = (userId: string, hash?: string) => {
    const set = connections.get(userId);
    if (!set) return;
    for (const [cancel, sessionHash] of set)
      if (!hash || hash === sessionHash) {
        cancel();
        set.delete(cancel);
      }
    if (!set.size) connections.delete(userId);
  };
  registry.events.on("revoked", revoked);
  await app.register(cookie);
  await app.register(helmet, webSecurity(config));
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    // Unix-domain requests have no remote IP. The default limiter normalizer
    // dereferences it before allowList, breaking even the engine handshake.
    keyGenerator: (req) => req.ip ?? "private-unix",
    allowList: (req) => !req.url.startsWith("/api/"),
  });
  await auth.prepare();
  auth.install(app);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (maintenanceActive()) throw maintenanceError();
    activeMutations++;
    // Covers streamed proxy responses and aborted requests as well as local auth/admin actions.
    reply.raw.once("close", () => {
      activeMutations--;
    });
  });
  app.setErrorHandler((error, req, reply) => {
    const status =
      error instanceof HubError
        ? error.statusCode
        : error instanceof ZodError
          ? 400
          : ((error as { statusCode?: number }).statusCode ?? 500);
    if ([403, 409].includes(status) && req.url.startsWith("/api/team/")) {
      try {
        const current = auth.session(req);
        const target =
          /^\/api\/team\/users\/([a-f0-9-]{36})(?:\/|$)/.exec(req.url)?.[1] ?? "installation";
        registry.audit(current.user.id, "team.request_denied", target, "denied");
      } catch {
        /* An unauthenticated request has no trusted actor to attribute. */
      }
    }
    if (status >= 500)
      app.log.error({ code: "TEAM_REQUEST_FAILED", requestId: req.id }, "Request failed");
    reply.code(status).send({
      error: {
        code:
          error instanceof HubError
            ? error.code
            : status === 429
              ? "RATE_LIMITED"
              : "REQUEST_FAILED",
        message:
          error instanceof HubError
            ? error.message
            : status === 400
              ? "Проверь данные запроса."
              : "Не удалось выполнить запрос.",
      },
    });
  });
  const centralAuth = new Set(
    [
      "status",
      "session",
      "login",
      "setup",
      "recover",
      "join",
      "invitation",
      "password",
      "logout",
      "logout-all",
    ].map((name) => `/api/auth/${name}`),
  );
  // Forward before body parsing, preserving streaming uploads and without retaining request content.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (path.startsWith("/api/internal/"))
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Не найдено." } });
    if (
      !path.startsWith("/api/") ||
      path === "/api/health" ||
      path === "/api/machine-enrollment/report" ||
      centralAuth.has(path) ||
      path.startsWith("/api/team/")
    )
      return;
    const session = auth.session(req);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      privateMutations.set(session.user.id, (privateMutations.get(session.user.id) ?? 0) + 1);
      reply.raw.once("close", () =>
        privateMutations.set(
          session.user.id,
          Math.max(0, (privateMutations.get(session.user.id) ?? 1) - 1),
        ),
      );
    }
    const { socket } = await personal(session.user.id);
    auth.session(req);
    reply.hijack();
    const cancel = proxyPrivateHttp(req.raw, reply.raw, socket, () => {
      auth.session(req);
    });
    track(session.user.id, session.tokenHash, cancel, (done) => reply.raw.once("close", done));
  });
  app.all("/api/*", async (_req, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Не найдено." } }),
  );
  app.get("/api/health", () => ({ ok: true }));
  app.get("/api/auth/status", () => ({ requiresSetup: false, team: true }));
  app.get("/api/auth/session", (req) => {
    const s = auth.session(req);
    // The pre-team GPT VNC gateway checked only HTTP 200 from this route and
    // forwarded only Cookie. It must fail closed for members during admission.
    if (
      s.user.id !== registry.ownerId &&
      req.headers.origin !== config.hub.publicBaseUrl &&
      req.headers["sec-fetch-site"] !== "same-origin" &&
      req.headers["x-workspace-id"] !== s.user.id
    )
      throw new HubError(
        403,
        "SESSION_CONTEXT_REQUIRED",
        "Обнови страницу подключения и войди в свой аккаунт.",
      );
    return {
      authenticated: true,
      team: true,
      csrf: s.csrf,
      expires: s.expires,
      user: s.user,
      originalOwner: s.user.id === registry.ownerId,
    };
  });
  app.post("/api/auth/login", slow, (req, reply) => {
    const body = z
      .object({ login: z.string().max(80).optional(), password: z.string().min(1).max(1024) })
      .strict()
      .parse(req.body);
    return auth.loginAs(body.login, body.password, reply);
  });
  app.post("/api/auth/setup", () => {
    throw new HubError(409, "SETUP_COMPLETE", "Установка уже настроена.");
  });
  app.post("/api/auth/invitation", slow, (req) => {
    const body = z
        .object({ token: z.string().max(100) })
        .strict()
        .parse(req.body),
      invite = registry.invitation(body.token);
    return { name: invite.name, expires: invite.expires };
  });
  app.post("/api/auth/join", slow, (req, reply) => {
    const body = credentials
      .extend({ login: teamLoginSchema, name: teamNameSchema })
      .parse(req.body);
    return auth.accept(body.token, body.login, body.name, body.password, reply);
  });
  app.post("/api/auth/recover", slow, (req, reply) => {
    const b = credentials.parse(req.body);
    return auth.recover(b.token, b.password, reply);
  });
  app.post("/api/auth/password", slow, (req, reply) => {
    const b = z
      .object({
        currentPassword: z.string().min(1).max(1024),
        password: z.string().min(12).max(1024),
      })
      .strict()
      .parse(req.body);
    return auth.changePassword(req, b.currentPassword, b.password, reply);
  });
  app.post("/api/auth/logout", (req, reply) => {
    auth.logout(req, reply);
    return { ok: true };
  });
  app.post("/api/auth/logout-all", (req, reply) => {
    auth.logoutAll(req, reply);
    return { ok: true };
  });
  const actor = (req: FastifyRequest) => auth.session(req).user.id;
  registerTeamProjects(app, teamProjects, actor, personal);
  registerCollaborationSpaces(app, teamProjects, actor, personal);
  registerTeamLinks(app, teamLinks, actor);
  registerTeamConsultations(app, teamConsultations, actor);
  registerTeamBridges(
    app,
    teamBridges,
    teamBridgeRuns,
    actor,
    new TeamBridgeSources(teamBridges, personal),
  );
  registerTeamExecutions(app, teamExecutions, actor);
  registerTeamGitHub(app, teamGitHub, actor);
  const restartPersonal = async (userId: string, change: () => void = () => {}) => {
    registry.active(userId);
    if (reconfiguring.has(userId))
      throw new HubError(409, "WORKSPACE_RECONFIGURING", "Подключение уже применяется.");
    if (failed.has(userId)) {
      instances.delete(userId);
      failed.delete(userId);
    }
    const current = await personal(userId);
    // Another activation may have claimed the runtime while its startup was awaited.
    if (reconfiguring.has(userId))
      throw new HubError(409, "WORKSPACE_RECONFIGURING", "Подключение уже применяется.");
    reconfiguring.add(userId);
    try {
      const blocked = () =>
        (privateMutations.get(userId) ?? 0) > 0 ||
        deploymentBlockers(current.runtime.store, { busy: 0, unknown: 0 }).length > 0;
      if (blocked())
        throw new HubError(
          409,
          "WORKSPACE_BUSY",
          "Закончи текущие задачи перед изменением подключений.",
        );
      const gpt = current.runtime.sessions.config.gpt;
      if (gpt) {
        for (const path of ["/active", "/bridge-health"]) {
          const response = await fetch(new URL(path, gpt.endpoint), {
            headers: { Authorization: `Bearer ${process.env[gpt.tokenSecret] ?? ""}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok)
            throw new HubError(409, "WORKSPACE_BUSY", "Не удалось проверить работу GPT.");
          const body = (await response.json()) as {
            generating?: boolean;
            activeRequests?: unknown[];
          };
          if (
            body.generating ||
            (path === "/bridge-health" &&
              (!Array.isArray(body.activeRequests) || body.activeRequests.length))
          )
            throw new HubError(409, "WORKSPACE_BUSY", "GPT ещё занят.");
        }
      }
      const terminals = await engineTerminalWork(current.socket, true);
      if (!terminals.reserved || terminals.busy || terminals.unknown || blocked())
        throw new HubError(
          409,
          "WORKSPACE_BUSY",
          "В терминале выполняется работа или его состояние не подтверждено.",
        );
      registry.active(userId);
      change();
      revoked(userId);
      await current.runtime.app.close();
      instances.delete(userId);
      failed.delete(userId);
    } finally {
      reconfiguring.delete(userId);
    }
    await personal(userId);
  };
  app.get("/api/team/machines", async (req) => ({
    items: enrollments.list(actor(req)),
    enabled: !!config.team?.hubTailnetAddress,
    activeMachineIds:
      (
        await instances.get(actor(req))?.catch(() => undefined)
      )?.runtime.sessions.config.machines.map((machine) => machine.id) ?? [],
  }));
  app.get("/api/team/machine-reviews", (req) => ({ items: enrollments.list(actor(req), true) }));
  app.post("/api/team/machines", slow, async (req) => {
    const userId = actor(req),
      b = z
        .object({
          name: teamNameSchema,
          request: z
            .object({ id: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
            .strict()
            .optional(),
        })
        .strict()
        .parse(req.body);
    if (!config.team?.hubTailnetAddress)
      throw new HubError(
        503,
        "TAILNET_SETUP_REQUIRED",
        "Сначала подключи Hub к Tailscale в настройке сервера.",
      );
    const keys = await enrollmentKeys();
    auth.session(req);
    return enrollments.create(userId, b.name, keys, b.request);
  });
  app.post("/api/team/machines/:id/bundle", slow, (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      { token } = z
        .object({ token: z.string().length(43) })
        .strict()
        .parse(req.body);
    return enrollmentBundle(config, enrollments, actor(req), id, token);
  });
  app.post(
    "/api/machine-enrollment/report",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    (req) => {
      if (!config.team?.hubTailnetAddress)
        throw new HubError(503, "TAILNET_SETUP_REQUIRED", "Приватная сеть Hub ещё не настроена.");
      return {
        enrollment: enrollments.report(
          String(req.headers.authorization).slice(7),
          req.body,
          config.team.hubTailnetAddress,
        ),
      };
    },
  );
  app.post("/api/team/machines/:id/approve", slow, async (req) => {
    const userId = actor(req),
      { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      { fingerprint } = z
        .object({ fingerprint: z.string().max(100) })
        .strict()
        .parse(req.body);
    const { row } = enrollments.approval(userId, id, fingerprint);
    if (row.state !== "approved")
      await (options.enrollmentVerifier ?? verifyEnrollment)(config, row);
    auth.session(req);
    return { enrollment: enrollments.approved(userId, id, fingerprint, row.digest!) };
  });
  app.post("/api/team/machines/apply", async (req) => {
    await restartPersonal(actor(req));
    return { ok: true };
  });
  app.delete("/api/team/machines/:id", async (req) => {
    const userId = actor(req),
      { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      row = enrollments.owned(userId, id);
    if (row.state === "approved")
      await restartPersonal(userId, () => enrollments.revoke(userId, id));
    else enrollments.revoke(userId, id);
    return { ok: true };
  });
  app.get("/api/team/me", (req) => ({
    user: publicUser(registry.active(actor(req))),
    originalOwner: actor(req) === registry.ownerId,
  }));
  app.get("/api/team/gpt", async (req) => {
    const userId = actor(req),
      current = await instances.get(userId)?.catch(() => undefined);
    return {
      ...teamGpt.status(userId),
      activated: !!(
        current?.runtime.sessions.config.gpt || current?.runtime.sessions.config.nativeGpt
      ),
    };
  });
  const setupStatus = async (req: FastifyRequest) => {
    const userId = actor(req),
      current = await instances.get(userId)?.catch(() => undefined);
    auth.session(req);
    return memberSetupStatus(
      config,
      registry,
      enrollments,
      teamGpt,
      userId,
      current?.runtime.sessions.config,
    );
  };
  app.get("/api/team/onboarding", setupStatus);
  app.post("/api/team/onboarding", async (req) => {
    const { state } = z
      .object({ state: z.enum(["deferred", "complete"]) })
      .strict()
      .parse(req.body);
    const status = await setupStatus(req);
    saveMemberSetup(registry, actor(req), state, status);
    return { ...status, state: status.originalOwner ? "complete" : state };
  });
  app.post("/api/team/gpt", slow, (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return teamGpt.request(actor(req));
  });
  app.post("/api/team/gpt/apply", async (req) => {
    const userId = actor(req);
    await teamGpt.activate(userId, () => {
      auth.session(req);
    });
    auth.session(req);
    if (!teamGpt.runtime(userId) && !teamGpt.nativeRuntime(userId))
      throw new HubError(409, "GPT_PROFILE_NOT_READY", "Личный браузер ещё не готов.");
    await restartPersonal(userId, () => {
      auth.session(req);
    });
    auth.session(req);
    return { ok: true };
  });
  app.get("/api/team/users", (req) => ({
    items: registry.users(actor(req)),
    ownerId: registry.ownerId,
    registrationEnabled: config.team?.registrationEnabled !== false,
  }));
  app.get("/api/team/users/:id/offboarding", (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return registry.offboarding(actor(req), id);
  });
  app.post("/api/team/invitations", slow, (req) => {
    registry.admin(actor(req));
    if (config.team?.registrationEnabled === false)
      throw new HubError(
        503,
        "MEMBER_REGISTRATION_PAUSED",
        "Подключение новых участников пока не включено.",
      );
    const b = z.object({ name: teamNameSchema }).strict().parse(req.body);
    const value = registry.invite(actor(req), b.name);
    return {
      id: value.id,
      expires: value.expires,
      url: `${config.hub.publicBaseUrl}/#join=${value.token}`,
    };
  });
  app.get("/api/team/invitations", (req) => {
    registry.admin(actor(req));
    return {
      items: registry.db
        .prepare(
          "SELECT id,name,kind,state,expires,createdAt FROM team_invites ORDER BY createdAt DESC LIMIT 100",
        )
        .all(),
    };
  });
  app.delete("/api/team/invitations/:id", (req) => {
    const user = actor(req);
    registry.admin(user);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    registry.db
      .prepare("UPDATE team_invites SET state='revoked' WHERE id=? AND state='pending'")
      .run(id);
    registry.audit(user, "invitation.revoked", id);
    return { ok: true };
  });
  app.post("/api/team/users/:id/state", (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      { disabled } = z.object({ disabled: z.boolean() }).strict().parse(req.body);
    return { user: registry.disable(actor(req), id, disabled) };
  });
  app.post("/api/team/users/:id/role", (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ role: z.enum(["admin", "member"]), expectedRole: z.enum(["admin", "member"]) })
      .strict()
      .parse(req.body);
    return { user: registry.setRole(actor(req), id, body.role, body.expectedRole) };
  });
  app.post("/api/team/users/:id/recovery", slow, (req) => {
    registry.admin(actor(req));
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const value = registry.invite(actor(req), registry.user(id).name, "member", "recovery", id);
    return { expires: value.expires, url: `${config.hub.publicBaseUrl}/#recover=${value.token}` };
  });
  app.get("/api/team/audit", (req) => {
    registry.admin(actor(req));
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    return {
      items: registry.db
        .prepare("SELECT * FROM team_audit WHERE seq<? ORDER BY seq DESC LIMIT 50")
        .all(before ?? Number.MAX_SAFE_INTEGER),
    };
  });
  if (options.executionService) {
    app.get("/internal/gpt/connection", (req) => {
      const session = auth.session(req);
      const { workspace } = z
        .object({ workspace: z.string().uuid().optional() })
        .strict()
        .parse(req.query);
      if (
        req.headers.origin !== config.hub.publicBaseUrl ||
        (workspace && workspace !== session.user.id)
      )
        throw new HubError(403, "WORKSPACE_CHANGED", "Войди снова в нужный аккаунт.");
      return teamGpt.connection(session.user.id);
    });
    const instance = randomUUID();
    app.get("/internal/runtime", () => ({
      protocol: ENGINE_PROTOCOL,
      schema: ownerStore.schemaVersion,
      revision: process.env.HUB_REVISION ?? "unknown",
      instance,
      team: 1,
      ownerReady: !failed.has(registry.ownerId),
      registrationEnabled: config.team?.registrationEnabled !== false,
    }));
    const storedWork = () => {
      let work = activeMutations + (teamGitHub.busy() ? 1 : 0);
      work += Number(
        registry.db
          .prepare(
            "SELECT COUNT(*) n FROM team_github_operations WHERE state IN ('preparing','running','unknown')",
          )
          .get()?.n ?? 0,
      );
      work += Number(
        registry.db
          .prepare(
            "SELECT COUNT(*) n FROM team_bridge_runs WHERE state IN ('waiting','running','consulting','unknown') OR json_extract(value,'$.step.state') IN ('dispatching','running','unknown')",
          )
          .get()?.n ?? 0,
      );
      work += Number(
        registry.db
          .prepare(
            "SELECT COUNT(*) n FROM team_consultations WHERE state IN ('waiting','running','unknown') OR (state='stopped' AND json_extract(value,'$.steps[#-1].state') IN ('dispatching','running','unknown'))",
          )
          .get()?.n ?? 0,
      );
      work += Number(
        registry.db
          .prepare(
            "SELECT COUNT(*) n FROM team_executions WHERE state IN ('dispatching','queued','running','unknown')",
          )
          .get()?.n ?? 0,
      );
      // Include disabled/offline accounts and unknown receipts, not just today's open browsers.
      for (const user of registry.db
        .prepare(
          "SELECT u.id,u.legacy FROM team_users u JOIN team_namespaces n ON n.userId=u.id WHERE n.initialized=1",
        )
        .all()) {
        const path = user.legacy
          ? config.hub.databasePath
          : join(config.team!.root, "users", String(user.id), "app.db");
        try {
          if (!existsSync(path) || lstatSync(path).isSymbolicLink())
            throw new Error("STORAGE_UNAVAILABLE");
          const db = new DatabaseSync(path, { readOnly: true });
          try {
            work += deploymentBlockers(
              {
                db,
                preferences: () =>
                  JSON.parse(
                    String(
                      db.prepare("SELECT value FROM preferences WHERE id=1").get()?.value ?? "{}",
                    ),
                  ),
              },
              { busy: 0, unknown: 0 },
            ).reduce((sum, item) => sum + item.count, 0);
          } finally {
            db.close();
          }
        } catch {
          work++;
        }
      }
      work += Number(
        registry.db
          .prepare("SELECT COUNT(*) n FROM team_receipts WHERE state IN ('pending','unknown')")
          .get()?.n ?? 0,
      );
      return work;
    };
    const inspectTerminals = async (reserve: boolean) => {
      if (reserve) maintenanceUntil = Date.now() + 60000;
      let work = storedWork();
      if (reserve && work) {
        maintenanceUntil = 0;
        return { busy: 0, unknown: 0, reserved: false, work };
      }
      const values = await Promise.all(
        [...instances.values()].map(async (pending) => {
          try {
            const current = await pending;
            let nativeBusy = false;
            const gpt = current.runtime.sessions.config.gpt;
            if (gpt) {
              // Fixed read-only probes remain possible while native writes are frozen,
              // including for a disabled account whose earlier request is still finishing.
              const read = async (path: "/active" | "/bridge-health") => {
                const response = await fetch(new URL(path, gpt.endpoint), {
                  headers: { Authorization: `Bearer ${process.env[gpt.tokenSecret] ?? ""}` },
                  signal: AbortSignal.timeout(10000),
                });
                if (!response.ok) throw new Error("GPT_STATUS_UNAVAILABLE");
                return (await response.json()) as Record<string, unknown>;
              };
              const [active, health] = await Promise.all([read("/active"), read("/bridge-health")]);
              nativeBusy =
                !!active.generating ||
                !Array.isArray(health.activeRequests) ||
                !!health.activeRequests.length;
            }
            if (nativeBusy) return { busy: 0, unknown: 0, reserved: false, work: 1 };
            return await engineTerminalWork(current.socket, false);
          } catch {
            return { busy: 0, unknown: 1, reserved: false };
          }
        }),
      );
      work =
        storedWork() +
        values.reduce((sum, value) => sum + ("work" in value ? Number(value.work) || 0 : 0), 0);
      if (reserve && !work && values.every((value) => !value.busy && !value.unknown)) {
        const reserved = await Promise.all(
          [...instances.values()].map(async (pending) => {
            try {
              return await engineTerminalWork((await pending).socket, true);
            } catch {
              return { busy: 0, unknown: 1, reserved: false };
            }
          }),
        );
        work = storedWork();
        if (
          !work &&
          maintenanceUntil > Date.now() + 5000 &&
          reserved.every((value) => value.reserved)
        )
          return { busy: 0, unknown: 0, reserved: true, work: 0 };
        // Individual terminal guards expire themselves. Restore normal API access on a failed reservation.
        maintenanceUntil = 0;
        return {
          busy: reserved.reduce((sum, value) => sum + value.busy, 0),
          unknown: Math.max(
            1,
            reserved.reduce((sum, value) => sum + value.unknown, 0),
          ),
          reserved: false,
          work,
        };
      }
      if (reserve) maintenanceUntil = 0;
      return {
        busy: values.reduce((sum, v) => sum + v.busy, 0),
        unknown: values.reduce((sum, v) => sum + v.unknown, 0),
        reserved: false,
        work,
      };
    };
    let reserving: ReturnType<typeof inspectTerminals> | undefined;
    app.get("/internal/terminals/maintenance", () => inspectTerminals(false));
    app.post("/internal/terminals/maintenance", () => {
      if (!reserving)
        reserving = inspectTerminals(true).finally(() => {
          reserving = undefined;
        });
      return reserving;
    });
  }
  app.server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        if (!req.url?.startsWith("/api/") || req.headers.origin !== config.hub.publicBaseUrl)
          throw new Error("DENIED");
        const hash = tokenHash(sessionCookie(req.headers.cookie, auth.cookieName)),
          session = registry.session(hash);
        const expected = new URL(req.url, config.hub.publicBaseUrl).searchParams.get("workspace");
        if (expected && expected !== session.user.id) throw new Error("WORKSPACE_CHANGED");
        const target = await personal(session.user.id);
        const cancel = proxyPrivateSocket(req, socket, head, target.socket, () => {
          registry.session(hash);
        });
        track(session.user.id, hash, cancel, (done) => socket.once("close", done));
      } catch {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    })();
  });
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(staticFiles, {
      root: options.webRoot,
      maxAge: 0,
      setHeaders(res, path) {
        if (["index.html", "sw.js", "version.json"].includes(basename(path)))
          res.header("Cache-Control", "no-store");
      },
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send()
        : reply.header("Cache-Control", "no-store").sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    closing = true;
    await teamBridgeRuns.close();
    await teamGitHub.close();
    await teamExecutions.close();
    await teamConsultations.close();
    registry.events.off("revoked", revoked);
    for (const id of connections.keys()) revoked(id);
    await Promise.allSettled(
      [...instances.values()].map(async (pending) => (await pending).runtime.app.close()),
    );
    ownerStore.close();
    registry.close();
  });
  // Restore every enabled personal runtime, so closing all browser tabs does not orphan queues.
  const activeUsers = registry.db.prepare("SELECT id FROM team_users WHERE state='active'").all();
  for (const user of activeUsers) {
    try {
      await personal(String(user.id));
    } catch {
      app.log.error(
        { code: "PERSONAL_RUNTIME_START_FAILED", userId: String(user.id) },
        "Personal runtime unavailable",
      );
    }
  }
  teamExecutions.start();
  teamConsultations.start();
  teamBridgeRuns.start();
  return {
    app,
    registry,
    auth,
    personal,
    enrollments,
    teamProjects,
    teamLinks,
    teamExecutions,
    teamConsultations,
    teamBridges,
    teamBridgeRuns,
    teamGitHub,
  };
}
