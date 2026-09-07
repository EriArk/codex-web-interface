import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  get(id: string): { data: Buffer; mime: string; threadId: string } {
    const row = this.store.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
    if (!row) throw new HubError(404, "ARTIFACT_NOT_FOUND", "Файл не найден");
    return {
      data: readFileSync(join(this.root, `${id}.png`)),
      mime: String(row.mime),
      threadId: String(row.threadId),
    };
  }
}
