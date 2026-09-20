import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubError, type ResultItem } from "@codex-web/shared";
import type { Store } from "./store.js";

export const GPT_TEXT_LIMIT = 2 * 1024 * 1024;
export function textExcerpt(text: string) {
  const prefix = [...text.slice(0, 1200)].join("").split(/\r?\n/).slice(0, 6).join("\n");
  return prefix + (prefix.length < text.length ? "\n…" : "");
}

/** Account-local frozen public blocks. IDs bind conversation, message, position and bytes. */
export class GptTextArtifacts {
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly maxBytes = 128 * 1024 * 1024,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    store.db.exec(`CREATE TABLE IF NOT EXISTS gpt_text_artifacts(
      id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, messageId TEXT NOT NULL,
      blockIndex INTEGER NOT NULL, bytes INTEGER NOT NULL, createdAt TEXT NOT NULL)`);
  }
  put(
    conversationId: string,
    messageId: string,
    block: { index: number; text: string; language: string },
    createdAt: string,
  ): ResultItem {
    const id = createHash("sha256")
      .update(JSON.stringify([conversationId, messageId, block.index, block.text]))
      .digest("hex");
    const name = `gpt-${id.slice(0, 16)}.md`;
    const bytes = Buffer.byteLength(block.text);
    const item: ResultItem = {
      id: "text-" + id,
      turnId: messageId,
      type: "file",
      title: name,
      createdAt,
      payload: {
        bytes,
        mime: "text/markdown",
        language: block.language,
        excerpt: textExcerpt(block.text),
      },
    };
    if (bytes > GPT_TEXT_LIMIT) {
      item.payload.message = "Блок больше 2 МБ. Полный текст сохранён в исходном сообщении.";
      return item;
    }
    try {
      const exists = this.store.db.prepare("SELECT 1 FROM gpt_text_artifacts WHERE id=?").get(id);
      const path = join(this.root, id + ".md");
      if (!exists || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
        const usage = this.store.db
          .prepare("SELECT coalesce(sum(bytes),0) AS bytes,count(*) AS n FROM gpt_text_artifacts")
          .get()!;
        if (!exists && (Number(usage.bytes) + bytes > this.maxBytes || Number(usage.n) >= 2000))
          throw new Error("QUOTA");
        const temporary = join(this.root, id + "." + randomUUID() + ".part");
        try {
          writeFileSync(temporary, block.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
          renameSync(temporary, path);
          this.store.db
            .prepare("INSERT OR IGNORE INTO gpt_text_artifacts VALUES(?,?,?,?,?,?)")
            .run(id, conversationId, messageId, block.index, bytes, createdAt);
        } finally {
          try {
            unlinkSync(temporary);
          } catch {
            /* Already finalized or write failed. */
          }
        }
      }
      item.payload.url = "/api/gpt/text-artifacts/" + id;
    } catch {
      item.payload.message =
        "Не удалось сохранить файл. Полный текст остаётся в исходном сообщении.";
    }
    return item;
  }
  describe(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new HubError(404, "RESULT_NOT_FOUND", "Файл не найден.");
    const row = this.store.db.prepare("SELECT * FROM gpt_text_artifacts WHERE id=?").get(id);
    const path = join(this.root, id + ".md");
    if (!row || !statSync(path, { throwIfNoEntry: false })?.isFile())
      throw new HubError(404, "RESULT_NOT_FOUND", "Файл не найден.");
    return {
      conversationId: String(row.conversationId),
      path,
      name: `gpt-${id.slice(0, 16)}.md`,
      bytes: Number(row.bytes),
    };
  }
}
