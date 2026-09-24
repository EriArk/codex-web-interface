import { createHash } from "node:crypto";
import type { GptHistoryPage, GptMessage } from "@codex-web/shared";
import { HubError } from "@codex-web/shared";
import type { GptHistoryDisk } from "./gpt-history-disk.js";
import type { GptResultIndex } from "./gpt-result-index.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const emptyPrefix = digest("gpt-public-history-v2");
type Change = {
  base: string;
  revision: string;
  from: number;
  replaceFrom: string | null;
  after: string | null;
};
export type GptHistorySnapshot = {
  fingerprints: string[];
  prefixes: string[];
  changes: Change[];
  results?: GptResultIndex;
  resultBytes?: number;
  persistedAt: number;
  items: GptMessage[];
  revision: string;
  checkedAt: number;
  bytes: number;
  lineage: number;
  usedAt: number;
  stale?: boolean;
  refreshMessage?: string;
};
export class GptHistoryCache {
  private hashes = new WeakMap<GptMessage, { fingerprint: string; bytes: number }>();
  private entries = new Map<string, GptHistorySnapshot>();
  private nextLineage = 0;
  private pending = new Map<string, Promise<GptHistorySnapshot>>();
  private removed = new Map<string, number>();
  private warming = new Map<string, number>();
  private pinned = new Set<string>();
  private recent = new Set<string>();
  constructor(
    private load: (id: string) => Promise<GptMessage[]>,
    private now = Date.now,
    private disk?: GptHistoryDisk,
  ) {}
  private trim() {
    const now = this.now();
    for (const [id, entry] of this.entries)
      if (!this.pinned.has(id) && !this.recent.has(id) && now - entry.usedAt >= 30 * 60000)
        this.entries.delete(id);
    const priority = (id: string) =>
      now - (this.warming.get(id) ?? -Infinity) < 30000
        ? 3
        : this.pinned.has(id)
          ? 2
          : this.recent.has(id)
            ? 1
            : 0;
    const oldest = [...this.entries].sort(
      ([a, av], [b, bv]) => priority(a) - priority(b) || av.usedAt - bv.usedAt,
    );
    let bytes = oldest.reduce((sum, [, entry]) => sum + entry.bytes + (entry.resultBytes ?? 0), 0);
    for (const [id, entry] of oldest) {
      if (this.entries.size <= 32 && bytes <= 32 * 1024 ** 2) break;
      this.entries.delete(id);
      bytes -= entry.bytes + (entry.resultBytes ?? 0);
    }
  }
  /** Pins retain already saved history; discovering a pin never fetches its conversation. */
  setPinned(ids: string[]) {
    const previous = this.pinned;
    this.pinned = new Set(ids);
    for (const id of ids.slice(0, 32))
      if (!previous.has(id) && !this.entries.has(id)) this.cached(id);
    this.trim();
  }
  setRecent(ids: string[]) {
    const previous = this.recent;
    this.recent = new Set(ids.filter((id) => !this.pinned.has(id)).slice(0, 10));
    for (const id of this.recent) if (!previous.has(id) && !this.entries.has(id)) this.cached(id);
    this.trim();
  }
  private cached(id: string) {
    this.trim();
    let entry = this.entries.get(id);
    if (!entry) {
      const saved = this.disk?.read(id);
      if (saved) entry = this.seed(id, saved.items, saved.checkedAt, false);
    }
    if (entry) entry.usedAt = this.now();
    return entry;
  }
  seed(id: string, items: GptMessage[], checkedAt = this.now(), persist = true) {
    const previous = this.entries.get(id);
    const fingerprints: string[] = [],
      prefixes = [emptyPrefix];
    let from = Math.min(previous?.items.length ?? 0, items.length),
      bytes = 0;
    const stable = items.map((message, index) => {
      let hashed = this.hashes.get(message);
      if (!hashed) {
        const serialized = JSON.stringify(message);
        hashed = { fingerprint: digest(serialized), bytes: serialized.length * 2 + 160 };
        if (
          Object.isFrozen(message) &&
          Object.isFrozen(message.files) &&
          message.files.every(Object.isFrozen) &&
          (!message.unsupported || Object.isFrozen(message.unsupported))
        )
          this.hashes.set(message, hashed);
      }
      const { fingerprint } = hashed;
      bytes += hashed.bytes;
      fingerprints.push(fingerprint);
      const unchanged = previous?.fingerprints[index] === fingerprint;
      if (!unchanged) from = Math.min(from, index);
      prefixes.push(
        unchanged && from > index
          ? previous!.prefixes[index + 1]!
          : digest(prefixes[index]! + fingerprint),
      );
      return unchanged
        ? previous!.items[index]!
        : this.hashes.has(message)
          ? message
          : structuredClone(message);
    });
    const revision = prefixes.at(-1)!;
    const changed = previous?.revision !== revision;
    const sameBranch =
      previous && previous.items.every((message, index) => stable[index]?.id === message.id);
    const changes =
      previous && changed
        ? [
            ...previous.changes,
            {
              base: previous.revision,
              revision,
              from,
              replaceFrom: previous.items[from]?.id ?? null,
              after: previous.items[from - 1]?.id ?? null,
            },
          ].slice(-16)
        : (previous?.changes ?? []);
    const value: GptHistorySnapshot = {
      lineage: sameBranch ? previous.lineage : ++this.nextLineage,
      items: changed ? stable : previous!.items,
      fingerprints,
      prefixes,
      changes,
      revision,
      checkedAt,
      usedAt: this.now(),
      bytes,
      results: previous?.results,
      resultBytes: previous?.resultBytes,
      persistedAt: previous?.persistedAt ?? checkedAt,
    };
    this.entries.delete(id);
    this.entries.set(id, value);
    // An unchanged poll updates freshness in memory, not the whole disk snapshot.
    if (persist && (changed || checkedAt - value.persistedAt >= 3600000)) {
      this.disk?.write(
        id,
        value.items,
        checkedAt,
        previous ? from : 0,
        previous?.revision,
        revision,
      );
      value.persistedAt = checkedAt;
    }
    this.trim();
    return value;
  }
  accountResults(entry: GptHistorySnapshot, bytes: number) {
    entry.resultBytes = bytes;
    this.trim();
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
    this.pinned.delete(id);
    this.recent.delete(id);
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
    const cached = this.cached(id);
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
  private async readable(id: string, ttl: number): Promise<GptHistorySnapshot> {
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
    this.trim();
    return this.entries.get(id)?.items ?? [];
  }
  async snapshot(id: string, ttl = 60000, immediate = false) {
    const cached = immediate ? this.cached(id) : undefined;
    // Results follows its initial cached read with one canonical refresh.
    if (cached) return cached;
    // A cache-only miss must not occupy the native queue. The caller follows
    // this immediately with its canonical request; do not persist an empty chat.
    if (immediate)
      return {
        items: [],
        fingerprints: [],
        prefixes: [emptyPrefix],
        changes: [],
        revision: "",
        checkedAt: 0,
        persistedAt: 0,
        bytes: 0,
        lineage: 0,
        usedAt: this.now(),
      } as GptHistorySnapshot;
    return this.readable(id, ttl);
  }
  async messages(id: string, ttl = 60000): Promise<GptMessage[]> {
    return (await this.get(id, ttl)).items;
  }
  async page(
    id: string,
    query: {
      delta?: string;
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
    const cached = immediate && !query.before && !query.messageId ? this.cached(id) : undefined;
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
    if (query.delta === "1" && query.known && !query.before && !query.messageId) {
      const index = entry.changes.findIndex((change) => change.base === query.known);
      if (index >= 0) {
        const changes = entry.changes.slice(index);
        const earliest = changes.reduce((a, b) => (b.from < a.from ? b : a));
        if (list.length - earliest.from <= 20)
          return {
            items: list.slice(earliest.from),
            nextBefore: null,
            revision: entry.revision,
            prefix: "",
            notModified: false,
            retainOlder: true,
            delta: {
              baseRevision: query.known,
              replaceFrom: earliest.replaceFrom,
              after: earliest.after,
            },
            stale: entry.stale,
            refreshMessage: entry.refreshMessage,
          };
      }
    }
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
      prefix: entry.prefixes[start]!,
      notModified: false,
      retainOlder: anchor >= 0 && query.prefix === entry.prefixes[anchor]!,
      stale: entry.stale,
      refreshMessage: entry.refreshMessage,
    };
  }
}
