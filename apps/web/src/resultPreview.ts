import type { ResultItem } from "@codex-web/shared";
import { previewKind } from "./FilePreview";

export function resultPreview(result: ResultItem) {
  if (result.type === "canvas") return { kind: "canvas", limit: 0 } as const;
  if (result.type === "preview") return { kind: "demo", limit: 0 } as const;
  if (!result.payload.url) return { kind: "card", limit: 0 } as const;
  const kind = previewKind({
    name: result.title,
    type: result.payload.mime ?? "",
    size: result.payload.bytes ?? 0,
  });
  return {
    kind,
    limit:
      kind === "text"
        ? 65536
        : kind === "html"
          ? 262144
          : kind === "pdf"
            ? 12 * 1024 * 1024
            : 32 * 1024 * 1024,
  };
}
