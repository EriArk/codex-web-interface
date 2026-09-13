import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_FILE_LIMIT } from "@codex-web/machines";
import { defaultStoragePolicy, HubError } from "@codex-web/shared";
import type { Store } from "./store.js";
export class Artifacts {
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly maxBytes = defaultStoragePolicy.artifactBytes,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  putPng(
    threadId: string,
    base64: string,
  ): { artifactId: string; url: string; width: number; height: number } {
    if (base64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
      throw new HubError(400, "INVALID_IMAGE", "Некорректный снимок");
    const data = Buffer.from(base64, "base64");
    if (
      data.length < 33 ||
      data.length > 8 * 1024 * 1024 ||
      !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new HubError(400, "INVALID_IMAGE", "Нужен PNG размером до 8 МБ");
    const width = data.readUInt32BE(16),
      height = data.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 32000000)
      throw new HubError(400, "INVALID_IMAGE", "Размер снимка не поддерживается");
    const used = Number(
      this.store.db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM artifacts").get()?.bytes,
    );
    if (used + data.length > this.maxBytes)
      throw new HubError(
        507,
        "ARTIFACT_STORAGE_FULL",
        "Хранилище результатов заполнено. Сохранённые файлы доступны.",
      );
    const id = randomUUID();
    writeFileSync(join(this.root, `${id}.png`), data, { flag: "wx", mode: 0o600 });
    this.store.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
      .run(id, threadId, "image/png", data.length, new Date().toISOString());
    return { artifactId: id, url: `/api/artifacts/${id}`, width, height };
  }
  putFile(
    threadId: string,
    turnId: string | null,
    name: string,
    sourcePath: string,
    mime: string,
    data: Buffer,
  ) {
    if (data.length > 32 * 1024 * 1024)
      throw new HubError(413, "ARTIFACT_TOO_LARGE", "Файл больше 32 МБ.");
    const used = Number(
      this.store.db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM artifacts").get()?.bytes,
    );
    if (used + data.length > this.maxBytes)
      throw new HubError(
        507,
        "ARTIFACT_STORAGE_FULL",
        "Хранилище результатов заполнено. Сохранённые файлы доступны.",
      );
    const id = randomUUID(),
      sha256 = createHash("sha256").update(data).digest("hex");
    writeFileSync(join(this.root, id + ".bin"), data, { flag: "wx", mode: 0o600 });
    this.store.db.exec("SAVEPOINT capture_artifact");
    try {
      this.store.db
        .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
        .run(id, threadId, mime, data.length, new Date().toISOString());
      this.store.db
        .prepare("INSERT INTO artifact_files VALUES(?,?,?,?,?)")
        .run(id, name, sha256, sourcePath, turnId);
      this.store.db.exec("RELEASE capture_artifact");
    } catch (error) {
      this.store.db.exec("ROLLBACK TO capture_artifact; RELEASE capture_artifact");
      throw error;
    }
    return { artifactId: id, url: `/api/artifacts/${id}`, bytes: data.length, sha256, mime };
  }
  async putStream(
    threadId: string,
    turnId: string | null,
    name: string,
    sourcePath: string,
    mime: string,
    transfer: (destination: string, limit: number) => Promise<{ bytes: number; sha256: string }>,
  ) {
    const id = randomUUID(),
      temporary = join(this.root, id + ".part"),
      final = join(this.root, id + ".bin");
    const used = () =>
      Number(
        this.store.db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM artifacts").get()?.bytes,
      );
    if (used() >= this.maxBytes)
      throw new HubError(507, "ARTIFACT_STORAGE_FULL", "Хранилище результатов заполнено.");
    try {
      const receipt = await transfer(
        temporary,
        Math.min(ARTIFACT_FILE_LIMIT, this.maxBytes - used()),
      );
      if (
        receipt.bytes > ARTIFACT_FILE_LIMIT ||
        statSync(temporary).size !== receipt.bytes ||
        !/^[a-f0-9]{64}$/.test(receipt.sha256)
      )
        throw new Error("INVALID_TRANSFER_RECEIPT");
      if (used() + receipt.bytes > this.maxBytes)
        throw new HubError(507, "ARTIFACT_STORAGE_FULL", "Хранилище результатов заполнено.");
      await rename(temporary, final);
      // Another image capture may have consumed quota while rename was pending.
      if (used() + receipt.bytes > this.maxBytes)
        throw new HubError(507, "ARTIFACT_STORAGE_FULL", "Хранилище результатов заполнено.");
      this.store.db.exec("SAVEPOINT streamed_artifact");
      try {
        this.store.db
          .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
          .run(id, threadId, mime, receipt.bytes, new Date().toISOString());
        this.store.db
          .prepare("INSERT INTO artifact_files VALUES(?,?,?,?,?)")
          .run(id, name, receipt.sha256, sourcePath, turnId);
        this.store.db.exec("RELEASE streamed_artifact");
      } catch (error) {
        this.store.db.exec("ROLLBACK TO streamed_artifact; RELEASE streamed_artifact");
        throw error;
      }
      return { artifactId: id, url: `/api/artifacts/${id}`, ...receipt, mime };
    } catch (error) {
      await rm(temporary, { force: true });
      await rm(final, { force: true });
      throw error;
    }
  }
  describe(id: string) {
    const row = this.store.db
      .prepare(
        "SELECT a.*,f.name FROM artifacts a LEFT JOIN artifact_files f ON f.id=a.id WHERE a.id=?",
      )
      .get(id);
    if (!row) throw new HubError(404, "ARTIFACT_NOT_FOUND", "Файл не найден.");
    return {
      threadId: String(row.threadId),
      name: row.name ? String(row.name) : "screenshot.png",
      mime: String(row.mime),
      bytes: Number(row.bytes),
      path: join(this.root, id + (row.name ? ".bin" : ".png")),
    };
  }
  stream(id: string, range?: { start: number; end: number }) {
    const item = this.describe(id);
    if (!statSync(item.path, { throwIfNoEntry: false })?.isFile())
      throw new HubError(404, "ARTIFACT_NOT_FOUND", "Файл не найден.");
    return createReadStream(item.path, range);
  }
  get(id: string): { data: Buffer; mime: string; threadId: string; name: string } {
    const row = this.store.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
    if (!row) throw new HubError(404, "ARTIFACT_NOT_FOUND", "Файл не найден");
    const file = this.store.db.prepare("SELECT name FROM artifact_files WHERE id=?").get(id);
    return {
      data: readFileSync(join(this.root, `${id}.${file ? "bin" : "png"}`)),
      name: file ? String(file.name) : "screenshot.png",
      mime: String(row.mime),
      threadId: String(row.threadId),
    };
  }
}
