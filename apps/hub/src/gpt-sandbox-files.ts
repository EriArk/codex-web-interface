import { createHash } from "node:crypto";
import type { GptFile } from "@codex-web/shared";

const id = /^[a-zA-Z0-9_-]{1,100}$/;
const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  py: "text/x-python",
  pdf: "application/pdf",
  zip: "application/zip",
  html: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
};
export function gptSandboxFiles(body: string, conversationId: string, messageId: string) {
  const files = new Map<string, GptFile>(),
    paths = new Map<string, string>();
  if (!id.test(conversationId) || !id.test(messageId)) return { text: body, files: [], paths };
  const destination = (raw: string) => {
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      return;
    }
    if (
      !path.startsWith("/mnt/data/") ||
      path.length > 2048 ||
      /[\\?#%]/.test(path) ||
      [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      path
        .slice(1)
        .split("/")
        .some((p) => !p || p === "." || p === "..")
    )
      return;
    const key =
      "sandbox-" +
      createHash("sha256")
        .update(JSON.stringify([conversationId, messageId, path]))
        .digest("hex");
    const name = path.split("/").at(-1) ?? "Файл";
    const mime =
      mimeTypes[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
    const url = `/api/gpt/downloads/${conversationId}/${messageId}/${key}`;
    files.set(key, { id: key, name, mime, bytes: 0, image: mime.startsWith("image/"), url });
    paths.set(key, path);
    return url;
  };
  // Leave fenced and inline code unchanged, including examples of sandbox links.
  let fence = "";
  const text = body
    .split(/(?<=\n)/)
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker?.[1]) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
        return line;
      }
      if (fence) return line;
      return line.replace(
        /(`+).*?\1|(\]\(\s*)(?:<sandbox:([^>\r\n]+)>|sandbox:([^\s)]+))(\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
        (match, code, prefix, angle, plain, title) => {
          if (code) return match;
          const url = destination(angle ?? plain);
          return url ? prefix + url + (title ?? "") + ")" : match;
        },
      );
    })
    .join("");
  return { text, files: [...files.values()], paths };
}
