import type { ResultItem } from "@codex-web/shared";
import { previewCapability } from "./filePreviewRegistry";

export function resultPreview(result: ResultItem) {
  if (result.type === "preview") return { kind: "demo", limit: 0 } as const;
  if (!result.payload.url) return { kind: "card", limit: 0 } as const;
  const capability = previewCapability({
    name: result.title,
    type: result.payload.mime ?? "",
    size: result.payload.bytes ?? 0,
  });
  const kind = capability?.kind ?? "card";
  return {
    kind,
    limit: capability?.maxBytes ?? 0,
  };
}
