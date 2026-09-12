import { createHash } from "node:crypto";
import { type GptMessage, HubError } from "@codex-web/shared";
import { gptHistory } from "./gpt-history.js";

type Json = Record<string, any>;
const failure = () =>
  new HubError(
    409,
    "GPT_VERSION_CHANGED",
    "Версия больше не относится к выбранному сообщению. Обнови список.",
  );
function find(source: Json, messageId: string) {
  return Object.entries(source.mapping ?? {}).find(
    ([, n]: [string, any]) => n.message?.id === messageId,
  ) as [string, Json] | undefined;
}
function user(source: Json, nodeId: string, cache: Map<string, string | null>) {
  const seen = new Set<string>();
  let id = nodeId,
    result: string | null = null;
  while (id && !seen.has(id) && seen.size < 20000) {
    if (cache.has(id)) {
      result = cache.get(id)!;
      break;
    }
    seen.add(id);
    const n = source.mapping?.[id];
    if (n?.message?.author?.role === "user") {
      result = id;
      break;
    }
    id = n?.parent;
  }
  for (const key of seen) cache.set(key, result);
  return result;
}
export const versionHash = (messages: GptMessage[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          files: m.files.map((f) => f.id).sort(),
          unsupported: m.unsupported ?? [],
        })),
      ),
    )
    .digest("hex");
export function gptVersions(source: Json, nativeId: string, messageId: string) {
  const currentHistory = gptHistory(source, nativeId),
    sourceMessage = currentHistory.find((m) => m.id === messageId),
    current = find(source, messageId),
    cache = new Map<string, string | null>();
  if (!sourceMessage || !current) throw failure();
  const anchor = user(source, current[0], cache);
  const candidates = Object.entries(source.mapping ?? {}).filter(([nodeId, n]: [string, any]) => {
    if (n.message?.author?.role !== sourceMessage.role) return false;
    if (sourceMessage.role === "user") return n.parent === current[1].parent;
    if (n.message?.channel && n.message.channel !== "final") return false;
    return user(source, nodeId, cache) === anchor;
  });
  const items = candidates.slice(-40).flatMap(([nodeId]) => {
    const messages = gptHistory({ ...source, current_node: nodeId }, nativeId),
      message = messages.at(-1);
    if (
      !message ||
      message.id !== source.mapping[nodeId].message.id ||
      message.role !== sourceMessage.role
    )
      return [];
    // Commentary and consecutive pieces in one answer are not alternate versions.
    if (
      sourceMessage.role === "assistant" &&
      message.id !== messageId &&
      messages.some((m) => m.id === messageId)
    )
      return [];
    if (
      sourceMessage.role === "assistant" &&
      message.id !== messageId &&
      currentHistory.some((m) => m.id === message.id)
    )
      return [];
    return [
      {
        nodeId,
        messageId: message.id,
        current: message.id === messageId,
        text: message.text.slice(0, 240),
        createdAt: message.createdAt,
      },
    ];
  });
  return { currentNode: source.current_node, items, truncated: candidates.length > 40 };
}
export function gptVersion(
  source: Json,
  nativeId: string,
  messageId: string,
  targetMessageId: string,
) {
  const target = gptVersions(source, nativeId, messageId).items.find(
    (i) => i.messageId === targetMessageId,
  );
  if (!target) throw failure();
  const messages = gptHistory({ ...source, current_node: target.nodeId }, nativeId);
  return {
    currentNode: source.current_node,
    messages: messages.slice(-20),
    hasOlder: messages.length > 20,
    hash: versionHash(messages),
    count: messages.length,
  };
}
