import { createHash } from "node:crypto";
import type { GptProgress } from "@codex-web/shared";

// These are short labels extracted from visible ChatGPT controls by the pinned DOM adapter.
// Never accept thinking.snapshot, free-form event text, tool output or native analysis channels.
export function gptProgress(event: Record<string, any>): GptProgress[] {
  if (
    event.type !== "assistant.progress.snapshot" ||
    event.source !== "tab.observation" ||
    !Array.isArray(event.items)
  )
    return [];
  return event.items.slice(-24).flatMap((item: Record<string, any>) => {
    if (
      !item ||
      item.kind !== "thinking" ||
      item.visible !== true ||
      !["cot-v5", "loading-shimmer-tertiary", "tertiary-transition"].includes(item.source) ||
      typeof item.text !== "string"
    )
      return [];
    const text = item.text.trim();
    if (
      !text ||
      text.length > 500 ||
      text.split("\n").length > 5 ||
      /https?:\/\/|file:\/\/|<[^>]+>/.test(text) ||
      Array.from(text).some((c) => c.charCodeAt(0) === 0)
    )
      return [];
    return [
      {
        id: createHash("sha256")
          .update(String(item.id ?? item.logicalId ?? text))
          .digest("hex")
          .slice(0, 24),
        text,
        state:
          item.active === false || item.state === "completed"
            ? ("completed" as const)
            : ("active" as const),
      },
    ];
  });
}
export function mergeGptProgress(previous: GptProgress[], incoming: GptProgress[]): GptProgress[] {
  if (!incoming.length) return previous;
  const ids = new Set(incoming.filter((i) => i.state === "active").map((i) => i.id));
  return [
    ...new Map(
      [
        ...previous.map((i) => (ids.has(i.id) ? i : { ...i, state: "completed" as const })),
        ...incoming,
      ].map((i) => [i.id, i]),
    ).values(),
  ].slice(-24);
}
