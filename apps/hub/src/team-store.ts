import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type HubConfig,
  HubError,
  type TeamRole,
  type TeamUser,
  teamLoginSchema,
} from "@codex-web/shared";
import { tokenHash } from "./auth.js";
import type { Store } from "./store.js";

type UserRow = TeamUser & {
  passwordHash: string;
  revision: number;
  legacy: number;
  config: string | null;
};
export interface PrivateTeamSession {
  tokenHash: string;
  csrf: string;
  expires: number;
  user: TeamUser;
}
const missing = () => new HubError(404, "TEAM_NOT_FOUND", "Объект недоступен.");
export function publicUser(row: UserRow): TeamUser {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    role: row.role,
    state: row.state,
    createdAt: row.createdAt,
  };
}

/** Installation identities and explicitly shared data. Private native stores remain separate. */
export class TeamStore {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter();
  readonly ownerId: string;
  constructor(
    readonly path: string,
    config: HubConfig,
    legacy: Store,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
        throw new Error("TEAM_STORAGE_UNSAFE");
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='team_meta'").get()) {
      const version = this.db.prepare("SELECT value FROM team_meta WHERE key='schema'").get();
      if (version && !["1", "2", "3", "4"].includes(String(version.value))) {
        this.db.close();
        throw new Error("TEAM_SCHEMA_UNSUPPORTED");
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_users(
        id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')),
        state TEXT NOT NULL CHECK(state IN ('active','disabled')),
        passwordHash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        legacy INTEGER NOT NULL DEFAULT 0, config TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_sessions(
        tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES team_users(id),
        csrf TEXT NOT NULL, expires INTEGER NOT NULL, revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_sessions_user ON team_sessions(userId,expires);
      CREATE TABLE IF NOT EXISTS team_invites(
        id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        createdBy TEXT NOT NULL REFERENCES team_users(id), userId TEXT,
        name TEXT NOT NULL, role TEXT NOT NULL, expires INTEGER NOT NULL,
        state TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_audit(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, actorId TEXT NOT NULL, actorName TEXT NOT NULL,
        target TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_receipts(
        userId TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL, value TEXT, createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId,scope,key)
      );
      CREATE TABLE IF NOT EXISTS team_runtime_config(userId TEXT PRIMARY KEY REFERENCES team_users(id),value TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS team_namespaces(userId TEXT PRIMARY KEY REFERENCES team_users(id),initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1)));
      CREATE TABLE IF NOT EXISTS team_machine_enrollments(
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES team_users(id), name TEXT NOT NULL,
        tokenHash TEXT NOT NULL UNIQUE, keys TEXT NOT NULL, state TEXT NOT NULL,
        report TEXT, digest TEXT, machineId TEXT UNIQUE, createdAt INTEGER NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_gpt_profiles(
        userId TEXT PRIMARY KEY REFERENCES team_users(id), slot INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('requested','ready','failed')),
        serviceToken TEXT NOT NULL, bridgeToken TEXT NOT NULL, vncPassword TEXT NOT NULL,
        revision INTEGER NOT NULL, code TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_projects(
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES team_users(id), title TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')), repository TEXT,
        revision INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_project_members(
        projectId TEXT NOT NULL REFERENCES team_projects(id), userId TEXT NOT NULL REFERENCES team_users(id),
        role TEXT NOT NULL CHECK(role IN ('owner','collaborator','viewer')),
        state TEXT NOT NULL CHECK(state IN ('active','removed')), revision INTEGER NOT NULL,
        PRIMARY KEY(projectId,userId)
      );
      CREATE TABLE IF NOT EXISTS team_project_invites(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES team_projects(id),
        createdBy TEXT NOT NULL REFERENCES team_users(id), userId TEXT NOT NULL REFERENCES team_users(id),
        role TEXT NOT NULL CHECK(role IN ('owner','collaborator','viewer')),
        state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','revoked')),
        projectRevision INTEGER NOT NULL, createdAt INTEGER NOT NULL, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_project_invites_user ON team_project_invites(userId,state,expires);
      CREATE TABLE IF NOT EXISTS team_checkouts(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES team_projects(id),
        userId TEXT NOT NULL REFERENCES team_users(id), personalProjectId TEXT NOT NULL,
        machineId TEXT NOT NULL, repository TEXT, revision INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(projectId,userId), UNIQUE(userId,personalProjectId)
      );
      CREATE TABLE IF NOT EXISTS team_materials(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES team_projects(id), kind TEXT NOT NULL,
        content TEXT NOT NULL, search TEXT NOT NULL, revision INTEGER NOT NULL,
        createdBy TEXT NOT NULL REFERENCES team_users(id), updatedBy TEXT NOT NULL REFERENCES team_users(id),
        authorName TEXT NOT NULL, editorName TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        assigneeId TEXT REFERENCES team_users(id), source TEXT, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
      );
      CREATE INDEX IF NOT EXISTS team_materials_project ON team_materials(projectId,kind,deleted,updatedAt);
      CREATE UNIQUE INDEX IF NOT EXISTS team_materials_core ON team_materials(projectId) WHERE kind='core' AND deleted=0;
      CREATE TABLE IF NOT EXISTS team_material_history(
        itemId TEXT NOT NULL REFERENCES team_materials(id), revision INTEGER NOT NULL, content TEXT NOT NULL,
        actorId TEXT NOT NULL REFERENCES team_users(id), actorName TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(itemId,revision)
      );
      CREATE TABLE IF NOT EXISTS team_project_activity(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT NOT NULL REFERENCES team_projects(id),
        actorId TEXT NOT NULL REFERENCES team_users(id), actorName TEXT NOT NULL, action TEXT NOT NULL,
        itemId TEXT, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_project_activity_scope ON team_project_activity(projectId,seq);
      CREATE TABLE IF NOT EXISTS team_executions(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES team_projects(id), itemId TEXT NOT NULL REFERENCES team_materials(id),
        itemRevision INTEGER NOT NULL, userId TEXT NOT NULL REFERENCES team_users(id), checkoutId TEXT NOT NULL REFERENCES team_checkouts(id),
        checkoutRevision INTEGER NOT NULL, state TEXT NOT NULL, privateActionId TEXT NOT NULL,
        value TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS team_execution_exclusive ON team_executions(itemId) WHERE state IN ('prepared','dispatching','queued','running','unknown');
    `);
    const recorded = this.db.prepare("SELECT value FROM team_meta WHERE key='originalOwner'").get();
    if (recorded) {
      this.ownerId = String(recorded.value);
      if (!legacy.db.prepare("SELECT 1 FROM users WHERE username=?").get(config.auth.username))
        throw new Error("TEAM_OWNER_STORAGE_MISSING");
      const owner = this.user(this.ownerId);
      if (
        !owner.legacy ||
        this.db.prepare("SELECT COUNT(*) n FROM team_users WHERE legacy=1").get()?.n !== 1
      )
        throw new Error("TEAM_OWNER_MAPPING_INVALID");
    } else {
      const account = legacy.db
        .prepare("SELECT username,passwordHash FROM users WHERE username=?")
        .get(config.auth.username);
      if (!account) throw new Error("TEAM_REQUIRES_EXISTING_OWNER");
      this.ownerId = randomUUID();
      this.transaction(() => {
        const login = teamLoginSchema.safeParse(config.auth.username);
        this.db
          .prepare(
            "INSERT INTO team_users(id,login,name,role,state,passwordHash,legacy,createdAt) VALUES(?,?,?,'admin','active',?,1,?)",
          )
          .run(
            this.ownerId,
            login.success ? login.data : "owner",
            config.auth.username,
            String(account.passwordHash),
            Date.now(),
          );
        this.db.prepare("INSERT INTO team_meta VALUES('originalOwner',?)").run(this.ownerId);
        this.db.prepare("INSERT INTO team_meta VALUES('schema','3')").run();
        const put = this.db.prepare("INSERT INTO team_sessions VALUES(?,?,?,?,0)");
        for (const row of legacy.db
          .prepare("SELECT * FROM sessions WHERE expires>?")
          .all(Date.now()))
          put.run(String(row.tokenHash), this.ownerId, String(row.csrf), Number(row.expires));
        const recovery = legacy.db
          .prepare("SELECT recoveryHash,recoveryExpires FROM auth_state WHERE id=1")
          .get();
        if (recovery?.recoveryHash && Number(recovery.recoveryExpires) > Date.now())
          this.db
            .prepare("INSERT INTO team_invites VALUES(?,?,'recovery',?,?,?,'admin',?,'pending',?)")
            .run(
              randomUUID(),
              String(recovery.recoveryHash),
              this.ownerId,
              this.ownerId,
              config.auth.username,
              Number(recovery.recoveryExpires),
              Date.now(),
            );
      });
    }
    this.db.prepare("UPDATE team_meta SET value='4' WHERE key='schema'").run();
    if (
      this.db
        .prepare(`SELECT p.id FROM team_projects p WHERE
      (SELECT COUNT(*) FROM team_project_members m WHERE m.projectId=p.id AND m.role='owner' AND m.state='active')!=1
      OR NOT EXISTS(SELECT 1 FROM team_project_members m WHERE m.projectId=p.id AND m.userId=p.ownerId AND m.role='owner' AND m.state='active') LIMIT 1`)
        .get()
    ) {
      this.db.close();
      throw new Error("TEAM_PROJECT_OWNER_INVALID");
    }
    if (!recorded) this.db.prepare("INSERT INTO team_namespaces VALUES(?,1)").run(this.ownerId);
    if (
      this.db
        .prepare(
          "SELECT u.id FROM team_users u LEFT JOIN team_namespaces n ON n.userId=u.id WHERE n.userId IS NULL",
        )
        .get()
    ) {
      this.db.close();
      throw new Error("TEAM_NAMESPACE_MISSING");
    }
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.events.setMaxListeners(40);
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  user(id: string): UserRow {
    const row = this.db.prepare("SELECT * FROM team_users WHERE id=?").get(id) as unknown as
      | UserRow
      | undefined;
    if (!row) throw missing();
    return row;
  }
  active(id: string): UserRow {
    const user = this.user(id);
    if (user.state !== "active") throw new HubError(401, "LOGIN_REQUIRED", "Войди в приложение.");
    return user;
  }
  byLogin(login: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM team_users WHERE login=?")
      .get(login.toLowerCase()) as unknown as UserRow | undefined;
  }
  admin(id: string): UserRow {
    const user = this.active(id);
    if (user.role !== "admin")
      throw new HubError(403, "ADMIN_REQUIRED", "Нужны права администратора.");
    return user;
  }
  users(actor: string): TeamUser[] {
    this.admin(actor);
    return (
      this.db
        .prepare("SELECT * FROM team_users ORDER BY createdAt,id")
        .all() as unknown as UserRow[]
    ).map(publicUser);
  }
  audit(actor: string, action: string, target: string, outcome = "ok") {
    const user = this.user(actor);
    this.db
      .prepare(
        "INSERT INTO team_audit(actorId,actorName,target,action,outcome,createdAt) VALUES(?,?,?,?,?,?)",
      )
      .run(actor, user.name, target, action, outcome, Date.now());
    this.db.exec(
      "DELETE FROM team_audit WHERE seq <= (SELECT COALESCE(MAX(seq),0)-10000 FROM team_audit)",
    );
    this.events.emit("change", actor);
  }
  session(hash: string): PrivateTeamSession {
    const row = this.db
      .prepare(`SELECT s.tokenHash,s.csrf,s.expires,s.userId FROM team_sessions s
      JOIN team_users u ON u.id=s.userId WHERE s.tokenHash=? AND s.expires>? AND s.revision=u.revision AND u.state='active'`)
      .get(hash, Date.now());
    if (!row) throw new HubError(401, "LOGIN_REQUIRED", "Сессия истекла. Войди снова.");
    return {
      tokenHash: String(row.tokenHash),
      csrf: String(row.csrf),
      expires: Number(row.expires),
      user: publicUser(this.active(String(row.userId))),
    };
  }
  issueSession(userId: string) {
    const user = this.active(userId),
      token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url"),
      expires = Date.now() + 7 * 86400000;
    this.db.prepare("DELETE FROM team_sessions WHERE expires<=?").run(Date.now());
    this.db
      .prepare("INSERT INTO team_sessions VALUES(?,?,?,?,?)")
      .run(tokenHash(token), userId, csrf, expires, user.revision);
    this.events.emit("sessions", userId);
    return { token, csrf, expires, user: publicUser(user) };
  }
  revoke(userId: string, hash?: string) {
    this.active(userId);
    if (hash)
      this.db.prepare("DELETE FROM team_sessions WHERE userId=? AND tokenHash=?").run(userId, hash);
    else
      this.transaction(() => {
        this.db.prepare("DELETE FROM team_sessions WHERE userId=?").run(userId);
        this.db.prepare("UPDATE team_users SET revision=revision+1 WHERE id=?").run(userId);
        this.db
          .prepare(
            "UPDATE team_invites SET state='revoked' WHERE kind='recovery' AND userId=? AND state='pending'",
          )
          .run(userId);
      });
    this.events.emit("sessions", userId);
    this.events.emit("revoked", userId, hash);
  }
  invite(actor: string, name: string, role: TeamRole = "member", kind = "member", userId?: string) {
    this.admin(actor);
    if (userId) this.active(userId);
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID(),
      expires = Date.now() + (kind === "recovery" ? 15 * 60000 : 86400000);
    this.transaction(() => {
      if (kind === "recovery")
        this.db
          .prepare(
            "UPDATE team_invites SET state='revoked' WHERE kind='recovery' AND userId=? AND state='pending'",
          )
          .run(userId!);
      this.db
        .prepare("INSERT INTO team_invites VALUES(?,?,?,?,?,?,?,?, 'pending',?)")
        .run(id, tokenHash(token), kind, actor, userId ?? null, name, role, expires, Date.now());
      this.audit(actor, kind === "recovery" ? "recovery.issued" : "user.invited", userId ?? id);
    });
    return { id, token, expires };
  }
  invitation(token: string, kind = "member") {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new HubError(403, "INVITE_INVALID", "Приглашение истекло или уже использовано.");
    const row = this.db
      .prepare(
        "SELECT * FROM team_invites WHERE tokenHash=? AND kind=? AND state='pending' AND expires>?",
      )
      .get(tokenHash(token), kind, Date.now());
    if (!row || this.user(String(row.createdBy)).state !== "active")
      throw new HubError(403, "INVITE_INVALID", "Приглашение истекло или уже использовано.");
    return row;
  }
  accept(
    token: string,
    login: string,
    name: string,
    passwordHash: string,
    maxUsers: number,
  ): TeamUser {
    return this.transaction(() => {
      const invite = this.invitation(token);
      if (Number(this.db.prepare("SELECT COUNT(*) n FROM team_users").get()?.n) >= maxUsers)
        throw new HubError(409, "TEAM_USER_LIMIT", "Достигнут лимит пользователей установки.");
      if (this.byLogin(login)) throw new HubError(409, "LOGIN_TAKEN", "Этот логин уже занят.");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO team_users(id,login,name,role,state,passwordHash,createdAt) VALUES(?,?,?,?,'active',?,?)",
        )
        .run(id, login, name, String(invite.role), passwordHash, Date.now());
      this.db
        .prepare("UPDATE team_invites SET state='accepted',userId=? WHERE id=?")
        .run(id, String(invite.id));
      this.db.prepare("INSERT INTO team_namespaces VALUES(?,0)").run(id);
      this.audit(id, "user.activated", id);
      return publicUser(this.user(id));
    });
  }
  disable(actor: string, userId: string, disabled: boolean) {
    this.admin(actor);
    const user = this.user(userId);
    if (
      disabled &&
      user.role === "admin" &&
      user.state === "active" &&
      Number(
        this.db
          .prepare("SELECT COUNT(*) n FROM team_users WHERE role='admin' AND state='active'")
          .get()?.n,
      ) <= 1
    )
      throw new HubError(409, "LAST_ADMIN", "Сначала назначь другого администратора.");
    if (
      disabled &&
      this.db.prepare("SELECT name FROM sqlite_master WHERE name='team_projects'").get() &&
      this.db
        .prepare(
          "SELECT 1 FROM team_projects WHERE ownerId=? AND visibility='shared' AND archived=0",
        )
        .get(userId)
    )
      throw new HubError(
        409,
        "PROJECT_TRANSFER_REQUIRED",
        "Сначала передай или архивируй общие проекты пользователя.",
      );
    this.transaction(() => {
      this.db
        .prepare("UPDATE team_users SET state=?,revision=revision+1 WHERE id=?")
        .run(disabled ? "disabled" : "active", userId);
      this.db.prepare("DELETE FROM team_sessions WHERE userId=?").run(userId);
      this.db
        .prepare(
          "UPDATE team_invites SET state='revoked' WHERE (createdBy=? OR userId=?) AND state='pending'",
        )
        .run(userId, userId);
      this.audit(actor, disabled ? "user.disabled" : "user.enabled", userId);
    });
    this.events.emit("sessions", userId);
    this.events.emit("revoked", userId);
    return publicUser(this.user(userId));
  }
  updatePassword(userId: string, passwordHash: string, expectedRevision: number) {
    const changed = this.db
      .prepare("UPDATE team_users SET passwordHash=? WHERE id=? AND revision=? AND state='active'")
      .run(passwordHash, userId, expectedRevision);
    if (!changed.changes)
      throw new HubError(409, "CREDENTIALS_CHANGED", "Доступ изменился. Повтори вход.");
    this.revoke(userId);
  }
  setRole(actor: string, userId: string, role: TeamRole, expectedRole: TeamRole) {
    this.admin(actor);
    const user = this.active(userId);
    if (user.role !== expectedRole)
      throw new HubError(409, "MEMBERSHIP_CHANGED", "Роль уже изменилась. Обнови список.");
    if (role === user.role) return publicUser(user);
    if (
      role === "member" &&
      Number(
        this.db
          .prepare("SELECT COUNT(*) n FROM team_users WHERE role='admin' AND state='active'")
          .get()?.n,
      ) <= 1
    )
      throw new HubError(409, "LAST_ADMIN", "Нельзя убрать последнего администратора.");
    this.transaction(() => {
      this.db
        .prepare("UPDATE team_users SET role=?,revision=revision+1 WHERE id=?")
        .run(role, userId);
      this.db.prepare("DELETE FROM team_sessions WHERE userId=?").run(userId);
      this.db
        .prepare("UPDATE team_invites SET state='revoked' WHERE createdBy=? AND state='pending'")
        .run(userId);
      this.audit(actor, "user.role_changed", userId);
    });
    this.events.emit("sessions", userId);
    this.events.emit("revoked", userId);
    return publicUser(this.user(userId));
  }
  close() {
    this.events.removeAllListeners();
    this.db.close();
  }
}
