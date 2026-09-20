import type { GptConversation, GptFile, GptMessage, GptProject } from "@codex-web/shared";
import { gptLinkedText } from "./gpt-links.js";
import { gptSandboxFiles } from "./gpt-sandbox-files.js";

type Json = Record<string, any>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
export const gptId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function gptCatalog(value: unknown): {
  items: GptConversation[];
  nextOffset: number | null;
} {
  const data = record(value),
    rows = Array.isArray(data.items) ? data.items : [];
  const items = rows
    .filter((r: Json) => gptId(r.id))
    .map((r: Json) => ({
      id: r.id,
      title: text(r.title) || "Новый чат",
      pinned: r.is_starred === true || !!r.pinned_time,
      archived: r.is_archived === true,
      updatedAt:
        typeof r.update_time === "number"
          ? r.update_time
          : Date.parse(String(r.update_time)) / 1000 || 0,
      ...(gptId(r.gizmo_id) ? { projectId: r.gizmo_id } : {}),
    }));
  const offset = Number(data.offset) || 0;
  return {
    items,
    nextOffset:
      rows.length && offset + rows.length < Number(data.total) ? offset + rows.length : null,
  };
}
export function gptProjects(value: unknown): GptProject[] {
  const data = record(value),
    rows = Array.isArray(data.items) ? data.items : Array.isArray(data.gizmos) ? data.gizmos : [];
  return rows.flatMap((row: Json) => {
    const outer = record(row.gizmo ?? row),
      g = record(outer.gizmo ?? outer),
      id = g.id ?? row.id;
    const name = text(g.display?.name ?? g.name ?? row.title);
    return gptId(id) && name ? [{ id, name }] : [];
  });
}
export function gptHistory(value: unknown, conversationId?: string): GptMessage[] {
  const data = record(value),
    mapping = record(data.mapping),
    nodes: Json[] = [],
    visited = new Set<string>();
  let id = text(data.current_node);
  while (id && nodes.length < 20000 && !visited.has(id)) {
    visited.add(id);
    const node = record(mapping[id]);
    if (!Object.keys(node).length) break;
    nodes.push(node);
    id = text(node.parent);
  }
  return nodes.reverse().flatMap((node) => {
    const message = record(node.message),
      author = record(message.author),
      content = record(message.content),
      metadata = record(message.metadata);
    // Only the visible conversation. Analysis/thoughts/tool internals are never sent to the client.
    const generatedImage =
      author.role === "tool" &&
      message.channel === "final" &&
      typeof metadata.image_gen_title === "string";
    if (
      (!["user", "assistant"].includes(author.role) && !generatedImage) ||
      metadata.is_visually_hidden_from_conversation === true
    )
      return [];
    if (
      author.role === "assistant" &&
      ((message.channel && !["final", "commentary"].includes(message.channel)) ||
        (message.recipient && message.recipient !== "all") ||
        metadata.tool_invoking_message === true)
    )
      return [];
    // Some old native records omit channel: explicitly exclude private formats as well.
    const privateTypes = new Set([
      "thoughts",
      "reasoning",
      "reasoning_recap",
      "tool_call",
      "computer_output",
    ]);
    if (privateTypes.has(content.content_type)) return [];
    const unsupported = new Set<"audio" | "video" | "interactive" | "other">();
    const missing = (kind: unknown) => {
      if (typeof kind === "string" && privateTypes.has(kind)) return;
      unsupported.add(
        typeof kind !== "string"
          ? "other"
          : /audio/.test(kind)
            ? "audio"
            : /video/.test(kind)
              ? "video"
              : /canvas|widget|interactive/.test(kind)
                ? "interactive"
                : "other",
      );
    };
    if (
      typeof content.content_type === "string" &&
      content.content_type &&
      !["text", "multimodal_text"].includes(content.content_type)
    )
      missing(content.content_type);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    let body = generatedImage
      ? ""
      : gptLinkedText(
          parts.filter((part: unknown) => typeof part === "string").join("\n"),
          metadata,
        ).slice(0, 500000);
    const files = new Map<string, GptFile>();
    const add = (file: Json) => {
      if (!gptId(file.id)) return;
      const mime = text(file.mime_type ?? file.mime) || "application/octet-stream";
      files.set(file.id, {
        id: file.id,
        name: text(file.name) || "Изображение",
        mime,
        bytes: Number(file.size) || 0,
        image: mime.startsWith("image/"),
        url:
          data.codex_native_assets && conversationId
            ? `/api/gpt/native-assets/${encodeURIComponent(conversationId)}/${encodeURIComponent(text(message.id) || text(node.id))}/${encodeURIComponent(file.id)}`
            : "/api/gpt/assets/" + encodeURIComponent(file.id),
      });
    };
    for (const file of Array.isArray(metadata.attachments) ? metadata.attachments : [])
      add(record(file));
    for (const part of parts) {
      if (typeof part === "string") continue;
      const p = record(part);
      if (p.content_type !== "image_asset_pointer") {
        missing(p.content_type);
        continue;
      }
      const pointer = text(p.asset_pointer),
        fileId = pointer.replace(/^(?:sediment|file-service):\/\//, "");
      if (gptId(fileId))
        add({ id: fileId, mime_type: "image/png", size: p.size_bytes, name: "Изображение" });
      else missing("image");
    }
    if (author.role === "assistant") {
      const linked = gptSandboxFiles(
        body,
        conversationId ?? text(data.conversation_id ?? data.id),
        text(message.id) || text(node.id),
      );
      body = linked.text;
      for (const file of linked.files) files.set(file.id, file);
    }
    return body || files.size || unsupported.size
      ? [
          {
            id: text(message.id) || text(node.id),
            role: (generatedImage ? "assistant" : author.role) as "user" | "assistant",
            text: body,
            createdAt: Number(message.create_time) || 0,
            ...(["search", "review", "code", "image", "tool"].includes(metadata.codex_activity)
              ? { activity: metadata.codex_activity as GptMessage["activity"] }
              : {}),
            ...(author.role === "assistant"
              ? {
                  phase:
                    message.channel === "commentary" ? ("commentary" as const) : ("final" as const),
                  complete:
                    message.status === "finished_successfully" && metadata.is_complete !== false,
                }
              : {}),
            files: [...files.values()],
            ...(unsupported.size ? { unsupported: [...unsupported] } : {}),
          },
        ]
      : [];
  });
}

export function gptCompletion(
  value: unknown,
  prompt: string,
  createdAt: number,
): { complete: boolean; messages: GptMessage[] } {
  const data = record(value),
    mapping = record(data.mapping),
    nodes: Json[] = [];
  let id = text(data.current_node);
  const seen = new Set<string>();
  while (id && !seen.has(id) && nodes.length < 20000) {
    seen.add(id);
    const node = record(mapping[id]);
    nodes.push(node);
    id = text(node.parent);
  }
  const user = nodes.findIndex((node) => node.message?.author?.role === "user");
  if (user < 0) return { complete: false, messages: [] };
  const message = record(nodes[user]?.message);
  const parts = Array.isArray(message.content?.parts) ? message.content.parts : [];
  const userText = parts.filter((p: unknown) => typeof p === "string").join("\n");
  if (userText !== prompt || Number(message.create_time) * 1000 < createdAt - 30000)
    return { complete: false, messages: [] };
  const complete = nodes.slice(0, user).some((node) => {
    const m = record(node.message);
    return (
      m.author?.role === "assistant" &&
      m.channel === "final" &&
      m.metadata?.is_complete === true &&
      m.status === "finished_successfully"
    );
  });
  const normalized = gptHistory(value),
    index = normalized.findIndex((m) => m.id === message.id);
  return { complete, messages: index < 0 ? [] : normalized.slice(index + 1) };
}

export function gptProjectConversations(value: unknown): GptConversation[] {
  const data = record(value);
  return (Array.isArray(data.items) ? data.items : []).flatMap(
    (row) => gptCatalog(record(row).conversations).items,
  );
}
