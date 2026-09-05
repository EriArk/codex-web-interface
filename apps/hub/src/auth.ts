import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type HubConfig, HubError } from "@codex-web/shared";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "./store.js";

export const tokenHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function equalSecret(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const hashPassword = (password: string) =>
  hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export interface LoginSession {
  tokenHash: string;
  csrf: string;
  expires: number;
}
export class Auth {
  readonly cookieName: string;
  private dummyHash = "";
  constructor(
    readonly config: HubConfig,
    readonly store: Store,
  ) {
    this.cookieName = config.hub.secureCookies ? "__Host-codex-session" : "codex-session";
  }
  configured(): boolean {
    return !!this.store.db.prepare("SELECT username FROM users LIMIT 1").get();
  }
  async prepare(setupToken?: string): Promise<void> {
    if (!this.configured() && !this.store.db.prepare("SELECT id FROM bootstrap WHERE id=1").get()) {
      if (!setupToken || !/^[A-Za-z0-9_-]{43}$/.test(setupToken))
        throw new Error("A private one-time setup token is required for the first start");
      this.store.db.prepare("INSERT INTO bootstrap VALUES(1,?)").run(tokenHash(setupToken));
    }
    this.dummyHash = await hashPassword(randomBytes(32).toString("base64url"));
  }
  async setup(
    token: string,
    password: string,
    reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const record = this.store.db.prepare("SELECT tokenHash FROM bootstrap WHERE id=1").get();
    if (this.configured() || !record || !equalSecret(tokenHash(token), String(record.tokenHash)))
      throw new HubError(
        403,
        "SETUP_LINK_INVALID",
        "Ссылка настройки недействительна или уже использована",
      );
    const passwordHash = await hashPassword(password);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.store.db
        .prepare("DELETE FROM bootstrap WHERE id=1 AND tokenHash=?")
        .run(tokenHash(token));
      if (!consumed.changes) throw new HubError(409, "SETUP_COMPLETE", "Пароль уже задан");
      this.store.db
        .prepare("INSERT INTO users VALUES(?,?)")
        .run(this.config.auth.username, passwordHash);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.issue(reply);
  }
  requireOrigin(req: FastifyRequest): void {
    if (req.headers.origin !== this.config.hub.publicBaseUrl)
      throw new HubError(403, "ORIGIN_DENIED", "Открой приложение с его основного адреса");
  }
  session(req: FastifyRequest): LoginSession {
    const token = req.cookies[this.cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new HubError(401, "LOGIN_REQUIRED", "Войди в приложение");
    const row = this.store.db
      .prepare("SELECT * FROM sessions WHERE tokenHash=? AND expires>?")
      .get(tokenHash(token), Date.now()) as unknown as LoginSession | undefined;
    if (!row) throw new HubError(401, "LOGIN_REQUIRED", "Сессия истекла. Войди снова");
    return row;
  }
  csrf(req: FastifyRequest): void {
    this.requireOrigin(req);
    const s = this.session(req),
      header = req.headers["x-csrf-token"];
    if (typeof header !== "string" || !equalSecret(header, s.csrf))
      throw new HubError(403, "CSRF_DENIED", "Обнови страницу и повтори действие");
  }
  async login(password: string, reply: FastifyReply): Promise<Record<string, unknown>> {
    const row = this.store.db
      .prepare("SELECT passwordHash FROM users WHERE username=?")
      .get(this.config.auth.username);
    let valid = false;
    try {
      valid = await verify(String(row?.passwordHash ?? this.dummyHash), password);
    } catch {
      valid = false;
    }
    if (!valid || !row) throw new HubError(401, "LOGIN_FAILED", "Неверный пароль");
    return this.issue(reply);
  }
  private issue(reply: FastifyReply): Record<string, unknown> {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url");
    const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
    this.store.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash(token), csrf, expires);
    reply.setCookie(this.cookieName, token, {
      path: "/",
      secure: this.config.hub.secureCookies,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60,
    });
    return { authenticated: true, csrf, expires };
  }
  logout(req: FastifyRequest, reply: FastifyReply): string {
    const session = this.session(req);
    this.store.db.prepare("DELETE FROM sessions WHERE tokenHash=?").run(session.tokenHash);
    reply.clearCookie(this.cookieName, {
      path: "/",
      secure: this.config.hub.secureCookies,
      httpOnly: true,
      sameSite: "strict",
    });
    return session.tokenHash;
  }
  install(app: FastifyInstance): void {
    app.addHook("onRequest", async (req, reply) => {
      const path = req.routeOptions.url ?? req.url.split("?")[0] ?? "";
      if (!path.startsWith("/api/")) return;
      reply.header("Cache-Control", "no-store");
      if (path === "/api/health" || path === "/api/auth/status") return;
      if (path === "/api/auth/login" || path === "/api/auth/setup") {
        this.requireOrigin(req);
        return;
      }
      this.session(req);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) this.csrf(req);
    });
  }
}
