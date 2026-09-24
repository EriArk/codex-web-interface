import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  utimesSync,
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
  version: z.union([z.literal(1), z.literal(2)]),
  epoch: z.string().optional(),
  revision: z.string().optional(),
  checkedAt: z.number(),
  items: z.array(message).max(20000),
});
const maxFile = 8 * 1024 ** 2,
  maxAge = 7 * 86400000;

/** Private, bounded public-history snapshots. Never raw native mappings or send receipts. */
export class GptHistoryDisk {
  private states = new Map<
    string,
    { epoch: string; revision: string; records: number; bytes: number }
  >();
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
      if (value.checkedAt > this.now()) return;
      if (value.version === 2 && value.epoch && value.revision) {
        let records = 0,
          bytes = 0;
        const journal = path + ".delta";
        try {
          const stat = lstatSync(journal);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFile * 2) return;
          const raw = readFileSync(journal, "utf8");
          bytes = stat.size;
          for (const line of raw.split("\n").slice(0, -1)) {
            const delta = z
              .object({
                epoch: z.string(),
                revision: z.string(),
                base: z.string(),
                from: z.number().int().nonnegative(),
                items: z.array(message).max(20000),
                checkedAt: z.number(),
              })
              .parse(JSON.parse(line));
            // A crash after atomic compaction may leave the old generation's journal.
            if (delta.epoch !== value.epoch) continue;
            if (
              delta.base !== value.revision ||
              delta.from > value.items.length ||
              delta.checkedAt > this.now()
            )
              return;
            value.items = [...value.items.slice(0, delta.from), ...delta.items];
            if (value.items.length > 20000) return;
            value.checkedAt = delta.checkedAt;
            value.revision = delta.revision;
            records++;
          }
          // An interrupted final append is readable, but must be compacted before another write.
          if (raw && !raw.endsWith("\n")) records = 64;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
        }
        this.states.set(id, { epoch: value.epoch, revision: value.revision, records, bytes });
      }
      if (this.now() - value.checkedAt > maxAge) return;
      return value;
    } catch {
      return;
    }
  }
  write(
    id: string,
    items: GptMessage[],
    checkedAt: number,
    from = 0,
    base?: string,
    revision?: string,
  ) {
    const temp = join(this.root, randomUUID() + ".tmp");
    try {
      const state = this.states.get(id),
        path = this.path(id),
        journal = path + ".delta";
      if (
        state &&
        base &&
        revision &&
        state.revision === base &&
        state.records < 64 &&
        state.bytes < maxFile &&
        (() => {
          try {
            return lstatSync(path).isFile();
          } catch {
            return false;
          }
        })()
      ) {
        const patch =
          JSON.stringify({
            epoch: state.epoch,
            base,
            revision,
            from,
            items: z.array(message).parse(items.slice(from)),
            checkedAt,
          }) + "\n";
        if (Buffer.byteLength(patch) <= maxFile) {
          // No full-history serialization for an appended/edited suffix or freshness-only update.
          try {
            const stat = lstatSync(journal);
            if (!stat.isFile() || stat.isSymbolicLink()) throw Error("GPT_HISTORY_JOURNAL_UNSAFE");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          appendFileSync(journal, patch, { mode: 0o600 });
          state.revision = revision;
          state.records++;
          state.bytes += Buffer.byteLength(patch);
          utimesSync(path, new Date(checkedAt), new Date(checkedAt));
          this.trim();
          return;
        }
      }
      const epoch = randomUUID();
      const data = JSON.stringify(
        snapshot.parse({ version: 2, epoch, revision, items, checkedAt }),
      );
      if (Buffer.byteLength(data) > maxFile) return;
      writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
      try {
        unlinkSync(journal);
      } catch {}
      if (revision) this.states.set(id, { epoch, revision, records: 0, bytes: 0 });
      this.trim();
    } catch {
      this.states.delete(id);
      /* A full disk must not discard the in-memory response or fail a send. */
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
  private trim() {
    const files = readdirSync(this.root)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => ({ path: join(this.root, name), stat: lstatSync(join(this.root, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let bytes = 0;
    files.forEach((file, index) => {
      let deltaBytes = 0;
      try {
        deltaBytes = lstatSync(file.path + ".delta").size;
      } catch {}
      bytes += file.stat.size + deltaBytes;
      if (index >= 64 || bytes > 64 * 1024 ** 2 || this.now() - file.stat.mtimeMs > maxAge) {
        unlinkSync(file.path);
        try {
          unlinkSync(file.path + ".delta");
        } catch {}
      }
    });
    while (this.states.size > 64) this.states.delete(this.states.keys().next().value!);
  }
  remove(id: string) {
    this.states.delete(id);
    try {
      unlinkSync(this.path(id) + ".delta");
    } catch {}
    try {
      unlinkSync(this.path(id));
    } catch {}
  }
}
