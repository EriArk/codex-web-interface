import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { GptFile } from "@codex-web/shared";
import { gptFileLimit } from "@codex-web/shared";
import { z } from "zod";
import type { NativeGptReadClient, NativeUploadedFile } from "./gpt-native.js";
import type { Store } from "./store.js";

type NativeJobsClient = Pick<
  NativeGptReadClient,
  | "prepareDispatch"
  | "dispatchText"
  | "reconcileDispatch"
  | "stopDispatch"
  | "reviewDispatch"
  | "uploadFile"
  | "uploadFilePath"
>;
function fail(code: string): never {
  throw Error(`NATIVE_${code}`);
}
/** Opt-in isolated canary worker over the existing gpt_jobs table. No second queue,
 * automatic retries, production provider switch, or browser-facing admission. */
export class NativeGptJobs {
  private busy = false;
  constructor(
    private readonly store: Pick<Store, "db">,
    private readonly client: NativeJobsClient,
    private readonly authorize: () => void,
    private readonly allowed: { has(id: string): boolean },
    private readonly creationKeys: { has(id: string): boolean } = new Set(),
    private readonly readUpload?: (file: GptFile) => Promise<Buffer | string>,
    private readonly authorizeJob: (id: string) => void = () => {},
  ) {
    store.db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS gpt_native_receipts(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id),payload TEXT NOT NULL,messages TEXT NOT NULL DEFAULT '[]')",
    );
    if (
      !store.db
        .prepare("PRAGMA table_info(gpt_native_receipts)")
        .all()
        .some((r) => r.name === "uncertainSince")
    )
      store.db.exec("ALTER TABLE gpt_native_receipts ADD COLUMN uncertainSince INTEGER");
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_native_creations(jobId TEXT PRIMARY KEY REFERENCES gpt_native_receipts(jobId),conversationId TEXT NOT NULL)",
    );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_native_files(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id),files TEXT NOT NULL,hashes TEXT NOT NULL)",
    );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_native_preparations(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id))",
    );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_native_read_health(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id), failures INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0)",
    );
    for (const column of ["retryAt", "attempts"])
      if (
        !store.db
          .prepare("PRAGMA table_info(gpt_native_preparations)")
          .all()
          .some((r) => r.name === column)
      )
        store.db.exec(
          `ALTER TABLE gpt_native_preparations ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
        );
    store.db.exec(
      "UPDATE gpt_jobs SET status='failed',error='NATIVE_PREPARATION_INTERRUPTED' WHERE status='preparing' AND id IN (SELECT jobId FROM gpt_native_preparations) AND id NOT IN (SELECT jobId FROM gpt_native_receipts)",
    );
    store.db
      .prepare(
        "UPDATE gpt_jobs SET status='unknown',error='NATIVE_RECONCILE_REQUIRED' WHERE status IN ('preparing','running') AND id IN (SELECT jobId FROM gpt_native_receipts)",
      )
      .run();
  }
  private row(id: string) {
    this.authorize();
    const row = this.store.db.prepare("SELECT * FROM gpt_jobs WHERE id=?").get(id);
    if (!row || !(this.allowed.has(String(row.nativeId)) || this.creationKeys.has(id)))
      fail("INVALID_CANARY");
    return row;
  }
  canPoll(id: string) {
    const r = this.store.db
      .prepare("SELECT paused,nextAt FROM gpt_native_read_health WHERE jobId=?")
      .get(id);
    return !r || (!r.paused && Number(r.nextAt) <= Date.now());
  }
  private readFailed(id: string, code: string) {
    if (
      [
        "NATIVE_BUSY",
        "NATIVE_MANUAL_RECOVERY",
        "NATIVE_RATE_LIMITED",
        "NATIVE_QUEUE_FULL",
      ].includes(code)
    )
      return;
    const db = this.store.db;
    db.prepare(
      "INSERT INTO gpt_native_read_health(jobId,failures,nextAt) VALUES(?,1,?) ON CONFLICT(jobId) DO UPDATE SET failures=failures+1,nextAt=excluded.nextAt",
    ).run(id, Date.now() + 30000);
    db.prepare("UPDATE gpt_native_read_health SET paused=1 WHERE jobId=? AND failures>=3").run(id);
    if (db.prepare("SELECT 1 FROM gpt_native_read_health WHERE jobId=? AND paused=1").get(id)) {
      db.prepare(
        "UPDATE gpt_jobs SET status='unknown',error='NATIVE_CHAT_PAUSED',updatedAt=? WHERE id=? AND status IN ('running','unknown')",
      ).run(Date.now(), id);
      // Following accepted drafts in this same chat must not remain poised to send.
      db.prepare(
        "UPDATE gpt_jobs SET status='failed',error='NATIVE_CHAT_PAUSED_UNSENT',updatedAt=? WHERE status='queued' AND nativeId IS NOT NULL AND nativeId = (SELECT nativeId FROM gpt_jobs WHERE id=?)",
      ).run(Date.now(), id);
    }
  }
  private project(id: string): string | undefined {
    // The normal Store owns this association. Minimal isolated test Stores can omit it.
    if (
      !this.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gpt_project_jobs'")
        .get()
    )
      return undefined;
    const value = this.store.db
      .prepare("SELECT projectId FROM gpt_project_jobs WHERE jobId=?")
      .get(id)?.projectId;
    return value == null
      ? undefined
      : z
          .string()
          .regex(/^g-p-[a-zA-Z0-9-]{1,80}$/)
          .parse(value);
  }
  async run(id: string) {
    if (this.busy) fail("BUSY");
    this.busy = true;
    try {
      const row = this.row(id);
      const receipt = this.store.db
        .prepare("SELECT payload FROM gpt_native_receipts WHERE jobId=?")
        .get(id);
      if (receipt) return await this.readReceipt(id);
      if (row.status !== "queued") fail("JOB_NOT_QUEUED");
      this.authorizeJob(id);
      if (
        row.nativeId == null ? !this.creationKeys.has(id) : !this.allowed.has(String(row.nativeId))
      )
        fail("INVALID_CANARY");
      const files = z
        .array(
          z
            .object({
              id: z.string().uuid(),
              name: z.string().min(1).max(255),
              mime: z.string().regex(/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i),
              bytes: z
                .number()
                .int()
                .min(1)
                .max(512 * 1024 * 1024),
              url: z.string(),
              image: z.boolean(),
            })
            .strict(),
        )
        .max(8)
        .safeParse(JSON.parse(String(row.files)));
      if (!files.success) fail("INVALID_ATTACHMENTS");
      const selectedFiles = files.data;
      if (
        selectedFiles.length &&
        (!this.readUpload || new Set(selectedFiles.map((f) => f.id)).size !== selectedFiles.length)
      )
        fail("INVALID_UPLOAD");
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM gpt_jobs WHERE id!=? AND (status='preparing' OR status IN ('running','unknown') AND nativeId IS ? AND nativeId IS NOT NULL) LIMIT 1",
          )
          .get(id, row.nativeId == null ? null : String(row.nativeId))
      )
        fail("PENDING_DISPATCH");
      const input = {
        key: id,
        conversationId: row.nativeId == null ? null : String(row.nativeId),
        userMessageId: randomUUID(),
        text: String(row.text),
        versionId: String(row.model),
        presetId: Number(row.effort),
        ...(this.project(id) ? { projectId: this.project(id) } : {}),
      };
      if (!/^\d+$/.test(String(row.effort))) fail("INVALID_SETTINGS");
      this.store.db
        .prepare("INSERT OR IGNORE INTO gpt_native_preparations(jobId) VALUES(?)")
        .run(id);
      if (
        this.store.db
          .prepare(
            "UPDATE gpt_jobs SET status='preparing',updatedAt=? WHERE id=? AND status='queued'",
          )
          .run(Date.now(), id).changes !== 1
      )
        fail("JOB_CHANGED");
      let prepared: Awaited<ReturnType<NativeJobsClient["prepareDispatch"]>>;
      const attachments: NativeUploadedFile[] = [];
      let preparing = true;
      try {
        prepared = await this.client.prepareDispatch(input);
        preparing = false;
        this.authorize();
        if (this.row(id).status !== "preparing") fail("JOB_CHANGED");
        if (prepared.versionId !== input.versionId || prepared.presetId !== input.presetId)
          fail("INVALID_SETTINGS");
        const snapshots = [];
        for (const file of selectedFiles) {
          this.authorize();
          if (!this.readUpload || file.bytes > gptFileLimit(file.name)) fail("INVALID_UPLOAD");
          const source = await this.readUpload(file);
          this.authorize();
          const hash = createHash("sha256");
          let count = 0;
          if (typeof source === "string") {
            for await (const part of createReadStream(source)) {
              count += part.length;
              if (count > file.bytes) fail("UPLOAD_CHANGED");
              hash.update(part);
            }
          } else {
            count = source.length;
            hash.update(source);
          }
          if (count !== file.bytes) fail("UPLOAD_CHANGED");
          snapshots.push({ ...file, sha256: hash.digest("hex"), source });
        }
        const hashes = JSON.stringify(snapshots.map((f) => ({ id: f.id, sha256: f.sha256 })));
        this.store.db
          .prepare("INSERT OR IGNORE INTO gpt_native_files VALUES(?,?,?)")
          .run(id, String(row.files), hashes);
        const saved = this.store.db
          .prepare("SELECT files,hashes FROM gpt_native_files WHERE jobId=?")
          .get(id);
        if (saved?.files !== row.files || saved?.hashes !== hashes) fail("UPLOAD_CHANGED");
        for (const f of snapshots) {
          if (this.row(id).status !== "preparing") fail("JOB_CHANGED");
          const file = { id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, sha256: f.sha256 };
          const target = { key: id, conversationId: input.conversationId, file };
          if (typeof f.source === "string" && !f.mime.startsWith("image/"))
            attachments.push(await this.client.uploadFilePath(target, f.source));
          else {
            const bytes = typeof f.source === "string" ? await readFile(f.source) : f.source;
            attachments.push(
              await this.client.uploadFile({
                ...target,
                file: { ...file, base64: bytes.toString("base64") },
              }),
            );
          }
          this.authorize();
        }
      } catch (error) {
        const attempts = Number(
          this.store.db
            .prepare("SELECT attempts FROM gpt_native_preparations WHERE jobId=?")
            .get(id)?.attempts ?? 0,
        );
        const retry =
          preparing &&
          attempts < 1 &&
          error instanceof Error &&
          /^(NATIVE_RATE_LIMITED|NATIVE_READ_UNAVAILABLE|NATIVE_TIMEOUT|NATIVE_HISTORY_HEADERS_TIMEOUT|NATIVE_HISTORY_BODY_TIMEOUT|NATIVE_BUSY|NATIVE_MANUAL_RECOVERY|NATIVE_DISCONNECTED|NATIVE_UNAVAILABLE|NATIVE_WINDOW_CHANGED|NATIVE_WINDOW_AMBIGUOUS)$/.test(
            error.message,
          );
        // Only failed read-only preparation may return to the accepted outbox.
        // No upload or dispatch has begun. Their uncertain effects never replay.
        if (retry)
          this.store.db
            .prepare(
              "UPDATE gpt_native_preparations SET attempts=attempts+1,retryAt=? WHERE jobId=?",
            )
            .run(
              Date.now() +
                (error.message === "NATIVE_RATE_LIMITED" ? 60000 : 10000) * 2 ** attempts,
              id,
            );
        this.store.db
          .prepare(
            "UPDATE gpt_jobs SET status=?,error=?,updatedAt=? WHERE id=? AND status='preparing'",
          )
          .run(
            retry ? "queued" : "failed",
            retry ? "" : "NATIVE_PREPARATION_FAILED",
            Date.now(),
            id,
          );
        throw error;
      }
      const payload = {
        ...input,
        parentId: prepared.parentId,
        model: prepared.model,
        effort: prepared.effort,
        intentPersisted: true as const,
        ...(attachments.length ? { attachments } : {}),
      };
      // Atomic receipt + existing queue transition. A crash from this point means readback only.
      this.authorize();
      this.authorizeJob(id);
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        if (this.project(id) !== input.projectId) fail("PROJECT_CHANGED");
        if (
          this.store.db
            .prepare(
              "UPDATE gpt_jobs SET status='running',requestId=?,submitted=1,updatedAt=? WHERE id=? AND status='preparing' AND nativeId IS ? AND text=? AND files=? AND model=? AND effort=?",
            )
            .run(
              input.userMessageId,
              Date.now(),
              id,
              row.nativeId == null ? null : String(row.nativeId),
              String(row.text),
              String(row.files),
              String(row.model),
              String(row.effort),
            ).changes !== 1
        )
          fail("JOB_CHANGED");
        this.store.db
          .prepare("INSERT INTO gpt_native_receipts(jobId,payload) VALUES(?,?)")
          .run(id, JSON.stringify(payload));
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
      try {
        await this.client.dispatchText(payload);
      } catch {}
      return await this.readReceipt(id);
    } finally {
      this.busy = false;
    }
  }
  async reconcile(id: string) {
    if (this.busy) fail("BUSY");
    this.busy = true;
    try {
      return await this.readReceipt(id);
    } finally {
      this.busy = false;
    }
  }
  async review(id: string) {
    if (this.busy) fail("BUSY");
    this.busy = true;
    try {
      this.row(id);
      const saved = this.store.db
        .prepare("SELECT payload FROM gpt_native_receipts WHERE jobId=?")
        .get(id);
      if (!saved) fail("RECEIPT_MISSING");
      const payload = JSON.parse(String(saved.payload));
      const result = await this.client.reviewDispatch(id, payload.conversationId);
      this.authorize();
      if (result.reviewed)
        this.store.db
          .prepare(
            "UPDATE gpt_jobs SET status='cancelled',error='',updatedAt=? WHERE id=? AND status='unknown'",
          )
          .run(Date.now(), id);
      else await this.readReceipt(id);
    } finally {
      this.busy = false;
    }
  }
  async stop(id: string) {
    this.row(id);
    const saved = this.store.db
      .prepare("SELECT payload FROM gpt_native_receipts WHERE jobId=?")
      .get(id);
    if (!saved) fail("RECEIPT_MISSING");
    const payload = JSON.parse(String(saved.payload));
    await this.client.stopDispatch(id, payload.conversationId);
    if (!this.busy) return this.reconcile(id);
  }
  private async readReceipt(id: string) {
    const row = this.row(id);
    const saved = this.store.db
      .prepare("SELECT payload,messages FROM gpt_native_receipts WHERE jobId=?")
      .get(id);
    if (!saved) fail("RECEIPT_MISSING");
    const payload = JSON.parse(String(saved.payload));
    const created = this.store.db
      .prepare("SELECT conversationId FROM gpt_native_creations WHERE jobId=?")
      .get(id);
    if (
      row.requestId !== payload.userMessageId ||
      row.nativeId !== (payload.conversationId ?? created?.conversationId ?? null) ||
      row.text !== payload.text ||
      row.model !== payload.versionId ||
      Number(row.effort) !== payload.presetId ||
      this.project(id) !== payload.projectId ||
      (payload.attachments?.length
        ? this.store.db.prepare("SELECT files FROM gpt_native_files WHERE jobId=?").get(id)
            ?.files !== row.files
        : row.files !== "[]")
    )
      fail("SUBMISSION_MISMATCH");
    const markUncertain = () =>
      this.store.db
        .prepare(
          "UPDATE gpt_native_receipts SET uncertainSince=COALESCE(uncertainSince,?) WHERE jobId=?",
        )
        .run(Date.now(), id);
    let result: Awaited<ReturnType<NativeJobsClient["reconcileDispatch"]>>;
    try {
      result = await this.client.reconcileDispatch(id, payload.conversationId);
      this.authorize();
      if (result.userMessageId !== payload.userMessageId) fail("SUBMISSION_MISMATCH");
      if (
        payload.conversationId === null &&
        result.state !== "unknown" &&
        (!result.conversationId || (created && created.conversationId !== result.conversationId))
      )
        fail("SUBMISSION_MISMATCH");
    } catch (error) {
      this.readFailed(id, error instanceof Error ? error.message : "NATIVE_READ_UNAVAILABLE");
      // Delivery was already proved. A temporary history outage does not undo
      // that proof or turn an ongoing long task into an uncertain submission.
      if (
        row.status === "running" &&
        error instanceof Error &&
        /^(NATIVE_RATE_LIMITED|NATIVE_READ_UNAVAILABLE|NATIVE_TIMEOUT|NATIVE_HISTORY_HEADERS_TIMEOUT|NATIVE_HISTORY_BODY_TIMEOUT|NATIVE_BUSY|NATIVE_QUEUE_FULL|NATIVE_MANUAL_RECOVERY|NATIVE_DISCONNECTED|NATIVE_UNAVAILABLE|NATIVE_WINDOW_CHANGED|NATIVE_WINDOW_AMBIGUOUS)$/.test(
          error.message,
        )
      ) {
        this.store.db.prepare("UPDATE gpt_jobs SET updatedAt=? WHERE id=?").run(Date.now(), id);
        throw error;
      }
      markUncertain();
      this.store.db
        .prepare(
          "UPDATE gpt_jobs SET status='unknown',error=CASE WHEN error='NATIVE_CHAT_PAUSED' THEN error ELSE 'NATIVE_RECONCILE_REQUIRED' END,updatedAt=? WHERE id=? AND status!='completed'",
        )
        .run(Date.now(), id);
      throw error;
    }
    // A temporary missing page must not erase already observed public output.
    if (result.state !== "unknown") {
      this.store.db.prepare("DELETE FROM gpt_native_read_health WHERE jobId=?").run(id);
      this.store.db
        .prepare("UPDATE gpt_native_receipts SET uncertainSince=NULL WHERE jobId=?")
        .run(id);
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        if (payload.conversationId === null) {
          if (!result.conversationId) fail("SUBMISSION_MISMATCH");
          this.store.db
            .prepare("INSERT OR IGNORE INTO gpt_native_creations VALUES(?,?)")
            .run(id, result.conversationId);
          this.store.db
            .prepare("UPDATE gpt_jobs SET nativeId=? WHERE id=?")
            .run(result.conversationId, id);
        }
        this.store.db
          .prepare("UPDATE gpt_native_receipts SET messages=? WHERE jobId=?")
          .run(JSON.stringify(result.messages), id);
        if (
          this.store.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gpt_job_progress'")
            .get()
        ) {
          const progress = result.messages
            .filter((m) => m.channel === "commentary" && m.text.trim())
            .slice(-6)
            .map((m) => ({
              id: m.id,
              text: m.text.slice(0, 500),
              state: result.state === "running" && !m.complete ? "active" : "completed",
            }));
          this.store.db
            .prepare(
              "INSERT INTO gpt_job_progress VALUES(?,?) ON CONFLICT(jobId) DO UPDATE SET value=excluded.value",
            )
            .run(id, JSON.stringify(progress));
        }
        this.store.db
          .prepare(
            "UPDATE gpt_jobs SET status=?,answer=?,error='',updatedAt=? WHERE id=? AND status!='completed'",
          )
          .run(
            result.state,
            result.messages
              .filter((m) => m.channel !== "commentary")
              .map((m) => m.text)
              .join("\n\n"),
            Date.now(),
            id,
          );
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
    } else {
      markUncertain();
      this.store.db
        .prepare(
          "UPDATE gpt_jobs SET status='unknown',error=CASE WHEN error='NATIVE_CHAT_PAUSED' THEN error ELSE 'NATIVE_RECONCILE_REQUIRED' END,updatedAt=? WHERE id=? AND status!='completed'",
        )
        .run(Date.now(), id);
      this.readFailed(id, "NATIVE_UNCONFIRMED");
    }
    return { status: String(this.row(id).status), userMessageId: payload.userMessageId as string };
  }
}
