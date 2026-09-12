import { stripVTControlCharacters } from "node:util";
import type { NativeCommand, NativeWork } from "@codex-web/shared";
import type { Store } from "./store.js";

const LIMIT = 256000; // At most 1 MiB UTF-8 per command; retain the useful tail.
const TOTAL = 64 * 1024 ** 2;
const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
type Log = NativeCommand & { threadId: string; turnId: string; dirty: boolean };

/** Bounded, coalesced snapshots, not a second event stream containing every output delta. */
export class NativeWorkStore {
  private logs = new Map<string, Log>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private store: Store) {
    store.db
      .prepare(
        "UPDATE command_logs SET value=json_set(value,'$.status','unknown') WHERE json_extract(value,'$.status')='inProgress'",
      )
      .run();
  }
  update(threadId: string, turnId: string, kind: "plan" | "usage" | "diff", raw: unknown) {
    const p = object(raw);
    let value: unknown;
    if (kind === "plan") {
      if (!Array.isArray(p.plan)) return;
      value = {
        explanation: text(p.explanation, 4000),
        steps: p.plan.slice(0, 80).flatMap((v: unknown) => {
          const s = object(v);
          return typeof s.step === "string" &&
            ["pending", "inProgress", "completed"].includes(s.status)
            ? [{ text: s.step.slice(0, 2000), status: s.status }]
            : [];
        }),
      };
    } else if (kind === "usage") {
      const u = object(p.tokenUsage),
        last = object(u.last);
      if (
        [last.inputTokens, last.outputTokens, last.cachedInputTokens, last.totalTokens].some(
          (v) => count(v) === null,
        )
      )
        return;
      value = {
        input: last.inputTokens,
        output: last.outputTokens,
        cached: last.cachedInputTokens,
        total: last.totalTokens,
        capacity: count(u.modelContextWindow) || null,
      };
    } else {
      if (typeof p.diff !== "string") return;
      value = {
        text: stripVTControlCharacters(p.diff.slice(0, LIMIT)),
        truncated: p.diff.length > LIMIT,
      };
    }
    this.store.db
      .prepare(
        "INSERT INTO native_work VALUES(?,?,?,?,?) ON CONFLICT(threadId,turnId,kind) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt",
      )
      .run(threadId, turnId, kind, JSON.stringify(value), Date.now());
  }
  snapshot(threadId: string, turnId?: string | null): NativeWork {
    const selected =
      turnId ||
      this.store.db
        .prepare("SELECT turnId FROM native_work WHERE threadId=? ORDER BY updatedAt DESC LIMIT 1")
        .get(threadId)?.turnId;
    const result: NativeWork = { turnId: selected ? String(selected) : null };
    if (selected)
      for (const row of this.store.db
        .prepare("SELECT kind,value FROM native_work WHERE threadId=? AND turnId=?")
        .all(threadId, String(selected))) {
        if (["plan", "usage", "diff"].includes(String(row.kind)))
          Object.assign(result, { [String(row.kind)]: JSON.parse(String(row.value)) });
      }
    // Context belongs to the thread and survives the next turn before its first usage event.
    if (!result.usage) {
      const row = this.store.db
        .prepare(
          "SELECT value FROM native_work WHERE threadId=? AND kind='usage' ORDER BY updatedAt DESC LIMIT 1",
        )
        .get(threadId);
      if (row) result.usage = JSON.parse(String(row.value));
    }
    return result;
  }
  private key(threadId: string, turnId: string, itemId: string) {
    return JSON.stringify([threadId, turnId, itemId]);
  }
  command(
    threadId: string,
    turnId: string,
    itemId: string,
    item: Record<string, unknown>,
    delta?: string,
  ) {
    if (!itemId || itemId.length > 200 || !turnId) return;
    const key = this.key(threadId, turnId, itemId);
    let log = this.logs.get(key);
    if (!log) {
      const saved = this.read(threadId, turnId, itemId, true);
      log = {
        itemId,
        command: "",
        status: "inProgress",
        exitCode: null,
        text: "",
        truncated: delta !== undefined,
        retainedChars: 0,
        ...saved,
        threadId,
        turnId,
        dirty: false,
      };
      this.logs.set(key, log);
    }
    if (typeof item.command === "string") log.command = item.command.slice(0, 4000);
    if (typeof item.status === "string") log.status = item.status.slice(0, 40);
    if (typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode))
      log.exitCode = item.exitCode;
    if (delta !== undefined) {
      const joined = log.text + delta.slice(-LIMIT);
      log.truncated ||= delta.length > LIMIT || joined.length > LIMIT;
      log.text = joined.slice(-LIMIT);
    } else if (typeof item.aggregatedOutput === "string") {
      // The final native item is authoritative, even when deltas were missed on reconnect.
      log.text = item.aggregatedOutput.slice(-LIMIT);
      log.truncated = item.aggregatedOutput.length > LIMIT;
    }
    log.retainedChars = log.text.length;
    log.dirty = true;
    if (log.status !== "inProgress") {
      this.flushOne(log);
      this.logs.delete(key);
      this.flush();
    } else if (!this.timer) this.timer = setTimeout(() => this.flush(), 500).unref();
    while (this.logs.size > 32) {
      const first = this.logs.keys().next().value!;
      this.flushOne(this.logs.get(first)!);
      this.logs.delete(first);
    }
  }
  read(threadId: string, turnId: string, itemId: string, full = false): NativeCommand | null {
    const live = this.logs.get(this.key(threadId, turnId, itemId));
    const row = live
      ? null
      : this.store.db
          .prepare("SELECT value FROM command_logs WHERE threadId=? AND turnId=? AND itemId=?")
          .get(threadId, turnId, itemId);
    const log = live ?? (row ? (JSON.parse(String(row.value)) as NativeCommand) : null);
    if (!log) return null;
    return {
      itemId: log.itemId,
      command: log.command,
      status: log.status,
      exitCode: log.exitCode,
      text: stripVTControlCharacters(full ? log.text : log.text.slice(-64000)),
      truncated: log.truncated || (!full && log.text.length > 64000),
      retainedChars: log.retainedChars,
    };
  }
  private flushOne(log: Log) {
    if (!log.dirty) return;
    const { threadId, turnId, dirty: _dirty, ...value } = log;
    const json = JSON.stringify(value);
    this.store.db
      .prepare(
        "INSERT INTO command_logs VALUES(?,?,?,?,?,?) ON CONFLICT(threadId,turnId,itemId) DO UPDATE SET value=excluded.value,bytes=excluded.bytes,updatedAt=excluded.updatedAt",
      )
      .run(threadId, turnId, log.itemId, json, Buffer.byteLength(json), Date.now());
    log.dirty = false;
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const log of this.logs.values()) this.flushOne(log);
    let bytes = Number(
      this.store.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM command_logs").get()?.n,
    );
    if (bytes > TOTAL)
      for (const row of this.store.db
        .prepare(
          "SELECT threadId,turnId,itemId,bytes FROM command_logs ORDER BY (json_extract(value,'$.status') = 'inProgress'),updatedAt",
        )
        .all()) {
        this.store.db
          .prepare("DELETE FROM command_logs WHERE threadId=? AND turnId=? AND itemId=?")
          .run(String(row.threadId), String(row.turnId), String(row.itemId));
        this.logs.delete(this.key(String(row.threadId), String(row.turnId), String(row.itemId)));
        bytes -= Number(row.bytes);
        if (bytes <= TOTAL) break;
      }
  }
  finish(threadId: string, turnId: string, status = "unknown") {
    for (const [key, log] of this.logs)
      if (log.threadId === threadId && log.turnId === turnId) {
        if (log.status === "inProgress") log.status = status;
        log.dirty = true;
        this.flushOne(log);
        this.logs.delete(key);
      }
    this.store.db
      .prepare(
        "UPDATE command_logs SET value=json_set(value,'$.status',?) WHERE threadId=? AND turnId=? AND json_extract(value,'$.status')='inProgress'",
      )
      .run(status, threadId, turnId);
    this.flush();
  }
  close() {
    this.flush();
    this.logs.clear();
  }
}
