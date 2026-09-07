import { createHash, randomUUID } from "node:crypto";
import { readMachineImage } from "@codex-web/machines";
import {
  type HubConfig,
  HubError,
  isNativeImageSource,
  type MachineConfig,
} from "@codex-web/shared";
import sharp from "sharp";
import { Artifacts } from "./artifacts.js";
import type { Store } from "./store.js";
export interface MessageImage {
  id: string;
  name: string;
  url: string;
}
export function displayUserText(text: string, paths: string[]): string {
  const match = text.match(
    /^# Files mentioned by the user:\s*\r?\n([\s\S]*?)\r?\n## My request for Codex:\s*\r?\n/,
  );
  if (!match) return text;
  const remaining = (match[1] ?? "")
    .split(/\r?\n/)
    .filter((line) => !paths.some((path) => line.endsWith(path)))
    .join("\n")
    .trim();
  return (
    (remaining ? "Прикреплённые файлы:\n" + remaining + "\n\n" : "") + text.slice(match[0].length)
  );
}
export class NativeImages {
  private pending = new Map<string, Promise<ReturnType<Artifacts["get"]>>>();
  private artifacts: Artifacts;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    config: HubConfig,
    private store: Store,
    private machine: (threadId: string) => MachineConfig,
  ) {
    this.artifacts = new Artifacts(
      config.hub.resultsPath,
      store,
      config.hub.storage?.artifactBytes,
    );
  }
  register(threadId: string, messageId: string, source: string): MessageImage | undefined {
    if (!isNativeImageSource(source)) return;
    const inline = source.startsWith("data:");
    const key = createHash("sha256").update(source).digest("hex");
    const old = this.store.db
      .prepare("SELECT id,name FROM native_images WHERE threadId=? AND messageId=? AND sourceKey=?")
      .get(threadId, messageId, key);
    if (old)
      return { id: String(old.id), name: String(old.name), url: `/api/native-images/${old.id}` };
    const id = randomUUID(),
      name = inline ? "Изображение" : source.split(/[\\/]/).at(-1)?.slice(0, 240) || "Изображение";
    this.store.db
      .prepare("INSERT INTO native_images VALUES(?,?,?,?,?,?,NULL)")
      .run(id, threadId, messageId, key, source, name);
    return { id, name, url: `/api/native-images/${id}` };
  }
  thread(id: string): string {
    const row = this.store.db.prepare("SELECT threadId FROM native_images WHERE id=?").get(id);
    if (!row) throw new HubError(404, "IMAGE_NOT_FOUND", "Изображение не найдено");
    return String(row.threadId);
  }
  async get(id: string) {
    const row = this.store.db.prepare("SELECT * FROM native_images WHERE id=?").get(id);
    if (!row) throw new HubError(404, "IMAGE_NOT_FOUND", "Изображение не найдено");
    if (row.artifactId) return this.artifacts.get(String(row.artifactId));
    const pending = this.pending.get(id);
    if (pending) return pending;
    if (this.pending.size >= 16)
      throw new HubError(429, "IMAGE_BUSY", "Подождите загрузки других изображений");
    const action = this.serial
      .catch(() => {})
      .then(async () => {
        const source = String(row.source);
        const bytes = source.startsWith("data:")
          ? Buffer.from(source.slice(source.indexOf(",") + 1), "base64")
          : await readMachineImage(this.machine(String(row.threadId)), source);
        if (bytes.length > 8 * 1024 * 1024)
          throw new HubError(413, "IMAGE_TOO_LARGE", "Изображение больше 8 МБ");
        let png: Buffer;
        try {
          png = await sharp(bytes, { limitInputPixels: 50_000_000, pages: 1 })
            .autoOrient()
            .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer();
        } catch {
          throw new HubError(415, "INVALID_IMAGE", "Не удалось прочитать изображение");
        }
        const artifact = this.artifacts.putPng(String(row.threadId), png.toString("base64"));
        this.store.db
          .prepare("UPDATE native_images SET artifactId=?,source='' WHERE id=?")
          .run(artifact.artifactId, id);
        return this.artifacts.get(artifact.artifactId);
      })
      .finally(() => this.pending.delete(id));
    this.serial = action.catch(() => {});
    this.pending.set(id, action);
    return action;
  }
}
