import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  HubError,
  type SpaceChatFile,
  type SpaceChatMessage,
  type SpaceChatPage,
} from "@codex-web/shared";
import type { CollaborationSpaces } from "./collaboration-spaces.js";
import { readSharedFile, sharedAssetPath } from "./team-assets.js";

const absent = () => new HubError(404, "SPACE_FILE_MISSING", "Файл недоступен.");
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
export class CollaborationChat {
  readonly root: string;
  private swept = 0;
  constructor(
    readonly spaces: {
      team: CollaborationSpaces["team"];
      access: (actor: string, id: string) => unknown;
    },
    private namespace: "space" | "brainstorm" = "space",
  ) {
    this.root = join(
      dirname(spaces.team.registry.path),
      "space-chat-files",
      ...(namespace === "brainstorm" ? ["brainstorm"] : []),
    );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS space_chat_messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        spaceId TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
        authorId TEXT NOT NULL REFERENCES team_users(id), text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS space_chat_history ON space_chat_messages(spaceId,seq);
      CREATE TABLE IF NOT EXISTS space_chat_reads(
        spaceId TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
        userId TEXT NOT NULL REFERENCES team_users(id), seq INTEGER NOT NULL,
        PRIMARY KEY(spaceId,userId));
      CREATE TABLE IF NOT EXISTS space_chat_files(
        id TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
        authorId TEXT NOT NULL REFERENCES team_users(id), name TEXT NOT NULL, mime TEXT NOT NULL,
        bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, createdAt INTEGER NOT NULL,
        messageSeq INTEGER REFERENCES space_chat_messages(seq) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS space_chat_file_message ON space_chat_files(messageSeq);
    `);
  }
  private get db() {
    const db = this.spaces.team.db;
    const sql = (value: string) =>
      this.namespace === "space"
        ? value
        : value
            .replaceAll("space_chat_", "brainstorm_chat_")
            .replaceAll("collaboration_spaces", "brainstorm_rooms");
    return {
      prepare: (value: string) => db.prepare(sql(value)),
      exec: (value: string) => db.exec(sql(value)),
    };
  }
  /** Called inside the board transaction; a selected upload becomes an ordinary shared attachment. */
  publishFile(actor: string, spaceId: string, id: string) {
    this.readFile(actor, spaceId, id);
    const row = this.db
      .prepare("SELECT * FROM space_chat_files WHERE id=? AND spaceId=?")
      .get(id, spaceId)!;
    if (row.messageSeq !== null) return;
    const message = randomUUID();
    this.db
      .prepare(
        "INSERT INTO space_chat_messages(id,spaceId,authorId,text,createdAt) VALUES(?,?,?,?,?)",
      )
      .run(message, spaceId, actor, "Материал на доске", Date.now());
    this.db
      .prepare(
        "UPDATE space_chat_files SET messageSeq=(SELECT seq FROM space_chat_messages WHERE id=?) WHERE id=?",
      )
      .run(message, id);
  }
  unread(actor: string, spaceId: string) {
    return Number(
      this.db
        .prepare(`SELECT count(*) n FROM space_chat_messages WHERE spaceId=?
      AND seq>COALESCE((SELECT seq FROM space_chat_reads WHERE spaceId=? AND userId=?),0)
      AND authorId<>?`)
        .get(spaceId, spaceId, actor, actor)?.n ?? 0,
    );
  }
  private file(row: Record<string, unknown>): SpaceChatFile {
    return {
      id: String(row.id),
      name: String(row.name),
      mime: String(row.mime),
      bytes: Number(row.bytes),
    };
  }
  private message(row: Record<string, unknown>): SpaceChatMessage {
    const author = this.spaces.team.registry.user(String(row.authorId));
    return {
      seq: Number(row.seq),
      id: String(row.id),
      author: { id: author.id, name: author.name },
      text: String(row.text),
      createdAt: Number(row.createdAt),
      files: this.db
        .prepare("SELECT * FROM space_chat_files WHERE messageSeq=? ORDER BY rowid")
        .all(row.seq as number)
        .map((r) => this.file(r)),
    };
  }
  page(actor: string, spaceId: string, cursor: { before?: number; after?: number }): SpaceChatPage {
    this.spaces.access(actor, spaceId);
    const forward = cursor.after !== undefined,
      limit = forward ? 100 : 20;
    const rows = this.db
      .prepare(`SELECT * FROM space_chat_messages WHERE spaceId=? AND seq ${forward ? ">" : "<"} ?
      ORDER BY seq ${forward ? "ASC" : "DESC"} LIMIT ?`)
      .all(spaceId, cursor.after ?? cursor.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const more = rows.length > limit;
    const selected = rows.slice(0, limit);
    if (!forward) selected.reverse();
    return { messages: selected.map((r) => this.message(r)), more };
  }
  markRead(actor: string, spaceId: string, seq: number) {
    this.spaces.access(actor, spaceId);
    // Only an actually displayed message can advance this account's cursor.
    if (
      !this.db
        .prepare("SELECT 1 FROM space_chat_messages WHERE spaceId=? AND seq=?")
        .get(spaceId, seq)
    )
      return { ok: true };
    this.db
      .prepare(`INSERT INTO space_chat_reads VALUES(?,?,?) ON CONFLICT(spaceId,userId)
      DO UPDATE SET seq=MAX(seq,excluded.seq)`)
      .run(spaceId, actor, seq);
    return { ok: true };
  }
  send(actor: string, spaceId: string, key: string, input: { text: string; files: string[] }) {
    this.spaces.access(actor, spaceId);
    return this.spaces.team.once(actor, "spaces.chat:" + spaceId, key, input, () => {
      const rows = input.files.map((id) => {
        const row = this.db
          .prepare(
            "SELECT * FROM space_chat_files WHERE id=? AND spaceId=? AND authorId=? AND messageSeq IS NULL",
          )
          .get(id, spaceId, actor);
        if (!row) throw absent();
        readSharedFile(this.root, { ...this.file(row), sha256: String(row.sha256) });
        return row;
      });
      const id = key;
      this.db
        .prepare(
          "INSERT INTO space_chat_messages(id,spaceId,authorId,text,createdAt) VALUES(?,?,?,?,?)",
        )
        .run(id, spaceId, actor, input.text, Date.now());
      const row = this.db.prepare("SELECT * FROM space_chat_messages WHERE id=?").get(id)!;
      for (const file of rows)
        this.db
          .prepare("UPDATE space_chat_files SET messageSeq=? WHERE id=?")
          .run(row.seq as number, String(file.id));
      return this.message(row);
    });
  }
  stage(actor: string, spaceId: string, name: string, mime: string, data: Buffer): SpaceChatFile {
    this.spaces.access(actor, spaceId);
    if (data.length > 32 * 1024 * 1024)
      throw new HubError(413, "SPACE_FILE_TOO_LARGE", "Файл больше 32 МБ.");
    this.sweep();
    if (
      Number(this.db.prepare("SELECT COALESCE(sum(bytes),0) n FROM space_chat_files").get()?.n) +
        data.length >
      1024 ** 3
    )
      throw new HubError(507, "SPACE_STORAGE_FULL", "Хранилище файлов общих чатов заполнено.");
    const sha256 = createHash("sha256").update(data).digest("hex");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: normalize download filename
    name = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 180) || "Файл";
    mime = imageTypes.has(mime) ? mime : "application/octet-stream";
    const duplicate = this.db
      .prepare(
        "SELECT * FROM space_chat_files WHERE spaceId=? AND authorId=? AND sha256=? AND name=? AND mime=? AND messageSeq IS NULL",
      )
      .get(spaceId, actor, sha256, name, mime);
    if (duplicate) return this.file(duplicate);
    const id = randomUUID(),
      path = sharedAssetPath(this.root, id);
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
    try {
      this.db
        .prepare("INSERT INTO space_chat_files VALUES(?,?,?,?,?,?,?,?,NULL)")
        .run(id, spaceId, actor, name, mime, data.length, sha256, Date.now());
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    return { id, name, mime, bytes: data.length };
  }
  readFile(actor: string, spaceId: string, id: string) {
    this.spaces.access(actor, spaceId);
    const row = this.db
      .prepare(
        "SELECT * FROM space_chat_files WHERE id=? AND spaceId=? AND (authorId=? OR messageSeq IS NOT NULL)",
      )
      .get(id, spaceId, actor);
    if (!row) throw absent();
    const file = this.file(row);
    return { ...file, data: readSharedFile(this.root, { ...file, sha256: String(row.sha256) }) };
  }
  private sweep() {
    if (Date.now() - this.swept < 3600_000) return;
    this.swept = Date.now();
    this.db
      .prepare("DELETE FROM space_chat_files WHERE messageSeq IS NULL AND createdAt<?")
      .run(Date.now() - 7 * 86400_000);
    for (const name of readdirSync(this.root)) {
      if (!/^[a-f0-9-]{36}\.bin$/.test(name)) continue;
      const path = join(this.root, name);
      if (
        !this.db.prepare("SELECT 1 FROM space_chat_files WHERE id=?").get(name.slice(0, -4)) &&
        statSync(path).mtimeMs < Date.now() - 3600_000
      )
        unlinkSync(path);
    }
  }
}
