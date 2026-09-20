import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GptMessage } from "@codex-web/shared";
import { z } from "zod";

const message = z.object({
  id: z.string().max(100),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(500000),
  createdAt: z.number(),
  phase: z.enum(["commentary", "final"]).optional(),
  complete: z.boolean().optional(),
  activity: z.enum(["search", "review", "code", "image", "tool"]).optional(),
  files: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(1000),
        mime: z.string().max(200),
        bytes: z.number(),
        image: z.boolean(),
        url: z.string().startsWith("/api/gpt/").max(2000),
      }),
    )
    .max(256),
  unsupported: z
    .array(z.enum(["audio", "video", "interactive", "other"]))
    .max(4)
    .optional(),
});
const snapshot = z.object({
  version: z.literal(1),
  checkedAt: z.number(),
  items: z.array(message).max(20000),
});
const maxFile = 8 * 1024 ** 2,
  maxAge = 7 * 86400000;

/** Private, bounded public-history snapshots. Never raw native mappings or send receipts. */
export class GptHistoryDisk {
  constructor(
    private root: string,
    private now = Date.now,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("GPT_HISTORY_DIRECTORY_UNSAFE");
  }
  private path(id: string) {
    return join(this.root, createHash("sha256").update(id).digest("hex") + ".json");
  }
  read(id: string): { items: GptMessage[]; checkedAt: number } | undefined {
    try {
      const path = this.path(id),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFile) return;
      const value = snapshot.parse(JSON.parse(readFileSync(path, "utf8")));
      if (value.checkedAt > this.now() || this.now() - value.checkedAt > maxAge) return;
      return value;
    } catch {
      return;
    }
  }
  write(id: string, items: GptMessage[], checkedAt: number) {
    const temp = join(this.root, randomUUID() + ".tmp");
    try {
      const data = JSON.stringify(snapshot.parse({ version: 1, items, checkedAt }));
      if (Buffer.byteLength(data) > maxFile) return;
      writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.path(id));
      const files = readdirSync(this.root)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => ({ path: join(this.root, name), stat: lstatSync(join(this.root, name)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      let bytes = 0;
      files.forEach((file, index) => {
        bytes += file.stat.size;
        if (index >= 64 || bytes > 64 * 1024 ** 2 || this.now() - file.stat.mtimeMs > maxAge)
          unlinkSync(file.path);
      });
    } catch {
      /* A full disk must not discard the in-memory response or fail a send. */
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
  remove(id: string) {
    try {
      unlinkSync(this.path(id));
    } catch {}
  }
}
