export type PreviewKind =
  | "image"
  | "pdf"
  | "html"
  | "text"
  | "technical"
  | "audio"
  | "video"
  | "package"
  | "card";
export type TechnicalFormat =
  | "step"
  | "iges"
  | "stl"
  | "dxf"
  | "svg"
  | "obj"
  | "3mf"
  | "gltf"
  | "glb";
const MiB = 1024 * 1024;
const technicalMime: Record<string, TechnicalFormat> = {
  "image/svg+xml": "svg",
  "model/stl": "stl",
  "application/sla": "stl",
  "model/step": "step",
  "application/step": "step",
  "model/iges": "iges",
  "application/iges": "iges",
  "image/vnd.dxf": "dxf",
  "application/dxf": "dxf",
  "model/obj": "obj",
  "model/3mf": "3mf",
  "model/gltf+json": "gltf",
  "model/gltf-binary": "glb",
};
/** Full viewers and cheap list thumbnails are deliberately separate capabilities. */
export const filePreviewHandlers = [
  {
    kind: "package",
    extensions: /\.(zip|docx|xlsx)$/i,
    mime: /^application\/(zip|x-zip-compressed|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))$/,
    maxBytes: 32 * MiB,
    thumbnail: false,
    mobile: true,
    isolation: "worker",
  },
  {
    kind: "technical",
    extensions: /\.(stp|step|igs|iges|stl|dxf|svg|obj|3mf|glb|gltf)$/i,
    mime: /^(image\/(svg\+xml|vnd.dxf)|model\/(stl|step|iges|obj|3mf|gltf\+json|gltf-binary)|application\/(sla|step|iges|dxf))$/,
    maxBytes: 32 * MiB,
    thumbnail: false,
    mobile: true,
    isolation: "bounded-parser",
  },
  {
    kind: "image",
    extensions: /\.(png|jpe?g|gif|webp|avif)$/i,
    mime: /^image\/(png|jpeg|gif|webp|avif)$/,
    maxBytes: 32 * MiB,
    thumbnail: true,
    mobile: true,
    isolation: "image",
  },
  {
    kind: "pdf",
    extensions: /\.pdf$/i,
    mime: /^application\/pdf$/,
    maxBytes: 12 * MiB,
    thumbnail: false,
    mobile: true,
    isolation: "worker",
  },
  {
    kind: "html",
    extensions: /\.html?$/i,
    mime: /^text\/html$/,
    maxBytes: 262144,
    thumbnail: false,
    mobile: true,
    isolation: "sandbox",
  },
  {
    kind: "audio",
    extensions: /\.(mp3|wav|ogg|m4a)$/i,
    mime: /^audio\/(mpeg|wav|ogg|mp4)$/,
    maxBytes: 32 * MiB,
    thumbnail: false,
    mobile: true,
    isolation: "media",
  },
  {
    kind: "video",
    extensions: /\.(mp4|webm)$/i,
    mime: /^video\/(mp4|webm)$/,
    maxBytes: 32 * MiB,
    thumbnail: false,
    mobile: true,
    isolation: "media",
  },
  {
    kind: "text",
    extensions:
      /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|toml|ini|cfg|py|js|jsx|ts|tsx|css|scss|sql|sh|ps1|c|cpp|h|rs|go|java|rb|php|bat|env)$|^(readme|license|licence|copying|makefile|dockerfile|\.gitignore|\.gitattributes|\.editorconfig)$/i,
    mime: /^(text\/|application\/json$)/,
    maxBytes: 65536,
    thumbnail: false,
    mobile: true,
    isolation: "escaped-text",
  },
] as const;
export function technicalFormat(file: Pick<File, "name" | "type">): TechnicalFormat | null {
  const ext = file.name.split(".").at(-1)?.toLowerCase();
  if (ext === "stp" || ext === "step") return "step";
  if (ext === "igs" || ext === "iges") return "iges";
  if (["stl", "dxf", "svg", "obj", "3mf", "gltf", "glb"].includes(ext ?? ""))
    return ext as TechnicalFormat;
  return technicalMime[file.type] ?? null;
}
export function previewCapability(file: Pick<File, "name" | "type" | "size">) {
  if (/\.(exe|dll|com|msi|7z|rar|bin|iso|doc|xls|ppt|pptx|docm|xlsm|pptm)$/i.test(file.name))
    return null;
  const handler = filePreviewHandlers.find(
    (h) => h.extensions.test(file.name) || h.mime.test(file.type),
  );
  if (!handler) return null;
  const format = technicalFormat(file);
  const maxBytes = format === "svg" ? MiB : format === "dxf" ? 2 * MiB : handler.maxBytes;
  if (handler.kind !== "text" && file.size > maxBytes) return null;
  return { ...handler, maxBytes, format, serverConversion: format === "step" || format === "iges" };
}
export function previewKind(file: Pick<File, "name" | "type" | "size">): PreviewKind {
  return previewCapability(file)?.kind ?? "card";
}
