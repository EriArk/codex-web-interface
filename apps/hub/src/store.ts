import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Attachment,
  compareThreadActivity,
  emptyResultCounts,
  HubError,
  type HubEvent,
  hasUnreadCompletion,
  isActiveThread,
  type NavigationState,
  NotSubmittedError,
  type ProjectActivity,
  type ResultCategory,
  resultCategory,
  type ThreadActivity,
  type TurnSettings,
} from "@codex-web/shared";

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
  activitySource?: string;
  activityAt?: string | null;
  nativeObservedTurn?: string;
  nativeObservedStatus?: string;
  nativeObservedAt?: number;
  archived?: number;
  diagnostic?: number;
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
  images?: { id: string; name: string; url: string }[];
}
export class Store {
  /** Supplied by attachment storage; only immutable preview fingerprints are cached. */
  attachmentImageKey?: (id: string) => string | undefined;
  readonly changes = new EventEmitter();
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
    this.changes.emit("navigation");
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
        .prepare(
          "SELECT * FROM threads WHERE projectId=? AND archived=0 ORDER BY CASE WHEN status IN ('starting','running','waiting_approval') THEN 0 ELSE 1 END, CASE WHEN status IN ('starting','running','waiting_approval') THEN activityAt ELSE updatedAt END DESC, id LIMIT 200",
        )
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
    return messages.map((message) => {
      const attachments = this.db
        .prepare("SELECT * FROM attachments WHERE threadId=? AND messageId=? ORDER BY createdAt")
        .all(message.threadId, message.id)
        .map((row) => this.attachmentPublic(row));
      const native = this.db
        .prepare(
          "SELECT id,name,CASE WHEN substr(source,1,5)='data:' THEN '' ELSE source END AS source,sourceKey FROM native_images WHERE threadId=? AND messageId=?",
        )
        .all(message.threadId, message.id);
      const keys = new Set(
        attachments
          .filter((file) => file.image)
          .map((file) => this.attachmentImageKey?.(file.id))
          .filter(Boolean),
      );
      const duplicates = new Set(
        native
          .filter((image) => {
            if (keys.has(String(image.sourceKey))) return true;
            const path = String(image.source).replaceAll("\\", "/");
            return attachments.some(
              (file) => file.image && path.endsWith(`/${file.id}/upload-image-preview.jpg`),
            );
          })
          .map((image) => String(image.id)),
      );
      const images =
        message.images ??
        native.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          url: `/api/native-images/${row.id}`,
        }));
      return {
        ...message,
        attachments,
        images: images.filter((image) => !duplicates.has(image.id)),
      };
    });
  }
  attachmentPublic(row: Record<string, unknown>): Attachment {
    return {
      ...row,
      image: !!row.image,
      url: `/api/attachments/${row.id}`,
      ...(row.image ? { previewUrl: `/api/attachments/${row.id}/preview` } : {}),
    } as unknown as Attachment;
  }
  setStatus(
    id: string,
    status: string,
    turnId: string | null = null,
    observedAt = new Date().toISOString(),
  ): void {
    const previous = this.thread(id);
    // Reconnect, idle probes and read receipts are not new conversation activity.
    const began =
      isActiveThread(status) &&
      !isActiveThread(previous.status) &&
      (!turnId || turnId !== previous.activeTurnId || !previous.activityAt);
    const ended =
      isActiveThread(previous.status) &&
      ["idle", "completed", "interrupted", "failed"].includes(status);
    this.db
      .prepare(
        "UPDATE threads SET activityAt=CASE WHEN ? THEN ? ELSE activityAt END,status=?,activeTurnId=?,updatedAt=CASE WHEN ? THEN MAX(updatedAt,?) ELSE updatedAt END WHERE id=?",
      )
      .run(Number(began), observedAt, status, turnId, Number(began || ended), observedAt, id);
    this.changes.emit("navigation");
  }
  navigation(projectIds: string[]): NavigationState {
    const projects = new Map<string, ProjectActivity>(
      projectIds.map((id) => [
        id,
        { id, active: 0, unread: 0, waiting: 0, updatedAt: "", activityAt: "" },
      ]),
    );
    const rows = this.db
      .prepare(
        "SELECT id,projectId,title,status,activeTurnId,updatedAt,activityAt,completedSeq,seenSeq,completedTurnId,completedStatus,activitySource FROM threads WHERE archived=0",
      )
      .all() as unknown as ThreadActivity[];
    const groups = new Map<string, ThreadActivity[]>();
    for (const thread of rows) {
      const project = projects.get(thread.projectId);
      if (!project) continue;
      const active = isActiveThread(thread.status);
      project.active += Number(active);
      project.unread += Number(hasUnreadCompletion(thread));
      project.waiting += Number(thread.status === "waiting_approval");
      if (thread.updatedAt > project.updatedAt) project.updatedAt = thread.updatedAt;
      if (active && (thread.activityAt ?? "") > project.activityAt)
        project.activityAt = thread.activityAt ?? "";
      const list = groups.get(thread.projectId) ?? [];
      list.push(thread);
      groups.set(thread.projectId, list);
    }
    // Full counts, bounded metadata per project, never conversation contents.
    return {
      projects: [...projects.values()],
      threads: [...groups.values()].flatMap((list) =>
        list.sort(compareThreadActivity).slice(0, 200),
      ),
    };
  }
  markSeen(id: string, completedSeq: number): void {
    this.thread(id);
    const result = this.db
      .prepare(
        "UPDATE threads SET seenSeq=MIN(completedSeq,?) WHERE id=? AND seenSeq<MIN(completedSeq,?)",
      )
      .run(completedSeq, id, completedSeq);
    if (result.changes) this.changes.emit("navigation");
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
      if (
        type === "turn.completed" &&
        turnId &&
        ["completed", "interrupted", "failed"].includes(String(payload.status))
      )
        this.db
          .prepare(
            "UPDATE threads SET completedSeq=?,completedTurnId=?,completedStatus=? WHERE id=? AND (completedTurnId IS NULL OR completedTurnId<>?)",
          )
          .run(seq, turnId, String(payload.status), threadId, turnId);
      this.db.exec("COMMIT");
      if (type === "turn.completed") this.changes.emit("navigation");
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
  context(threadId: string, turnId: string, messageId?: string): Record<string, unknown> {
    const start = messageId
      ? this.db
          .prepare("SELECT firstSeq AS seq FROM messages WHERE threadId=? AND id=?")
          .get(threadId, messageId)?.seq
      : this.db
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
  progressDetails(
    threadId: string,
    turnId: string | null,
  ): { items: { seq: number; itemId?: string; kind: string; label: string; text: string }[] } {
    if (!turnId) return { items: [] };
    const rows = this.db
      .prepare(
        "SELECT seq,type,payload FROM events WHERE threadId=? AND turnId=? AND type IN ('turn.progress','activity.summary','activity.command','activity.tool','error') ORDER BY seq DESC LIMIT 80",
      )
      .all(threadId, turnId);
    const seen = new Set<string>(),
      items: { seq: number; itemId?: string; kind: string; label: string; text: string }[] = [];
    for (const row of rows) {
      const p = JSON.parse(String(row.payload));
      const key = String(p.itemId || (row.type === "turn.progress" ? p.label : row.seq));
      if (seen.has(key)) continue;
      seen.add(key);
      const kind =
        row.type === "activity.summary"
          ? "summary"
          : row.type === "activity.command" || p.command
            ? "command"
            : "step";
      items.push({
        seq: Number(row.seq),
        ...(p.itemId ? { itemId: String(p.itemId) } : {}),
        kind,
        label:
          row.type === "activity.summary"
            ? "Краткое пояснение"
            : row.type === "activity.command"
              ? p.exitCode === 0
                ? "Команда завершена"
                : "Результат команды"
              : String(p.label || p.tool || p.message || "Действие Codex").slice(0, 500),
        text: String(p.command || p.text || p.detail || "").slice(0, 8000),
      });
      if (items.length === 8) break;
    }
    return { items: items.reverse() };
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
  results(
    threadId: string,
    before = Number.MAX_SAFE_INTEGER,
    category: ResultCategory = "all",
  ): Record<string, unknown> {
    const buckets = this.db
      .prepare("SELECT type,count(*) AS count FROM results WHERE threadId=? GROUP BY type")
      .all(threadId);
    const counts = emptyResultCounts();
    for (const row of buckets) {
      counts.all += Number(row.count);
      counts[resultCategory(String(row.type))] += Number(row.count);
    }
    const types = buckets
      .filter((row) => category === "all" || resultCategory(String(row.type)) === category)
      .map((row) => String(row.type));
    if (!types.length) return { items: [], counts, nextBefore: null };
    const rows = this.db
      .prepare(
        "SELECT rowid AS cursor,* FROM results WHERE threadId=? AND rowid<? AND type IN (" +
          types.map(() => "?").join(",") +
          ") ORDER BY rowid DESC LIMIT 21",
      )
      .all(threadId, before, ...types);
    const items = rows
      .slice(0, 20)
      .map((row) => ({ ...row, payload: JSON.parse(String(row.payload)) }));
    return { items, counts, nextBefore: rows.length > 20 ? rows[19]?.cursor : null };
  }
  projectResults(
    projectId: string,
    before = Number.MAX_SAFE_INTEGER,
    category: ResultCategory = "all",
  ) {
    const buckets = this.db
      .prepare(
        "SELECT r.type,count(*) AS count FROM results r JOIN threads t ON t.id=r.threadId WHERE t.projectId=? GROUP BY r.type",
      )
      .all(projectId);
    const counts = emptyResultCounts();
    for (const row of buckets) {
      counts.all += Number(row.count);
      counts[resultCategory(String(row.type))] += Number(row.count);
    }
    const types = buckets
      .filter((row) => category === "all" || resultCategory(String(row.type)) === category)
      .map((row) => String(row.type));
    if (!types.length) return { items: [], counts, nextBefore: null };
    const rows = this.db
      .prepare(
        "SELECT r.rowid AS cursor,r.*,t.title AS threadTitle FROM results r JOIN threads t ON t.id=r.threadId WHERE t.projectId=? AND r.rowid<? AND r.type IN (" +
          types.map(() => "?").join(",") +
          ") ORDER BY r.rowid DESC LIMIT 21",
      )
      .all(projectId, before, ...types);
    return {
      items: rows.slice(0, 20).map((row) => ({ ...row, payload: JSON.parse(String(row.payload)) })),
      counts,
      nextBefore: rows.length > 20 ? rows[19]?.cursor : null,
    };
  }
  resultById(threadId: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM results WHERE threadId=? AND id=?")
      .get(threadId, id);
    if (!row) throw new HubError(404, "RESULT_NOT_FOUND", "Результат не найден.");
    return { ...row, payload: JSON.parse(String(row.payload)) };
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
      if (error instanceof NotSubmittedError) {
        this.db.prepare("DELETE FROM commands WHERE scope=? AND key=?").run(scope, key);
        throw error;
      }
      this.db
        .prepare("UPDATE commands SET state='unknown' WHERE scope=? AND key=?")
        .run(scope, key);
      throw error;
    }
  }
}
