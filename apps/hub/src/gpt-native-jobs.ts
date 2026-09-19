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
  ) {
    store.db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS gpt_native_receipts(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id),payload TEXT NOT NULL,messages TEXT NOT NULL DEFAULT '[]')",
    );
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
        ...(this.project(id) ? { projectId: this.project(id) } : {}),
      };
      if (!/^\d+$/.test(String(row.effort))) fail("INVALID_SETTINGS");
      this.store.db.prepare("INSERT OR IGNORE INTO gpt_native_preparations VALUES(?)").run(id);
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
      try {
        prepared = await this.client.prepareDispatch(input);
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
        ...(attachments.length ? { attachments } : {}),
      };
      // Atomic receipt + existing queue transition. A crash from this point means readback only.
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
