import { randomBytes } from "node:crypto";
import { type HubConfig, HubError, teamLoginSchema } from "@codex-web/shared";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Auth, tokenHash } from "./auth.js";
import type { Store } from "./store.js";
import type { TeamStore } from "./team-store.js";

export const teamPasswordHash = (password: string) =>
  hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
let dummyHash: Promise<string> | undefined;
export function sessionCookie(header: string | undefined, name: string): string {
  const matches = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) throw new HubError(401, "LOGIN_REQUIRED", "Войди в приложение.");
  const value = matches[0]!.slice(name.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new HubError(401, "LOGIN_REQUIRED", "Войди в приложение.");
  return value;
}
export class TeamAuth extends Auth {
  private disposed = false;
  private stopMirror: () => void = () => {};
  dispose() {
    this.disposed = true;
    this.stopMirror();
  }
  constructor(
    config: HubConfig,
    store: Store,
    readonly registry: TeamStore,
    readonly userId?: string,
  ) {
    super(config, store);
    if (userId) {
      const update = (id: string) => {
        if (id === userId) this.syncSessions();
      };
      registry.events.on("sessions", update);
      this.stopMirror = () => registry.events.off("sessions", update);
      this.syncSessions();
    }
  }
  override configured() {
    return true;
  }
  override async prepare() {
    dummyHash ??= teamPasswordHash(randomBytes(32).toString("base64url"));
    await dummyHash;
  }
  private syncSessions() {
    if (this.disposed || !this.userId) return;
    const rows = this.registry.db
      .prepare(`SELECT s.tokenHash,s.csrf,s.expires FROM team_sessions s
      JOIN team_users u ON u.id=s.userId WHERE s.userId=? AND s.expires>? AND u.state='active' AND s.revision=u.revision`)
      .all(this.userId, Date.now());
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.exec("DELETE FROM sessions");
      const put = this.store.db.prepare("INSERT INTO sessions VALUES(?,?,?)");
      for (const row of rows) put.run(String(row.tokenHash), String(row.csrf), Number(row.expires));
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  override session(req: FastifyRequest) {
    const token = sessionCookie(req.headers.cookie, this.cookieName),
      session = this.registry.session(tokenHash(token));
    if (this.userId && session.user.id !== this.userId)
      throw new HubError(403, "WORKSPACE_ACCESS_DENIED", "Это другое личное пространство.");
    return session;
  }
  override subscribeRevocation(listener: (sessionHash?: string) => void) {
    const update = (id: string, hash?: string) => {
      if (!this.userId || id === this.userId) listener(hash);
    };
    this.registry.events.on("revoked", update);
    return () => this.registry.events.off("revoked", update);
  }
  private issued(id: string, reply: FastifyReply): Record<string, unknown> {
    // Replacing a browser account also revokes that browser's old push/terminal session.
    let previous: ReturnType<TeamStore["session"]> | undefined;
    try {
      previous = this.registry.session(
        tokenHash(sessionCookie(reply.request.headers.cookie, this.cookieName)),
      );
    } catch {
      /* No valid previous login. */
    }
    if (previous && previous.user.id !== id)
      this.registry.revoke(previous.user.id, previous.tokenHash);
    const { token, csrf, expires, user } = this.registry.issueSession(id);
    reply.setCookie(this.cookieName, token, {
      path: "/",
      secure: this.config.hub.secureCookies,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 7 * 86400,
    });
    return {
      authenticated: true,
      team: true,
      csrf,
      expires,
      user,
      originalOwner: id === this.registry.ownerId,
    };
  }
  async loginAs(login: string | undefined, password: string, reply: FastifyReply) {
    await this.prepare();
    const parsed = teamLoginSchema.safeParse(
      login ?? this.registry.user(this.registry.ownerId).login,
    );
    const user = parsed.success ? this.registry.byLogin(parsed.data) : undefined;
    let matched = false;
    try {
      matched = await verify(user?.passwordHash ?? (await dummyHash!), password);
    } catch {
      /* Invalid hashes fail closed. */
    }
    if (
      !matched ||
      !user ||
      user.state !== "active" ||
      this.registry.user(user.id).revision !== user.revision ||
      this.registry.user(user.id).passwordHash !== user.passwordHash
    )
      throw new HubError(401, "LOGIN_FAILED", "Неверный логин или пароль.");
    if (this.userId && user.id !== this.userId)
      throw new HubError(403, "WORKSPACE_ACCESS_DENIED", "Это другое личное пространство.");
    return this.issued(user.id, reply);
  }
  override login(password: string, reply: FastifyReply) {
    return this.loginAs(
      this.userId ? this.registry.user(this.userId).login : undefined,
      password,
      reply,
    );
  }
  async accept(token: string, login: string, name: string, password: string, reply: FastifyReply) {
    if (this.config.team?.registrationEnabled === false)
      throw new HubError(
        503,
        "MEMBER_REGISTRATION_PAUSED",
        "Подключение новых участников пока не включено.",
      );
    this.registry.invitation(token);
    const digest = await teamPasswordHash(password);
    const user = this.registry.accept(
      token,
      teamLoginSchema.parse(login),
      name,
      digest,
      this.config.team?.maxUsers ?? 10,
    );
    return this.issued(user.id, reply);
  }
  override async setup(
    _token: string,
    _password: string,
    _reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    throw new HubError(409, "SETUP_COMPLETE", "Установка уже настроена. Используй приглашение.");
  }
  override async changePassword(
    req: FastifyRequest,
    currentPassword: string,
    password: string,
    reply: FastifyReply,
  ) {
    const session = this.session(req),
      user = this.registry.active(session.user.id);
    if (!(await verify(user.passwordHash, currentPassword)))
      throw new HubError(403, "PASSWORD_MISMATCH", "Текущий пароль неверный.");
    const digest = await teamPasswordHash(password);
    this.session(req);
    this.registry.updatePassword(user.id, digest, user.revision);
    this.registry.audit(user.id, "password.changed", user.id);
    return this.issued(user.id, reply);
  }
  override async recover(token: string, password: string, reply: FastifyReply) {
    const invite = this.registry.invitation(token, "recovery"),
      user = this.registry.active(String(invite.userId));
    const digest = await teamPasswordHash(password);
    this.registry.invitation(token, "recovery");
    this.registry.updatePassword(user.id, digest, user.revision);
    this.registry.db
      .prepare("UPDATE team_invites SET state='accepted' WHERE id=?")
      .run(String(invite.id));
    this.registry.audit(user.id, "password.recovered", user.id);
    return this.issued(user.id, reply);
  }
  override logout(req: FastifyRequest, reply: FastifyReply) {
    const session = this.session(req);
    this.registry.revoke(session.user.id, session.tokenHash);
    reply.clearCookie(this.cookieName, {
      path: "/",
      secure: this.config.hub.secureCookies,
      httpOnly: true,
      sameSite: "strict",
    });
    return session.tokenHash;
  }
  override logoutAll(req: FastifyRequest, reply: FastifyReply) {
    const session = this.session(req);
    this.registry.revoke(session.user.id);
    reply.clearCookie(this.cookieName, {
      path: "/",
      secure: this.config.hub.secureCookies,
      httpOnly: true,
      sameSite: "strict",
    });
  }
  override install(app: FastifyInstance) {
    app.addHook("onRequest", async (req, reply) => {
      const path = req.routeOptions.url ?? req.url.split("?")[0] ?? "";
      if (!path.startsWith("/api/")) return;
      reply.header("Cache-Control", "no-store");
      if (path === "/api/health" || path === "/api/auth/status") return;
      if (!this.userId && path === "/api/machine-enrollment/report" && req.method === "POST") {
        // A purpose-specific script token is checked by this one handler. It is never a login session.
        if (
          req.headers.cookie ||
          (req.headers.origin && req.headers.origin !== this.config.hub.publicBaseUrl) ||
          !/^Bearer [A-Za-z0-9_-]{43}$/.test(String(req.headers.authorization ?? ""))
        )
          throw new HubError(
            403,
            "ENROLLMENT_AUTH_REQUIRED",
            "Нужен одноразовый пакет подключения.",
          );
        return;
      }
      if (
        [
          "/api/auth/login",
          "/api/auth/setup",
          "/api/auth/recover",
          "/api/auth/join",
          "/api/auth/invitation",
        ].includes(path)
      ) {
        this.requireOrigin(req);
        return;
      }
      const session = this.session(req);
      const expected = [
        req.headers["x-workspace-id"],
        ...new URL(req.url, this.config.hub.publicBaseUrl).searchParams.getAll("workspace"),
      ].filter(Boolean);
      if (path !== "/api/auth/session" && expected.some((value) => value !== session.user.id))
        throw new HubError(
          401,
          "WORKSPACE_CHANGED",
          "В другой вкладке изменился аккаунт. Войди снова.",
        );
      // Workspace identity belongs to the auth envelope, not the personal API query schema.
      if (req.query && typeof req.query === "object")
        delete (req.query as Record<string, unknown>).workspace;
      reply.header("X-Workspace-Id", session.user.id);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) this.csrf(req);
    });
    app.addHook("onClose", async () => {
      this.dispose();
    });
  }
}
