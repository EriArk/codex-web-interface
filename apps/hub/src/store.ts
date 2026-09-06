import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Attachment, HubError, type HubEvent, type TurnSettings } from "@codex-web/shared";

import { migrateDatabase } from "./migrations.js";

export interface ThreadRecord {
  id: string;
  projectId: string;
  codexThreadId: string;
  title: string;
  settings?: TurnSettings;
  origin?: string;
  workingDirectory?: string;
  historyMode?: string;
  sourceUpdatedAt?: number;
  archived?: number;
  status: string;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MessageRecord {
  threadId: string;
  id: string;
  turnId: string | null;
  role: string;
  phase: string;
  text: string;
  firstSeq: number;
  lastSeq: number;
  createdAt: string;
  attachments?: Attachment[];
}
export class Store {
  readonly schemaVersion: number;
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      this.schemaVersion = migrateDatabase(this.db, path);
      this.db.exec("PRAGMA journal_mode=WAL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db
      .prepare(
        "UPDATE threads SET status='unknown' WHERE status IN ('starting','running','waiting_approval')",
      )
      .run();
    this.db.prepare("UPDATE commands SET state='unknown' WHERE state='pending'").run();
    this.db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  }
  close(): void {
    this.db.close();
  }
  createThread(projectId: string, codexThreadId: string, title: string): ThreadRecord {
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO threads(id,projectId,codexThreadId,title,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
      )
      .run(id, projectId, codexThreadId, title, now, now);
    return this.thread(id);
  }
  thread(id: string): ThreadRecord {
    const row = this.db.prepare("SELECT * FROM threads WHERE id=?").get(id) as unknown as
      | ThreadRecord
      | undefined;
    if (!row) throw new HubError(404, "THREAD_NOT_FOUND", "Диалог не найден");
    return { ...row, settings: this.threadSettings(id) };
  }
  threadByCodex(id: string): ThreadRecord | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE codexThreadId=?").get(id) as unknown as
      | ThreadRecord
      | undefined;
  }
  threads(projectId: string): ThreadRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM threads WHERE projectId=? ORDER BY updatedAt DESC LIMIT 200")
        .all(projectId) as unknown as ThreadRecord[]
    ).map((t) => ({ ...t, settings: this.threadSettings(t.id) }));
  }
  threadSettings(id: string): TurnSettings | undefined {
    const row = this.db.prepare("SELECT value FROM thread_settings WHERE threadId=?").get(id);
    return row ? (JSON.parse(String(row.value)) as TurnSettings) : undefined;
  }
  setThreadSettings(id: string, settings: TurnSettings): void {
    this.db
      .prepare(
        "INSERT INTO thread_settings VALUES(?,?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value",
      )
      .run(id, JSON.stringify(settings));
  }
  withAttachments(messages: MessageRecord[]): MessageRecord[] {
    return messages.map((message) => ({
      ...message,
      attachments: this.db
        .prepare("SELECT * FROM attachments WHERE threadId=? AND messageId=? ORDER BY createdAt")
        .all(message.threadId, message.id)
        .map((row) => this.attachmentPublic(row)),
    }));
  }
  attachmentPublic(row: Record<string, unknown>): Attachment {
    return {
      ...row,
      image: !!row.image,
      url: `/api/attachments/${row.id}`,
      ...(row.image ? { previewUrl: `/api/attachments/${row.id}/preview` } : {}),
    } as unknown as Attachment;
  }
  setStatus(id: string, status: string, turnId: string | null = null): void {
    this.db
      .prepare("UPDATE threads SET status=?,activeTurnId=?,updatedAt=? WHERE id=?")
      .run(status, turnId, new Date().toISOString(), id);
  }
  append(
    threadId: string,
    type: string,
    payload: Record<string, unknown>,
    turnId: string | null = null,
  ): HubEvent {
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("INSERT INTO events(threadId,turnId,type,payload,createdAt) VALUES(?,?,?,?,?)")
        .run(threadId, turnId, type, JSON.stringify(payload), createdAt);
      const seq = Number(row.lastInsertRowid);
      if (["user.message", "assistant.delta", "assistant.completed"].includes(type)) {
        const role = type === "user.message" ? "user" : "assistant",
          id = String(payload.id),
          value = String(payload.text ?? "").slice(0, 200000);
        this.db
          .prepare(
            "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(threadId,id) DO NOTHING",
          )
          .run(threadId, id, turnId, role, String(payload.phase ?? ""), "", seq, seq, createdAt);
        if (type === "assistant.delta")
          this.db
            .prepare(
              "UPDATE messages SET text=substr(text || ?,1,200000),lastSeq=?,turnId=COALESCE(turnId,?) WHERE threadId=? AND id=?",
            )
            .run(value, seq, turnId, threadId, id);
        else
          this.db
            .prepare(
              "UPDATE messages SET text=?,phase=?,lastSeq=?,turnId=COALESCE(turnId,?) WHERE threadId=? AND id=?",
            )
            .run(value, String(payload.phase ?? ""), seq, turnId, threadId, id);
      }
      if (type === "turn.started")
        this.db
          .prepare(
            "UPDATE messages SET turnId=? WHERE threadId=? AND role='user' AND turnId IS NULL AND firstSeq=(SELECT MAX(firstSeq) FROM messages WHERE threadId=? AND role='user')",
          )
          .run(turnId, threadId, threadId);
      this.db.exec("COMMIT");
      return { seq, threadId, turnId, type, payload, createdAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  history(
    threadId: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 20,
  ): { messages: MessageRecord[]; nextBefore: number | null; hasMore: boolean; lastSeq: number } {
    limit = Math.max(1, Math.min(30, limit));
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE threadId=? AND firstSeq<? ORDER BY firstSeq DESC LIMIT ?",
      )
      .all(threadId, before, limit + 1) as unknown as MessageRecord[];
    const hasMore = rows.length > limit;
    const messages = this.withAttachments(rows.slice(0, limit).reverse());
    return {
      messages,
      hasMore,
      nextBefore: hasMore ? (messages[0]?.firstSeq ?? null) : null,
      lastSeq: this.lastSeq(threadId),
    };
  }
  context(threadId: string, turnId: string): Record<string, unknown> {
    const start = this.db
      .prepare("SELECT MIN(firstSeq) AS seq FROM messages WHERE threadId=? AND turnId=?")
      .get(threadId, turnId)?.seq;
    if (!start) throw new HubError(404, "TURN_NOT_FOUND", "Сообщение этого хода ещё не сохранено");
    const messages = this.db
      .prepare("SELECT * FROM messages WHERE threadId=? AND firstSeq>=? ORDER BY firstSeq LIMIT 20")
      .all(threadId, Number(start)) as unknown as MessageRecord[];
    const hasMore = !!this.db
      .prepare("SELECT 1 FROM messages WHERE threadId=? AND firstSeq<? LIMIT 1")
      .get(threadId, Number(start));
    const hasNewer = !!this.db
      .prepare("SELECT 1 FROM messages WHERE threadId=? AND firstSeq>? LIMIT 1")
      .get(threadId, messages.at(-1)?.firstSeq ?? 0);
    return {
      messages: this.withAttachments(messages),
      hasMore,
      nextBefore: hasMore ? Number(start) : null,
      lastSeq: this.lastSeq(threadId),
      contextTurn: turnId,
      hasNewer,
    };
  }
  events(threadId: string, after = 0, limit = 500): HubEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE threadId=? AND seq>? ORDER BY seq LIMIT ?")
      .all(threadId, after, limit);
    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(String(row.payload)),
    })) as unknown as HubEvent[];
  }
  activity(threadId: string, before = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE threadId=? AND seq<? AND (type LIKE 'activity.%' OR type='error') ORDER BY seq DESC LIMIT 21",
      )
      .all(threadId, before);
    const items = rows.slice(0, 20).map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
    return { items, nextBefore: rows.length > 20 ? rows[19]?.seq : null };
  }
  lastSeq(threadId: string): number {
    return Number(
      this.db
        .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE threadId=?")
        .get(threadId)?.seq,
    );
  }
  result(
    threadId: string,
    turnId: string | null,
    sourceKey: string,
    type: string,
    title: string,
    payload: Record<string, unknown>,
  ): string | undefined {
    const id = randomUUID();
    const r = this.db
      .prepare("INSERT OR IGNORE INTO results VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        threadId,
        turnId,
        sourceKey,
        type,
        title,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
    return r.changes ? id : undefined;
  }
  results(threadId: string, before = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
    const rows = this.db
      .prepare(
        "SELECT rowid AS cursor,* FROM results WHERE threadId=? AND rowid<? ORDER BY rowid DESC LIMIT 21",
      )
      .all(threadId, before);
    const items = rows.slice(0, 20).map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
    return { items, nextBefore: rows.length > 20 ? rows[19]?.cursor : null };
  }
  preferences(): Record<string, unknown> {
    const row = this.db.prepare("SELECT value FROM preferences WHERE id=1").get();
    return row ? JSON.parse(String(row.value)) : { theme: "organizer" };
  }
  setPreferences(value: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...this.preferences(), ...value };
    this.db
      .prepare(
        "INSERT INTO preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(merged));
    return merged;
  }
  async once(
    scope: string,
    key: string,
    input: unknown,
    action: () => Promise<unknown>,
  ): Promise<unknown> {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const found = this.db.prepare("SELECT * FROM commands WHERE scope=? AND key=?").get(scope, key);
    if (found) {
      if (found.digest !== digest)
        throw new HubError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Этот ключ уже использован для другой команды",
        );
      if (found.state === "complete") return JSON.parse(String(found.response));
      throw new HubError(
        409,
        found.state === "pending" ? "COMMAND_PENDING" : "COMMAND_OUTCOME_UNKNOWN",
        "Команда уже отправлена. Проверь состояние диалога перед новой отправкой",
      );
    }
    this.db
      .prepare("INSERT INTO commands(scope,key,digest,state,createdAt) VALUES(?,?,?,'pending',?)")
      .run(scope, key, digest, new Date().toISOString());
    try {
      const value = await action();
      this.db
        .prepare("UPDATE commands SET state='complete',response=? WHERE scope=? AND key=?")
        .run(JSON.stringify(value), scope, key);
      return value;
    } catch (error) {
      this.db
        .prepare("UPDATE commands SET state='unknown' WHERE scope=? AND key=?")
        .run(scope, key);
      throw error;
    }
  }
}
