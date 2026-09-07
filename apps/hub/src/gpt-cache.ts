import { createHash } from "node:crypto";
import type { GptHistoryPage, GptMessage } from "@codex-web/shared";
import { HubError } from "@codex-web/shared";

const hash = (items: GptMessage[]) =>
  createHash("sha256").update(JSON.stringify(items)).digest("hex");
type Entry = { items: GptMessage[]; revision: string; checkedAt: number; bytes: number };
export class GptHistoryCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Entry>>();
  constructor(
    private load: (id: string) => Promise<GptMessage[]>,
    private now = Date.now,
  ) {}
  seed(id: string, items: GptMessage[]) {
    const value = {
      items,
      revision: hash(items),
      checkedAt: this.now(),
      bytes: JSON.stringify(items).length * 2,
    };
    this.entries.delete(id);
    this.entries.set(id, value);
    while (
      this.entries.size > 12 ||
      [...this.entries.values()].reduce((n, v) => n + v.bytes, 0) > 16 * 1024 ** 2
    )
      this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  invalidate(id: string) {
    this.entries.delete(id);
  }
  private async get(id: string, ttl: number) {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const cached = this.entries.get(id);
    if (cached && this.now() - cached.checkedAt < ttl) return cached;
    const task = this.load(id).then((items) => this.seed(id, items));
    this.pending.set(id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
  async page(
    id: string,
    query: { before?: string; known?: string; anchor?: string; prefix?: string },
    ttl = 15000,
  ): Promise<GptHistoryPage> {
    const entry = await this.get(id, ttl),
      list = entry.items;
    if (!query.before && query.known === entry.revision)
      return {
        items: [],
        nextBefore: null,
        revision: entry.revision,
        prefix: "",
        notModified: true,
        retainOlder: true,
      };
    const end = query.before ? list.findIndex((m) => m.id === query.before) : list.length;
    if (end < 0) throw new HubError(409, "GPT_HISTORY_CHANGED", "История изменилась. Обнови чат.");
    const start = Math.max(0, end - 20);
    const anchor = query.anchor ? list.findIndex((m) => m.id === query.anchor) : -1;
    return {
      items: list.slice(start, end),
      nextBefore: start > 0 ? list[start]!.id : null,
      revision: entry.revision,
      prefix: hash(list.slice(0, start)),
      notModified: false,
      retainOlder: anchor >= 0 && query.prefix === hash(list.slice(0, anchor)),
    };
  }
}
