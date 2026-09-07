import type { GptMessage, ResultCategory, ResultItem, ResultPage } from "@codex-web/shared";
import { emptyResultCounts, HubError, resultCategory } from "@codex-web/shared";
import { type Previews, previewSources } from "./previews.js";

export function gptResults(
  nativeId: string,
  messages: GptMessage[],
  previews: Previews,
): ResultItem[] {
  const results = new Map<string, ResultItem>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const file of message.files) {
      const id = file.id;
      results.set(id, {
        id,
        turnId: message.id,
        type: file.image ? "image" : "file",
        title: file.name,
        createdAt: new Date(message.createdAt * 1000 || 0).toISOString(),
        payload: { url: file.url, mime: file.mime },
      });
    }
    for (const source of previewSources({ type: "agentMessage", text: message.text }).filter(
      (source) => source.html,
    )) {
      const id = previews.inline("gpt:" + nativeId, message.id, source.html ?? "");
      if (id)
        results.set(id, {
          id,
          turnId: message.id,
          type: "preview",
          title: source.title,
          createdAt: new Date(message.createdAt * 1000 || 0).toISOString(),
          payload: { url: "/api/gpt/previews/" + id },
        });
    }
  }
  return [...results.values()].reverse();
}
export function resultPage(
  items: ResultItem[],
  category: ResultCategory,
  before?: string,
): ResultPage {
  const counts = emptyResultCounts();
  for (const item of items) {
    counts.all++;
    counts[resultCategory(item.type)]++;
  }
  const filtered = items.filter(
    (item) => category === "all" || resultCategory(item.type) === category,
  );
  const offset = before ? filtered.findIndex((item) => item.id === before) + 1 : 0;
  if (before && offset === 0)
    throw new HubError(409, "RESULTS_CHANGED", "Результаты изменились. Обнови список.");
  const page = filtered.slice(offset, offset + 20);
  return {
    items: page,
    counts,
    nextBefore: offset + 20 < filtered.length ? (page.at(-1)?.id ?? null) : null,
  };
}
