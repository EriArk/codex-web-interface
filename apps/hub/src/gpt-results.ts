import { createHash } from "node:crypto";
import type { GptMessage, ResultCategory, ResultItem, ResultPage } from "@codex-web/shared";
import { emptyResultCounts, HubError, resultCategory } from "@codex-web/shared";
import { gptResultContent } from "./gpt-result-content.js";
import type { GptTextArtifacts } from "./gpt-text-artifacts.js";
import type { Previews } from "./previews.js";

export function gptResults(
  nativeId: string,
  messages: GptMessage[],
  previews: Previews,
  publicBaseUrl?: string,
  textArtifacts?: GptTextArtifacts,
): ResultItem[] {
  const results = new Map<string, ResultItem>();
  let request: ResultItem | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      request = {
        id: "reasoning-" + message.id,
        turnId: message.id,
        type: "reasoning",
        title: message.text.trim().slice(0, 160) || "Запрос с вложениями",
        createdAt: new Date(message.createdAt * 1000 || 0).toISOString(),
        payload: { text: message.text, steps: [] },
      };
      results.set(request.id, request);
    } else if (request && message.role === "assistant") {
      request.payload.steps!.push({
        id: message.id,
        text: message.text,
        activity: message.activity,
        state: message.complete === false ? "active" : "completed",
      });
    }
    const content = gptResultContent(message.text, publicBaseUrl);
    for (const [url, title] of content.links) {
      if (message.files.some((file) => file.url === url)) continue;
      const id =
        "link-" +
        createHash("sha256")
          .update(JSON.stringify([nativeId, url]))
          .digest("hex");
      results.delete(id);
      results.set(id, {
        id,
        turnId: message.id,
        type: "link",
        title,
        createdAt: new Date(message.createdAt * 1000 || 0).toISOString(),
        payload: { url },
      });
    }
    if (message.role !== "assistant") continue;
    if (textArtifacts && message.complete !== false && message.phase !== "commentary") {
      for (const block of content.blocks) {
        const item = textArtifacts.put(
          nativeId,
          message.id,
          block,
          new Date(message.createdAt * 1000 || 0).toISOString(),
        );
        results.set(item.id, item);
      }
    }
    for (const file of message.files) {
      const id = file.id;
      results.set(id, {
        id,
        turnId: message.id,
        type: file.image ? "image" : "file",
        title: file.name,
        createdAt: new Date(message.createdAt * 1000 || 0).toISOString(),
        payload: {
          url: file.url,
          mime: file.mime,
          ...(file.bytes > 0 ? { bytes: file.bytes } : {}),
        },
      });
    }
    for (const html of content.demos) {
      const id = previews.inline("gpt:" + nativeId, message.id, html);
      if (id)
        results.set(id, {
          id,
          turnId: message.id,
          type: "preview",
          title: "Интерактивное демо",
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
