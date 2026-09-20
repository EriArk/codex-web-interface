import { randomUUID } from "node:crypto";
import { HubError } from "@codex-web/shared";
import type { NativeGptWorkspace } from "./gpt-native-provider.js";
import type { Library } from "./library.js";
import type { Store } from "./store.js";

/** A local tombstone is immediate; native deletion uses its own durable receipt. */
export class GptDeletions {
  private busy = false;
  constructor(
    private store: Store,
    private library: Library,
    private workspace: NativeGptWorkspace,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS gpt_deletions(
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL,
      attempted INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0)`);
    this.adoptLegacyDeletes();
  }
  private adoptLegacyDeletes() {
    const db = this.store.db;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='gpt_native_library'").get()) return;
    // The old synchronous route could lose its acknowledgement and leave every
    // chat blocked. Carry its exact receipt into the background queue, read-only
    // on the first attempt. Never manufacture a second native delete.
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db
        .prepare(
          "SELECT key,id FROM gpt_native_library WHERE state='unknown' AND kind='thread' AND json_extract(input,'$.action')='delete' AND json_extract(input,'$.confirm')=1 AND NOT EXISTS(SELECT 1 FROM gpt_deletions d WHERE d.id=gpt_native_library.id)",
        )
        .all();
      for (const row of rows) {
        const id = String(row.id),
          key = String(row.key);
        db.prepare("INSERT INTO gpt_deletions(id,key,receipt,attempted) VALUES(?,?,?,1)").run(
          id,
          key,
          key,
        );
        this.library.save("thread", id, { deleted: true, archived: false, changedAt: Date.now() });
        db.prepare(
          "UPDATE gpt_jobs SET status='cancelled',updatedAt=? WHERE nativeId=? AND status='queued'",
        ).run(Date.now(), id);
        db.prepare("UPDATE gpt_native_library SET state='deferred' WHERE key=?").run(key);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  enqueue(key: string, id: string) {
    const db = this.store.db;
    const previous = db.prepare("SELECT id FROM gpt_deletions WHERE key=?").get(key);
    if (previous && previous.id !== id)
      throw new HubError(409, "IDEMPOTENCY_CONFLICT", "Ключ уже использован.");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO gpt_deletions(id,key,receipt) VALUES(?,?,?)").run(
        id,
        key,
        randomUUID(),
      );
      this.library.save("thread", id, { deleted: true, archived: false, changedAt: Date.now() });
      // Unsent queued prompts must not execute after the user removed their chat.
      db.prepare(
        "UPDATE gpt_jobs SET status='cancelled',updatedAt=? WHERE nativeId=? AND status='queued'",
      ).run(Date.now(), id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, pending: true };
  }
  async tick(authorize: () => void, idle: () => boolean) {
    if (this.busy || !idle()) return;
    const db = this.store.db;
    const row = db
      .prepare("SELECT * FROM gpt_deletions WHERE done=0 AND nextAt<=? ORDER BY nextAt LIMIT 1")
      .get(Date.now());
    if (!row) return;
    this.busy = true;
    try {
      authorize();
      if (!idle()) return;
      db.prepare("UPDATE gpt_deletions SET attempted=1,nextAt=? WHERE id=?").run(
        Date.now() + 30000,
        String(row.id),
      );
      const result = await this.workspace.client.libraryMutation(
        {
          key: String(row.receipt),
          kind: "thread",
          id: String(row.id),
          action: "delete",
          confirm: true,
        },
        !!row.attempted,
      );
      authorize();
      if (result.state === "completed")
        db.prepare("UPDATE gpt_deletions SET done=1 WHERE id=?").run(String(row.id));
      else if (result.state === "rejected")
        db.prepare("UPDATE gpt_deletions SET receipt=?,attempted=0 WHERE id=?").run(
          randomUUID(),
          String(row.id),
        );
    } catch (error) {
      // Only a proven absent receipt permits first dispatch. Unknown effects are read back.
      if (
        error instanceof Error &&
        [
          "NATIVE_RECEIPT_MISSING",
          "NATIVE_PENDING_DISPATCH",
          "NATIVE_BUSY",
          "NATIVE_MANUAL_RECOVERY",
          "NATIVE_LIBRARY_NOT_WRITABLE",
        ].includes(error.message) &&
        (!row.attempted || error.message === "NATIVE_RECEIPT_MISSING")
      )
        db.prepare("UPDATE gpt_deletions SET attempted=0 WHERE id=?").run(String(row.id));
    } finally {
      db.prepare("UPDATE gpt_deletions SET attempts=attempts+1,nextAt=? WHERE id=?").run(
        Date.now() + Math.min(300000, 15000 * (Number(row.attempts) + 1)),
        String(row.id),
      );
      this.busy = false;
    }
  }
}
