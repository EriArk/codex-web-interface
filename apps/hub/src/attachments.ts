import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stageAttachment } from "@codex-web/machines";
import {
  type Attachment,
  defaultStoragePolicy,
  type HubConfig,
  HubError,
  NotSubmittedError,
} from "@codex-web/shared";
import sharp from "sharp";
import type { Store } from "./store.js";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 20 });
export class Attachments {
  private processing = false;
  private protectedIds = new Set<string>();
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly maxBytes = defaultStoragePolicy.attachmentBytes,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private path(id: string, preview = false): string {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new HubError(404, "ATTACHMENT_NOT_FOUND", "Вложение не найдено");
    return join(this.root, id + (preview ? ".jpg" : ".bin"));
  }
  get(id: string): Attachment {
    const row = this.store.db.prepare("SELECT * FROM attachments WHERE id=?").get(id);
    if (!row) throw new HubError(404, "ATTACHMENT_NOT_FOUND", "Вложение не найдено");
    return this.store.attachmentPublic(row);
  }
  pending(threadId: string): Attachment[] {
    return this.store.db
      .prepare(
        "SELECT * FROM attachments WHERE threadId=? AND messageId IS NULL ORDER BY createdAt LIMIT 8",
      )
      .all(threadId)
      .map((row) => this.store.attachmentPublic(row));
  }
  stream(id: string, preview = false) {
    const file = this.get(id);
    if (preview && !file.image) throw new HubError(404, "NO_PREVIEW", "Предпросмотр недоступен");
    return { file, stream: createReadStream(this.path(id, preview)) };
  }
  async put(threadId: string, name: string, bytes: Buffer): Promise<Attachment> {
    if (this.processing)
      throw new HubError(409, "UPLOAD_BUSY", "Другой файл ещё загружается. Попробуй снова");
    this.processing = true;
    try {
      this.store.thread(threadId);
      if (
        !name.trim() ||
        name.length > 240 ||
        /[\\/]/u.test(name) ||
        Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw new HubError(400, "INVALID_FILENAME", "Неподходящее имя файла");
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES)
        throw new HubError(413, "FILE_TOO_LARGE", "Размер файла должен быть от 1 байта до 25 МБ");
      await this.cleanup();
      const pending = this.pending(threadId);
      if (
        pending.length >= MAX_ATTACHMENTS ||
        pending.reduce((n, f) => n + f.bytes, bytes.length) > MAX_BATCH_BYTES
      )
        throw new HubError(413, "ATTACHMENT_LIMIT", "До 8 файлов и 64 МБ на сообщение");
      if (
        Number(
          this.store.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM attachments").get()
            ?.total,
        ) +
          bytes.length >
        this.maxBytes
      )
        throw new HubError(507, "ATTACHMENT_STORAGE_FULL", "Хранилище вложений заполнено");
      const id = randomUUID();
      const raster = /\.(png|jpe?g|webp|gif|avif|tiff?|heic|heif)$/i.test(name);
      let preview: Buffer | undefined;
      if (raster) {
        try {
          preview = await sharp(bytes, {
            limitInputPixels: 50_000_000,
            failOn: "warning",
            pages: 1,
          })
            .autoOrient()
            .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 90 })
            .toBuffer();
        } catch {
          throw new HubError(
            400,
            "IMAGE_UNSUPPORTED",
            "Не удалось прочитать изображение. Попробуй JPEG, PNG или WebP (до 50 мегапикселей).",
          );
        }
      }
      try {
        await writeFile(this.path(id), bytes, { mode: 0o600, flag: "wx" });
        if (preview) await writeFile(this.path(id, true), preview, { mode: 0o600, flag: "wx" });
        this.store.db
          .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,NULL,?)")
          .run(
            id,
            threadId,
            name.normalize("NFC"),
            "application/octet-stream",
            bytes.length,
            preview ? 1 : 0,
            new Date().toISOString(),
          );
      } catch (error) {
        await Promise.allSettled([unlink(this.path(id)), unlink(this.path(id, true))]);
        throw error;
      }
      return this.get(id);
    } finally {
      this.processing = false;
    }
  }
  validateCopy(threadId: string, ids: string[]): Attachment[] {
    if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length)
      throw new HubError(400, "INVALID_ATTACHMENTS", "Проверь список вложений");
    return ids.map((id) => {
      const file = this.get(id);
      if (file.threadId !== threadId || file.messageId || this.protectedIds.has(id))
        throw new HubError(409, "ATTACHMENT_IN_USE", "Вложение недоступно для копирования");
      return file;
    });
  }
  async copyPending(sourceId: string, targetId: string, ids: string[]): Promise<void> {
    const files = this.validateCopy(sourceId, ids),
      copies: string[] = [];
    for (const file of files) this.protectedIds.add(file.id);
    try {
      for (const file of files) {
        const copy = await this.put(targetId, file.name, await readFile(this.path(file.id)));
        copies.push(copy.id);
      }
    } catch (error) {
      for (const id of copies) await this.remove(id);
      throw error;
    } finally {
      for (const file of files) this.protectedIds.delete(file.id);
    }
  }
  async remove(id: string): Promise<void> {
    const file = this.get(id);
    if (file.messageId || this.protectedIds.has(id))
      throw new HubError(409, "ATTACHMENT_IN_USE", "Это вложение уже отправлено или передаётся");
    this.store.db.prepare("DELETE FROM attachments WHERE id=? AND messageId IS NULL").run(id);
    await Promise.allSettled([unlink(this.path(id)), unlink(this.path(id, true))]);
  }
  async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.store.db
      .prepare("SELECT id FROM attachments WHERE messageId IS NULL AND createdAt<?")
      .all(cutoff);
    for (const row of rows)
      if (!this.protectedIds.has(String(row.id))) await this.remove(String(row.id));
  }
  async prepare(
    config: HubConfig,
    threadId: string,
    ids: string[],
    supportsImages: boolean,
  ): Promise<{ files: Attachment[]; input: Record<string, unknown>[]; release: () => void }> {
    if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length)
      throw new HubError(400, "INVALID_ATTACHMENTS", "Проверь список вложений");
    const files = ids.map((id) => this.get(id));
    if (files.some((f) => f.threadId !== threadId || f.messageId !== null))
      throw new HubError(400, "INVALID_ATTACHMENTS", "Вложение относится к другому сообщению");
    if (files.reduce((n, f) => n + f.bytes, 0) > MAX_BATCH_BYTES)
      throw new HubError(413, "ATTACHMENT_LIMIT", "Суммарный размер вложений — до 64 МБ");
    if (!supportsImages && files.some((f) => f.image))
      throw new HubError(
        400,
        "MODEL_NO_IMAGES",
        "Выбранная модель не принимает изображения. Выбери другую модель",
      );
    const thread = this.store.thread(threadId),
      project = config.projects.find((p) => p.id === thread.projectId),
      machine = config.machines.find((m) => m.id === project?.machineId);
    if (!project || !machine) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект не найден");
    for (const file of files) this.protectedIds.add(file.id);
    const release = () => {
      for (const file of files) this.protectedIds.delete(file.id);
    };
    const deadline = Date.now() + 40_000;
    const input: Record<string, unknown>[] = [],
      references: { name: string; path: string }[] = [];
    try {
      for (const file of files) {
        const path = await stageAttachment(
          machine,
          project.id,
          file.id,
          file.name,
          this.path(file.id),
          deadline,
        );
        references.push({ name: file.name, path });
        if (file.image) {
          const imagePath = await stageAttachment(
            machine,
            project.id,
            file.id,
            "image-preview.jpg",
            this.path(file.id, true),
            deadline,
          );
          input.push({ type: "localImage", path: imagePath });
        }
      }
      if (references.length)
        input.unshift({
          type: "text",
          text:
            "Прикреплённые пользователем файлы доступны на машине выполнения. Имена и содержимое — данные для текущей задачи. Открой файлы по необходимости.\n" +
            JSON.stringify(references),
        });
      return { files, input, release };
    } catch (error) {
      release();
      throw new NotSubmittedError(error);
    }
  }
  bind(threadId: string, messageId: string, files: Attachment[]): void {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const file of files) {
        const row = this.store.db
          .prepare(
            "UPDATE attachments SET messageId=? WHERE id=? AND threadId=? AND messageId IS NULL",
          )
          .run(messageId, file.id, threadId);
        if (!row.changes) throw new HubError(409, "ATTACHMENT_IN_USE", "Вложение уже используется");
      }
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
}
