import { createHash } from "node:crypto";
import type { GptMessage, ResultCategory, ResultItem, ResultPage } from "@codex-web/shared";
import { resultCategory } from "@codex-web/shared";
import { gptResults, resultPage } from "./gpt-results.js";
import type { GptTextArtifacts } from "./gpt-text-artifacts.js";
import type { Previews } from "./previews.js";

type Change = {
  base: string;
  revision: string;
  ids: string[];
  added: string[];
  reset: boolean;
  heads: Map<ResultCategory, string[]>;
};
const categories: ResultCategory[] = [
  "all",
  "files",
  "images",
  "links",
  "demos",
  "reasoning",
  "work",
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Public metadata only. Its lifetime and byte budget belong to the history entry. */
export class GptResultIndex {
  private itemHashes = new WeakMap<ResultItem, { hash: string; bytes: number }>();
  private messages: GptMessage[] = [];
  private parts = new Map<GptMessage, ResultItem[]>();
  private groups = new Map<string, { messages: GptMessage[]; item: ResultItem }>();
  private fingerprints = new Map<string, string>();
  private changes: Change[] = [];
  private heads = new Map<ResultCategory, string[]>();
  private byId = new Map<string, ResultItem>();
  items: ResultItem[] = [];
  revision = "";
  bytes = 0;
  constructor(
    private nativeId: string,
    private previews: Previews,
    private baseUrl?: string,
    private artifacts?: GptTextArtifacts,
  ) {}

  update(messages: GptMessage[]) {
    if (this.messages === messages && this.revision) return;
    const grouped = new Map<string, GptMessage[]>();
    let group: GptMessage[] | undefined;
    for (const message of messages) {
      if (message.role === "user") {
        group = [message];
        grouped.set(message.id, group);
      } else group?.push(message);
    }
    const groups = new Map<string, { messages: GptMessage[]; item: ResultItem }>();
    for (const [id, rows] of grouped) {
      const old = this.groups.get(id),
        first = rows[0]!;
      const item: ResultItem =
        old && old.messages.length === rows.length && rows.every((m, i) => m === old.messages[i])
          ? old.item
          : {
              id: "reasoning-" + id,
              turnId: id,
              type: "reasoning",
              title: first.text.trim().slice(0, 160) || "Запрос с вложениями",
              createdAt: new Date(first.createdAt * 1000 || 0).toISOString(),
              payload: {
                text: first.text,
                steps: rows.slice(1).map((m) => ({
                  id: m.id,
                  text: m.text,
                  activity: m.activity,
                  state: m.complete === false ? "active" : "completed",
                })),
              },
            };
      groups.set(id, { messages: rows, item });
    }
    const parts = new Map<GptMessage, ResultItem[]>(),
      result = new Map<string, ResultItem>();
    for (const message of messages) {
      const request = groups.get(message.id);
      if (message.role === "user" && request) result.set(request.item.id, request.item);
      const items =
        this.parts.get(message) ??
        gptResults(this.nativeId, [message], this.previews, this.baseUrl, this.artifacts)
          .filter((item) => item.type !== "reasoning")
          .reverse();
      parts.set(message, items);
      for (const item of items) {
        if (item.type === "link") result.delete(item.id);
        result.set(item.id, item);
      }
    }
    const items = [...result.values()].reverse(),
      fingerprints = new Map<string, string>();
    let bytes = 0;
    for (const item of items) {
      let digest = this.itemHashes.get(item);
      if (!digest) {
        const serialized = JSON.stringify(item);
        digest = { hash: hash(serialized), bytes: serialized.length * 4 };
        this.itemHashes.set(item, digest);
      }
      bytes += digest.bytes;
      fingerprints.set(item.id, digest.hash);
    }
    const revision = hash(JSON.stringify([...fingerprints]));
    const changed = [...new Set([...fingerprints.keys(), ...this.fingerprints.keys()])].filter(
      (id) => fingerprints.get(id) !== this.fingerprints.get(id),
    );
    let firstChanged = 0;
    while (
      firstChanged < this.messages.length &&
      messages[firstChanged] === this.messages[firstChanged]
    )
      firstChanged++;
    const lastUser = this.messages.findLastIndex((m) => m.role === "user");
    const added = items.filter((item) => !this.byId.has(item.id)).map((item) => item.id);
    if (this.revision && revision !== this.revision)
      this.changes = [
        ...this.changes,
        {
          base: this.revision,
          revision,
          ids: changed.length <= 100 ? changed : [],
          added: added.length <= 20 ? added : [],
          reset: changed.length > 100 || added.length > 20 || firstChanged < lastUser,
          heads: this.heads,
        },
      ].slice(-16);
    this.parts = parts;
    this.groups = groups;
    this.messages = messages;
    this.items = items;
    this.byId = result;
    this.fingerprints = fingerprints;
    this.revision = revision;
    this.bytes = bytes + this.changes.length * 20000;
    this.heads = new Map(
      categories.map((category) => [
        category,
        resultPage(items, category).items.map((item) => item.id),
      ]),
    );
  }
  page(category: ResultCategory, before?: string, known?: string): ResultPage {
    const page = resultPage(this.items, category, before);
    if (before || !known) return { ...page, revision: this.revision };
    if (known === this.revision)
      return { ...page, items: [], revision: this.revision, notModified: true };
    const index = this.changes.findIndex((change) => change.base === known),
      changes = this.changes.slice(index);
    if (index < 0 || changes.some((change) => change.reset))
      return { ...page, revision: this.revision, reset: true };
    const ids = new Set(changes.flatMap((change) => change.ids));
    const head = new Set(page.items.map((item) => item.id));
    // Several individually small updates can still leave a gap beyond the first page.
    const missed = changes.some((change) =>
      change.added.some((id) => {
        const item = this.byId.get(id);
        return (
          item && (category === "all" || resultCategory(item.type) === category) && !head.has(id)
        );
      }),
    );
    if (missed) return { ...page, revision: this.revision, reset: true };
    const oldHead = this.changes[index]!.heads.get(category) ?? [];
    for (const item of page.items) if (!oldHead.includes(item.id)) ids.add(item.id);
    if (ids.size > 100) return { ...page, revision: this.revision, reset: true };
    const removed: string[] = [],
      items: ResultItem[] = [];
    for (const id of ids) {
      const item = this.byId.get(id);
      if (!item || (category !== "all" && resultCategory(item.type) !== category)) removed.push(id);
      else items.push(item);
    }
    return {
      ...page,
      items,
      revision: this.revision,
      delta: { baseRevision: known, removed, head: page.items.map((item) => item.id) },
    };
  }
}
