import { createHash } from "node:crypto";
import type { GptHistoryPage, GptMessage } from "@codex-web/shared";
import { HubError } from "@codex-web/shared";
import type { GptHistoryDisk } from "./gpt-history-disk.js";

const hash = (items: GptMessage[]) =>
  createHash("sha256").update(JSON.stringify(items)).digest("hex");
type Entry = {
  items: GptMessage[];
  revision: string;
  checkedAt: number;
  bytes: number;
  lineage: number;
  stale?: boolean;
  refreshMessage?: string;
};
export class GptHistoryCache {
  private entries = new Map<string, Entry>();
  private nextLineage = 0;
  private pending = new Map<string, Promise<Entry>>();
  private removed = new Map<string, number>();
  private warming = new Map<string, number>();
  constructor(
    private load: (id: string) => Promise<GptMessage[]>,
    private now = Date.now,
    private disk?: GptHistoryDisk,
  ) {}
  seed(id: string, items: GptMessage[], checkedAt = this.now(), persist = true) {
    const previous = this.entries.get(id);
    const sameBranch =
      previous && previous.items.every((message, index) => items[index]?.id === message.id);
    const value = {
      lineage: sameBranch ? previous.lineage : ++this.nextLineage,
      items,
      revision: hash(items),
      checkedAt,
      bytes: JSON.stringify(items).length * 2,
    };
    this.entries.delete(id);
    this.entries.set(id, value);
    if (persist) this.disk?.write(id, items, checkedAt);
    while (
      this.entries.size > 12 ||
      [...this.entries.values()].reduce((n, v) => n + v.bytes, 0) > 16 * 1024 ** 2
    )
      this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  invalidate(id: string) {
    const entry = this.entries.get(id);
    if (entry) entry.checkedAt = Number.NEGATIVE_INFINITY;
  }
  remove(id: string) {
    this.removed.set(id, (this.removed.get(id) ?? 0) + 1);
    this.entries.delete(id);
    this.disk?.remove(id);
    this.warming.delete(id);
  }
  /** Active native jobs and returning viewers coalesce bounded background reads. */
  warm(id: string, finished = false) {
    if (!finished && this.now() - (this.warming.get(id) ?? -Infinity) < 10000) return;
    this.warming.delete(id);
    this.warming.set(id, this.now());
    while (this.warming.size > 32) this.warming.delete(this.warming.keys().next().value!);
    const pending = this.pending.get(id),
      generation = this.removed.get(id);
    const read =
      finished && pending
        ? pending
            .catch(() => {})
            .then(() => {
              if (generation === this.removed.get(id)) return this.get(id, 0);
            })
        : this.get(id, 0);
    void read.catch(() => {});
  }
  private async get(id: string, ttl: number) {
    let cached = this.entries.get(id);
    if (!cached) {
      const saved = this.disk?.read(id);
      if (saved) cached = this.seed(id, saved.items, saved.checkedAt, false);
    }
    if (cached && this.now() - cached.checkedAt < ttl) return cached;
    const pending = this.pending.get(id);
    if (pending) return pending;
    const generation = this.removed.get(id);
    const task = this.load(id).then((items) => {
      if (generation !== this.removed.get(id))
        throw new HubError(404, "GPT_HISTORY_UNAVAILABLE", "Чат удалён.");
      return this.seed(id, items);
    });
    this.pending.set(id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
  private async readable(id: string, ttl: number): Promise<Entry> {
    try {
      return await this.get(id, ttl);
    } catch (error) {
      const cached = this.entries.get(id);
      // Authorization/deletion/invalid-branch errors must never fall back to an old branch.
      if (
        !cached ||
        !(error instanceof HubError) ||
        !["GPT_HISTORY_RATE_LIMITED", "GPT_HISTORY_UNAVAILABLE", "GPT_CONNECTION_LOST"].includes(
          error.code,
        ) ||
        error.statusCode === 404
      )
        throw error;
      return {
        ...cached,
        stale: true,
        refreshMessage:
          "Показана сохранённая история. Обновление временно недоступно; повторим автоматически.",
      };
    }
  }
  peek(id: string): GptMessage[] {
    return this.entries.get(id)?.items ?? [];
  }
  async snapshot(id: string, ttl = 60000) {
    return this.readable(id, ttl);
  }
  async messages(id: string, ttl = 60000): Promise<GptMessage[]> {
    return (await this.get(id, ttl)).items;
  }
  async page(
    id: string,
    query: {
      before?: string;
      known?: string;
      anchor?: string;
      prefix?: string;
      messageId?: string;
    },
    ttl = 60000,
    immediate = false,
  ): Promise<GptHistoryPage> {
    // A returning viewer may use a warm snapshot while its background read runs.
    // Explicit refreshes, older pages and source navigation still await canonical data.
    const cached =
      immediate && !query.known && !query.before && !query.messageId
        ? this.entries.get(id)
        : undefined;
    if (cached && this.now() - cached.checkedAt >= ttl) this.warm(id);
    const entry = cached ?? (await this.readable(id, ttl)),
      list = entry.items;
    if (!query.messageId && !query.before && query.known === entry.revision)
      return {
        items: [],
        nextBefore: null,
        revision: entry.revision,
        prefix: "",
        notModified: true,
        retainOlder: true,
        stale: entry.stale,
        refreshMessage: entry.refreshMessage,
      };
    const focus = query.messageId ? list.findIndex((m) => m.id === query.messageId) : -1;
    if (query.messageId && focus < 0)
      throw new HubError(
        404,
        "GPT_MESSAGE_MISSING",
        "Сообщение больше не находится в этой ветке чата.",
      );
    const end = query.messageId
      ? Math.min(list.length, focus + 11)
      : query.before
        ? list.findIndex((m) => m.id === query.before)
        : list.length;
    if (end < 0) throw new HubError(409, "GPT_HISTORY_CHANGED", "История изменилась. Обнови чат.");
    const start = Math.max(0, end - 20);
    const anchor = query.anchor ? list.findIndex((m) => m.id === query.anchor) : -1;
    return {
      items: list.slice(start, end),
      contextMessage: query.messageId,
      hasNewer: !!query.messageId && end < list.length,
      nextBefore: start > 0 ? list[start]!.id : null,
      revision: entry.revision,
      prefix: hash(list.slice(0, start)),
      notModified: false,
      retainOlder: anchor >= 0 && query.prefix === hash(list.slice(0, anchor)),
      stale: entry.stale,
      refreshMessage: entry.refreshMessage,
    };
  }
}
