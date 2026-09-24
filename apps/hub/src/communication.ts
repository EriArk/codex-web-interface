import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  HubError,
  type HumanConversation,
  type ResultShareDestination,
  type ResultShareSource,
  type SharedResultCard,
} from "@codex-web/shared";
import type { BrainstormRooms } from "./brainstorm.js";
import { CollaborationChat } from "./collaboration-chat.js";
import type { CollaborationSpaces } from "./collaboration-spaces.js";
import { readSharedFile, sharedAssetPath } from "./team-assets.js";
import type { TeamProjects } from "./team-projects.js";

const missing = () =>
  new HubError(404, "CONVERSATION_UNAVAILABLE", "Разговор или материал недоступен.");
export class Communication {
  readonly chat: CollaborationChat;
  readonly root: string;
  constructor(
    readonly team: TeamProjects,
    readonly rooms: BrainstormRooms,
    readonly spaces: CollaborationSpaces,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS human_conversations(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES team_users(id),title TEXT NOT NULL,dmKey TEXT UNIQUE,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS human_members(conversationId TEXT NOT NULL REFERENCES human_conversations(id),userId TEXT NOT NULL REFERENCES team_users(id),active INTEGER NOT NULL DEFAULT 1,muted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(conversationId,userId));
      CREATE TABLE IF NOT EXISTS shared_result_files(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES team_users(id),source TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(ownerId,source,sha256));
      CREATE TABLE IF NOT EXISTS result_share_grants(id TEXT PRIMARY KEY,snapshotId TEXT NOT NULL REFERENCES shared_result_files(id),ownerId TEXT NOT NULL REFERENCES team_users(id),kind TEXT NOT NULL,destinationId TEXT NOT NULL,messageId TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS result_ai_handoffs(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES team_users(id),snapshotId TEXT NOT NULL REFERENCES shared_result_files(id),threadId TEXT NOT NULL,binding TEXT NOT NULL,dismissed INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS result_share_messages ON result_share_grants(kind,destinationId,messageId);
    `);
    this.chat = new CollaborationChat(
      { team, access: (actor, id) => this.access(actor, id) },
      "conversation",
    );
    this.root = join(dirname(team.registry.path), "space-chat-files", "shared_result");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const kind of ["conversation", "space", "brainstorm"] as const) {
      this.destinationChat(kind).resultCards = (id, message) => this.cards(kind, id, message);
    }
  }
  get db() {
    return this.team.db;
  }
  access(actor: string, id: string) {
    this.team.registry.active(actor);
    const row = this.db
      .prepare(
        `SELECT c.* FROM human_conversations c JOIN human_members m ON m.conversationId=c.id WHERE c.id=? AND m.userId=? AND m.active=1`,
      )
      .get(id, actor);
    if (!row) throw missing();
    return row;
  }
  detail(actor: string, id: string): HumanConversation {
    const row = this.access(actor, id);
    const members = this.db
      .prepare(
        `SELECT u.id,u.name FROM human_members m JOIN team_users u ON u.id=m.userId WHERE m.conversationId=? AND m.active=1 ORDER BY u.name,u.id`,
      )
      .all(id)
      .map((r) => ({ id: String(r.id), name: String(r.name) }));
    const last = this.db
      .prepare(
        "SELECT text,authorId FROM conversation_chat_messages WHERE spaceId=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id);
    return {
      preview: last
        ? (String(last.authorId) === actor ? "Вы: " : "") +
          (String(last.text).replace(/\s+/g, " ").slice(0, 140) || "Материал")
        : "Пока нет сообщений",
      id,
      ownerId: String(row.ownerId),
      kind: row.dmKey ? "direct" : "group",
      title: row.dmKey
        ? members
            .filter((m) => m.id !== actor)
            .map((m) => m.name)
            .join(", ") || "Личный разговор"
        : String(row.title),
      members,
      unread: this.chat.unread(actor, id),
      muted: !!this.db
        .prepare("SELECT muted FROM human_members WHERE conversationId=? AND userId=?")
        .get(id, actor)?.muted,
      updatedAt: Number(
        this.db
          .prepare("SELECT max(createdAt) n FROM conversation_chat_messages WHERE spaceId=?")
          .get(id)?.n || row.createdAt,
      ),
    };
  }
  list(actor: string) {
    this.team.registry.active(actor);
    return this.db
      .prepare(
        "SELECT conversationId id FROM human_members WHERE userId=? AND active=1 ORDER BY rowid DESC LIMIT 200",
      )
      .all(actor)
      .map((r) => this.detail(actor, String(r.id)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  create(
    actor: string,
    key: string,
    input: { members: string[]; title: string; kind?: "direct" | "group" },
  ) {
    const members = [...new Set([actor, ...input.members])].sort();
    if (members.length < 2 || members.length > 8)
      throw new HubError(400, "CONVERSATION_MEMBERS", "Выбери от 1 до 7 собеседников.");
    if (
      (input.kind === "direct" && members.length !== 2) ||
      (input.kind === "group" && !input.title.trim())
    )
      throw new HubError(
        400,
        "CONVERSATION_KIND",
        "Выбери одного собеседника или укажи название группы.",
      );
    for (const id of members) this.team.registry.active(id);
    const receipt = this.team.once(
      actor,
      "conversation.create",
      key,
      { members, title: input.title, ...(input.kind ? { kind: input.kind } : {}) },
      () => {
        const dmKey = input.kind !== "group" && members.length === 2 ? members.join(":") : null;
        const existing = dmKey
          ? this.db.prepare("SELECT id FROM human_conversations WHERE dmKey=?").get(dmKey)
          : null;
        if (existing) {
          // Leaving never lets another participant restore access on someone's behalf.
          if (
            this.db
              .prepare("SELECT 1 FROM human_members WHERE conversationId=? AND active=0")
              .get(String(existing.id))
          )
            throw new HubError(409, "CONVERSATION_LEFT", "Собеседник покинул этот разговор.");
          return { id: String(existing.id) };
        }
        if (
          members.some(
            (id) =>
              Number(
                this.db
                  .prepare("SELECT count(*) n FROM human_members WHERE userId=? AND active=1")
                  .get(id)?.n,
              ) >= 200,
          )
        )
          throw new HubError(409, "CONVERSATION_LIMIT", "Достигнут лимит разговоров.");
        this.db
          .prepare("INSERT INTO human_conversations VALUES(?,?,?,?,?)")
          .run(key, actor, input.title || "Групповой разговор", dmKey, Date.now());
        for (const id of members)
          this.db
            .prepare("INSERT INTO human_members(conversationId,userId) VALUES(?,?)")
            .run(key, id);
        return { id: key };
      },
    );
    return this.detail(actor, receipt.id);
  }
  preferences(actor: string, id: string, muted: boolean) {
    this.access(actor, id);
    this.db
      .prepare("UPDATE human_members SET muted=? WHERE conversationId=? AND userId=?")
      .run(+muted, id, actor);
    return this.detail(actor, id);
  }
  leave(actor: string, id: string) {
    this.access(actor, id);
    this.db
      .prepare("UPDATE human_members SET active=0 WHERE conversationId=? AND userId=?")
      .run(id, actor);
    return { ok: true };
  }
  destinationChat(kind: ResultShareDestination["kind"]) {
    return kind === "conversation"
      ? this.chat
      : kind === "brainstorm"
        ? this.rooms.chat
        : this.spaces.chat;
  }
  destination(actor: string, d: ResultShareDestination, write = false) {
    if (d.kind === "conversation") return this.access(actor, d.id);
    if (d.kind === "brainstorm") return this.rooms.access(actor, d.id, write);
    return this.spaces.access(actor, d.id);
  }
  capture(
    actor: string,
    source: ResultShareSource,
    file: { name: string; mime: string; data: Buffer },
  ) {
    this.team.registry.active(actor);
    if (file.data.length > 32 * 1024 ** 2)
      throw new HubError(413, "SHARE_TOO_LARGE", "Материал больше 32 МБ.");
    const sha256 = createHash("sha256").update(file.data).digest("hex"),
      identity = JSON.stringify(source);
    const old = this.db
      .prepare("SELECT * FROM shared_result_files WHERE ownerId=? AND source=? AND sha256=?")
      .get(actor, identity, sha256);
    if (old) {
      this.bytes(old);
      return this.snapshot(old);
    }
    if (
      Number(this.db.prepare("SELECT coalesce(sum(bytes),0) n FROM shared_result_files").get()?.n) +
        file.data.length >
      1024 ** 3
    )
      throw new HubError(507, "SHARE_STORAGE_FULL", "Хранилище пересылок заполнено.");
    const id = randomUUID();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: download name only
    const name = file.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 180) || "Результат";
    writeFileSync(sharedAssetPath(this.root, id), file.data, { flag: "wx", mode: 0o600 });
    try {
      this.db
        .prepare("INSERT INTO shared_result_files VALUES(?,?,?,?,?,?,?,?)")
        .run(
          id,
          actor,
          identity,
          name,
          file.mime.slice(0, 120),
          file.data.length,
          sha256,
          Date.now(),
        );
    } catch (e) {
      unlinkSync(sharedAssetPath(this.root, id));
      throw e;
    }
    return this.snapshot(this.db.prepare("SELECT * FROM shared_result_files WHERE id=?").get(id)!);
  }
  private snapshot(r: Record<string, unknown>) {
    return {
      id: String(r.id),
      ownerId: String(r.ownerId),
      title: String(r.name),
      mime: String(r.mime),
      bytes: Number(r.bytes),
      sha256: String(r.sha256),
      createdAt: Number(r.createdAt),
    };
  }
  private bytes(r: Record<string, unknown>) {
    return readSharedFile(this.root, {
      id: String(r.id),
      bytes: Number(r.bytes),
      sha256: String(r.sha256),
    });
  }
  share(
    actor: string,
    key: string,
    input: { snapshotId: string; destination: ResultShareDestination; publicRoom: boolean },
  ) {
    this.destination(actor, input.destination, true);
    const snapshot = this.db
      .prepare("SELECT * FROM shared_result_files WHERE id=? AND ownerId=?")
      .get(input.snapshotId, actor);
    if (!snapshot) throw missing();
    if (input.destination.kind === "brainstorm" && !input.publicRoom)
      throw new HubError(
        409,
        "ROOM_AUDIENCE_REQUIRED",
        "Подтверди доступ всех пользователей к материалу в комнате.",
      );
    this.bytes(snapshot);
    return this.team.once(actor, "result.share", key, input, () => {
      const { kind, id } = input.destination;
      this.db
        .prepare("INSERT INTO result_share_grants VALUES(?,?,?,?,?,?,0,?)")
        .run(key, input.snapshotId, actor, kind, id, key, Date.now());
      // Same transaction as the grant and receipt: lost acknowledgement cannot duplicate either.
      const table =
        kind === "conversation" ? "conversation" : kind === "brainstorm" ? "brainstorm" : "space";
      this.db
        .prepare(
          `INSERT INTO ${table}_chat_messages(id,spaceId,authorId,text,createdAt) VALUES(?,?,?,?,?)`,
        )
        .run(key, id, actor, "", Date.now());
      return { id: key, destination: input.destination };
    });
  }
  cards(kind: ResultShareDestination["kind"], id: string, message: string): SharedResultCard[] {
    return this.db
      .prepare(
        "SELECT f.*,g.id grantId,g.revoked FROM result_share_grants g JOIN shared_result_files f ON f.id=g.snapshotId WHERE g.kind=? AND g.destinationId=? AND g.messageId=?",
      )
      .all(kind, id, message)
      .map((r) => ({
        ...this.snapshot(r),
        id: String(r.grantId),
        snapshotId: String(r.id),
        revoked: !!r.revoked,
      }));
  }
  private authorizedShare(actor: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT f.*,g.kind,g.destinationId,g.revoked FROM result_share_grants g JOIN shared_result_files f ON f.id=g.snapshotId WHERE g.id=?",
      )
      .get(id);
    if (!row) throw missing();
    this.destination(actor, {
      kind: row.kind as ResultShareDestination["kind"],
      id: String(row.destinationId),
    });
    if (row.revoked)
      throw new HubError(410, "RESULT_SHARE_REVOKED", "Доступ к результату отозван.");
    return row;
  }
  describe(actor: string, id: string) {
    return this.snapshot(this.authorizedShare(actor, id));
  }
  read(actor: string, id: string) {
    const row = this.authorizedShare(actor, id);
    return { ...this.snapshot(row), data: this.bytes(row) };
  }
  ownerSnapshot(actor: string, id: string) {
    this.team.registry.active(actor);
    const row = this.db
      .prepare("SELECT * FROM shared_result_files WHERE id=? AND ownerId=?")
      .get(id, actor);
    if (!row) throw missing();
    return { ...this.snapshot(row), data: this.bytes(row) };
  }
  grants(actor: string, snapshotId: string) {
    this.team.registry.active(actor);
    if (
      !this.db
        .prepare("SELECT 1 FROM shared_result_files WHERE id=? AND ownerId=?")
        .get(snapshotId, actor)
    )
      throw missing();
    return this.db
      .prepare(
        "SELECT id,kind,destinationId,revoked,createdAt FROM result_share_grants WHERE snapshotId=? ORDER BY createdAt DESC",
      )
      .all(snapshotId);
  }
  revoke(actor: string, id: string) {
    this.team.registry.active(actor);
    if (
      !this.db.prepare("SELECT 1 FROM result_share_grants WHERE id=? AND ownerId=?").get(id, actor)
    )
      throw missing();
    this.db.prepare("UPDATE result_share_grants SET revoked=1 WHERE id=?").run(id);
    return { ok: true };
  }
}
