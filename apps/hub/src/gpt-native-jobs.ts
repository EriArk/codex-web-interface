import { randomUUID } from "node:crypto";
import type { NativeGptReadClient } from "./gpt-native.js";
import type { Store } from "./store.js";

type NativeJobsClient = Pick<
  NativeGptReadClient,
  "prepareDispatch" | "dispatchText" | "reconcileDispatch"
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
    private readonly allowed: Set<string>,
    private readonly creationKeys: Set<string> = new Set(),
  ) {
    store.db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS gpt_native_receipts(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id),payload TEXT NOT NULL,messages TEXT NOT NULL DEFAULT '[]')",
    );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_native_creations(jobId TEXT PRIMARY KEY REFERENCES gpt_native_receipts(jobId),conversationId TEXT NOT NULL)",
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
      if (
        row.nativeId == null ? !this.creationKeys.has(id) : !this.allowed.has(String(row.nativeId))
      )
        fail("INVALID_CANARY");
      if (row.files !== "[]") fail("ATTACHMENTS_NOT_SUPPORTED");
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM gpt_jobs WHERE id!=? AND status IN ('preparing','running','unknown') LIMIT 1",
          )
          .get(id)
      )
        fail("PENDING_DISPATCH");
      const input = {
        key: id,
        conversationId: row.nativeId == null ? null : String(row.nativeId),
        userMessageId: randomUUID(),
        text: String(row.text),
        versionId: String(row.model),
        presetId: Number(row.effort),
      };
      if (!/^\d+$/.test(String(row.effort))) fail("INVALID_SETTINGS");
      if (
        this.store.db
          .prepare(
            "UPDATE gpt_jobs SET status='preparing',updatedAt=? WHERE id=? AND status='queued'",
          )
          .run(Date.now(), id).changes !== 1
      )
        fail("JOB_CHANGED");
      let prepared: Awaited<ReturnType<NativeJobsClient["prepareDispatch"]>>;
      try {
        prepared = await this.client.prepareDispatch(input);
        this.authorize();
        if (prepared.versionId !== input.versionId || prepared.presetId !== input.presetId)
          fail("INVALID_SETTINGS");
      } catch (error) {
        this.store.db
          .prepare(
            "UPDATE gpt_jobs SET status='failed',error='NATIVE_PREPARATION_FAILED',updatedAt=? WHERE id=? AND status='preparing'",
          )
          .run(Date.now(), id);
        throw error;
      }
      const payload = {
        ...input,
        parentId: prepared.parentId,
        model: prepared.model,
        effort: prepared.effort,
        intentPersisted: true as const,
      };
      // Atomic receipt + existing queue transition. A crash from this point means readback only.
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        if (
          this.store.db
            .prepare(
              "UPDATE gpt_jobs SET status='running',requestId=?,submitted=1,updatedAt=? WHERE id=? AND status='preparing'",
            )
            .run(input.userMessageId, Date.now(), id).changes !== 1
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
      row.files !== "[]"
    )
      fail("SUBMISSION_MISMATCH");
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
      this.store.db
        .prepare(
          "UPDATE gpt_jobs SET status='unknown',error='NATIVE_RECONCILE_REQUIRED',updatedAt=? WHERE id=? AND status!='completed'",
        )
        .run(Date.now(), id);
      throw error;
    }
    // A temporary missing page must not erase already observed public output.
    if (result.state !== "unknown") {
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
        this.store.db
          .prepare(
            "UPDATE gpt_jobs SET status=?,answer=?,error='',updatedAt=? WHERE id=? AND status!='completed'",
          )
          .run(result.state, result.messages.map((m) => m.text).join("\n\n"), Date.now(), id);
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
    } else
      this.store.db
        .prepare(
          "UPDATE gpt_jobs SET status='unknown',error='NATIVE_RECONCILE_REQUIRED',updatedAt=? WHERE id=? AND status!='completed'",
        )
        .run(Date.now(), id);
    return { status: String(this.row(id).status), userMessageId: payload.userMessageId as string };
  }
}
