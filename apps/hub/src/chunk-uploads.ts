import { createHash } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { open, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { gptFileLimit, type HubConfig, HubError, UPLOAD_CHUNK_BYTES } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Attachments } from "./attachments.js";
import type { GptService } from "./gpt.js";
import type { Store } from "./store.js";

const specification = z
  .object({
    kind: z.enum(["codex", "gpt", "project"]),
    threadId: z.string().uuid().optional(),
    projectId: z.string().min(1).max(100).optional(),
    checkout: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    target: z.string().min(1).max(2048).optional(),
    replace: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    name: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (v) =>
          !!v.trim() &&
          !/[\\/]/.test(v) &&
          [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
      ),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 ** 4),
  })
  .strict();
type Specification = z.infer<typeof specification>;
const fail = (code: string, message: string, status = 409): never => {
  throw new HubError(status, code, message);
};

/** Per-user, data-only disk staging. Offsets commit after fsync; retries never append twice. */
export class ChunkUploads {
  private busy = new Set<string>();
  private table: "upload_transfers" | "project_upload_transfers";
  constructor(
    private root: string,
    private store: Pick<Store, "db">,
    private quota: (kind: Specification["kind"]) => { limit: number; used: number },
    private authorize: (spec: Specification) => void,
    private finish: (
      id: string,
      spec: Specification,
      path: string,
      sha256: string,
    ) => Promise<unknown>,
    private projectOnly = false,
  ) {
    this.table = projectOnly ? "project_upload_transfers" : "upload_transfers";
    mkdirSync(root, { recursive: true, mode: 0o700 });
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table}(id TEXT PRIMARY KEY,spec TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,result TEXT,updatedAt INTEGER NOT NULL)`,
    );
  }
  private path(id: string) {
    z.string().uuid().parse(id);
    return join(this.root, id + ".part");
  }
  private row(id: string) {
    z.string().uuid().parse(id);
    const row = this.store.db.prepare(`SELECT * FROM ${this.table} WHERE id=?`).get(id);
    if (!row) return fail("UPLOAD_MISSING", "Загрузка не найдена.", 404);
    const spec = specification.parse(JSON.parse(String(row.spec)));
    this.authorize(spec);
    return {
      spec,
      offset: Number(row.offset),
      result: row.result == null ? null : JSON.parse(String(row.result)),
    };
  }
  state(id: string) {
    const row = this.row(id);
    return {
      offset: row.offset,
      bytes: row.spec.bytes,
      result: row.result,
      chunkBytes: UPLOAD_CHUNK_BYTES,
    };
  }
  async begin(id: string, value: unknown) {
    z.string().uuid().parse(id);
    const spec = specification.parse(value);
    if (
      (spec.kind === "project") !== this.projectOnly ||
      (this.projectOnly
        ? !spec.projectId || !spec.checkout || !spec.target || spec.threadId
        : !spec.bytes || spec.projectId || spec.checkout || spec.target || spec.replace)
    )
      fail("UPLOAD_TARGET", "Неверное назначение файла.", 400);
    this.authorize(spec);
    if ((spec.kind === "codex" && !spec.threadId) || (spec.kind === "gpt" && spec.threadId))
      fail("UPLOAD_TARGET", "Неверное назначение файла.", 400);
    if (this.busy.has(id)) fail("UPLOAD_BUSY", "Файл ещё обрабатывается.");
    const existing = this.store.db.prepare(`SELECT spec FROM ${this.table} WHERE id=?`).get(id);
    if (existing) {
      if (existing.spec !== JSON.stringify(spec))
        fail("UPLOAD_CHANGED", "Эта загрузка уже содержит другой файл.");
      return this.state(id);
    }
    const { limit } = this.quota(spec.kind),
      perFile = spec.kind === "gpt" ? gptFileLimit(spec.name) : limit;
    if (spec.bytes > perFile)
      fail(
        "FILE_TOO_LARGE",
        `Предел для этого файла — ${Math.floor(perFile / 1024 ** 2)} МБ.`,
        413,
      );
    // Expired partial files are owned by this private store; no source/attachment deletion.
    for (const old of this.store.db
      .prepare(`SELECT id FROM ${this.table} WHERE updatedAt<?`)
      .all(Date.now() - 86400000)) {
      const key = String(old.id);
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      try {
        await unlink(this.path(key)).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
        this.store.db
          .prepare(`DELETE FROM ${this.table} WHERE id=? AND updatedAt<?`)
          .run(key, Date.now() - 86400000);
      } finally {
        this.busy.delete(key);
      }
    }
    const disk = await statfs(this.root);
    this.authorize(spec);
    // Recheck after asynchronous filesystem work; admission itself is atomic.
    const again = this.store.db.prepare(`SELECT spec FROM ${this.table} WHERE id=?`).get(id);
    if (again) {
      if (again.spec !== JSON.stringify(spec))
        fail("UPLOAD_CHANGED", "Эта загрузка уже содержит другой файл.");
      return this.state(id);
    }
    const reserved = Number(
      this.store.db
        .prepare(
          `SELECT COALESCE(SUM(json_extract(spec,'$.bytes')),0) n FROM ${this.table} WHERE result IS NULL AND json_extract(spec,'$.kind')=?`,
        )
        .get(spec.kind)?.n,
    );
    const current = this.quota(spec.kind);
    if (current.used + reserved + spec.bytes > current.limit)
      fail("ATTACHMENT_STORAGE_FULL", "Хранилище вложений заполнено.", 507);
    const unwritten = Number(
      this.store.db
        .prepare(
          `SELECT COALESCE(SUM(json_extract(spec,'$.bytes')-offset),0) n FROM ${this.table} WHERE result IS NULL`,
        )
        .get()?.n,
    );
    if (disk.bavail * disk.bsize < unwritten + spec.bytes * 2 + 64 * 1024 ** 2)
      fail("UPLOAD_DISK_FULL", "На сервере недостаточно места для файла.", 507);
    if (
      this.projectOnly &&
      Number(
        this.store.db.prepare(`SELECT COUNT(*) n FROM ${this.table} WHERE result IS NULL`).get()?.n,
      ) >= 64
    )
      fail("UPLOAD_BUSY", "Сначала заверши или отмени предыдущие загрузки.");
    this.store.db
      .prepare(`INSERT INTO ${this.table}(id,spec,updatedAt) VALUES(?,?,?)`)
      .run(id, JSON.stringify(spec), Date.now());
    return this.state(id);
  }
  async append(id: string, offset: number, bytes: Buffer) {
    if (this.busy.has(id)) fail("UPLOAD_BUSY", "Файл ещё обрабатывается.");
    this.busy.add(id);
    try {
      const row = this.row(id);
      if (row.result) return this.state(id);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Buffer.isBuffer(bytes) ||
        !bytes.length ||
        bytes.length > UPLOAD_CHUNK_BYTES ||
        offset + bytes.length > row.spec.bytes
      )
        fail("UPLOAD_CHUNK", "Неверный фрагмент файла.", 400);
      const path = this.path(id);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(path, "r+");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || row.offset !== 0) throw e;
        handle = await open(path, "wx+", 0o600);
      }
      try {
        const size = (await handle.stat()).size;
        if (size < row.offset)
          fail("UPLOAD_CHANGED", "Временный файл повреждён. Начни загрузку заново.");
        if (size > row.offset) await handle.truncate(row.offset);
        if (offset < row.offset) {
          if (offset + bytes.length > row.offset)
            fail("UPLOAD_OFFSET", "Обнови состояние загрузки.");
          const saved = Buffer.alloc(bytes.length);
          const read = await handle.read(saved, 0, saved.length, offset);
          if (read.bytesRead !== saved.length || !saved.equals(bytes))
            fail("UPLOAD_CHANGED", "Повторный фрагмент отличается от сохранённого.");
          return this.state(id);
        }
        if (offset !== row.offset) fail("UPLOAD_OFFSET", "Обнови состояние загрузки.");
        let written = 0;
        while (written < bytes.length) {
          const n = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!n.bytesWritten) throw Error("UPLOAD_WRITE_FAILED");
          written += n.bytesWritten;
        }
        await handle.sync();
        this.authorize(row.spec);
        this.store.db
          .prepare(`UPDATE ${this.table} SET offset=?,updatedAt=? WHERE id=? AND offset=?`)
          .run(offset + bytes.length, Date.now(), id, offset);
      } finally {
        await handle.close();
      }
      return this.state(id);
    } finally {
      this.busy.delete(id);
    }
  }
  async complete(id: string) {
    if (this.busy.has(id)) fail("UPLOAD_BUSY", "Файл ещё обрабатывается.");
    this.busy.add(id);
    try {
      const row = this.row(id);
      if (row.result) return row.result;
      if (row.offset !== row.spec.bytes)
        fail("UPLOAD_INCOMPLETE", "Файл ещё не загрузился полностью.");
      const hash = createHash("sha256");
      let bytes = 0;
      if (!row.spec.bytes) await (await open(this.path(id), "a", 0o600)).close();
      for await (const chunk of createReadStream(this.path(id))) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      if (bytes !== row.spec.bytes) fail("UPLOAD_CHANGED", "Размер временного файла изменился.");
      this.authorize(row.spec);
      const sha256 = hash.digest("hex");
      const result = {
        file: await this.finish(id, row.spec, this.path(id), sha256),
        sha256,
      };
      this.authorize(row.spec);
      this.store.db
        .prepare(`UPDATE ${this.table} SET result=?,updatedAt=? WHERE id=?`)
        .run(JSON.stringify(result), Date.now(), id);
      await unlink(this.path(id)).catch(() => {});
      return result;
    } finally {
      this.busy.delete(id);
    }
  }
  async cancel(id: string) {
    if (!this.projectOnly) fail("UPLOAD_TARGET", "Неверное назначение файла.", 400);
    if (this.busy.has(id)) fail("UPLOAD_BUSY", "Файл ещё обрабатывается.");
    this.busy.add(id);
    try {
      const row = this.row(id);
      if (row.result) return this.state(id);
      this.store.db
        .prepare(`UPDATE ${this.table} SET result=?,updatedAt=? WHERE id=?`)
        .run(JSON.stringify({ cancelled: true }), Date.now(), id);
      await unlink(this.path(id)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      return this.state(id);
    } finally {
      this.busy.delete(id);
    }
  }
}

export function registerChunkUploads(
  app: FastifyInstance,
  config: HubConfig,
  store: Store,
  attachments: Attachments,
  gpt: GptService,
  authorize: () => void = () => {},
) {
  const uploads = new ChunkUploads(
    join(config.hub.resultsPath, "upload-transfers"),
    store,
    (kind) => ({
      limit:
        kind === "gpt" ? config.hub.storage.gptUploadBytes : config.hub.storage.attachmentBytes,
      used: Number(
        store.db
          .prepare(
            `SELECT COALESCE(SUM(bytes),0) n FROM ${kind === "gpt" ? "gpt_uploads" : "attachments"}`,
          )
          .get()?.n,
      ),
    }),
    (spec) => {
      authorize();
      if (spec.kind === "codex") store.thread(spec.threadId!);
    },
    (id, spec, path) =>
      spec.kind === "gpt"
        ? gpt.putFile(spec.name, path, id)
        : attachments.putFile(spec.threadId!, spec.name, path, id),
  );
  const id = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.post("/api/upload-transfers/:id", async (req) => uploads.begin(id(req.params), req.body));
  app.get("/api/upload-transfers/:id", async (req) => uploads.state(id(req.params)));
  app.put(
    "/api/upload-transfers/:id",
    {
      bodyLimit: UPLOAD_CHUNK_BYTES,
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: (req: { ip: string }) => `${req.ip}:upload-chunks`,
        },
      },
    },
    async (req) =>
      uploads.append(
        id(req.params),
        z.object({ offset: z.coerce.number().int().nonnegative() }).parse(req.query).offset,
        req.body as Buffer,
      ),
  );
  app.post("/api/upload-transfers/:id/complete", async (req) => uploads.complete(id(req.params)));
}
