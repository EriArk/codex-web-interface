import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PREVIEW_LIMIT, previewPath, readMachinePreview } from "@codex-web/machines";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { previewControls } from "./previewControls.js";
import type { Store, ThreadRecord } from "./store.js";

export const previewFrameSources = (origin: string) => [
  origin.replace(/\/$/, "") + "/api/previews/",
  origin.replace(/\/$/, "") + "/api/gpt/previews/",
];
export function assertPreviewFrame(headers: Record<string, unknown>) {
  if (headers["sec-fetch-dest"] !== "iframe" || headers["sec-fetch-site"] !== "same-origin")
    throw new HubError(403, "PREVIEW_FRAME_REQUIRED", "Открой демо из результатов.");
}
export const previewCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";
type Source = { title: string; path?: string; html?: string };
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function previewSources(item: Record<string, unknown>): Source[] {
  const sources: Source[] = [];
  if (item.type === "fileChange" && Array.isArray(item.changes))
    for (const change of item.changes) {
      const path = text(obj(change).path);
      if (
        /\.html?$/i.test(path) &&
        !["delete", "remove"].includes(text(obj(obj(change).kind).type) || text(obj(change).kind))
      )
        sources.push({ path, title: path.split(/[\\/]/).at(-1) || "Демо" });
    }
  if (item.type === "mcpToolCall" && Array.isArray(obj(item.result).content)) {
    for (const block of obj(item.result).content as unknown[]) {
      const resource = obj(obj(block).resource);
      if (
        obj(block).type === "resource" &&
        text(resource.mimeType).split(";")[0] === "text/html" &&
        typeof resource.text === "string"
      )
        sources.push({ title: "Интерактивное демо", html: resource.text });
    }
  }
  if (item.type === "agentMessage") {
    const body = text(item.text);
    for (const match of body.matchAll(
      /(?:^|\n)(?:\x60{3}|~{3})html[ \t]*\r?\n([\s\S]*?)\r?\n(?:\x60{3}|~{3})(?=\s|$)/gi,
    ))
      if (/<(?:html|div|main|section|body|canvas|svg)\b/i.test(match[1] ?? ""))
        sources.push({ title: "Интерактивное демо", html: match[1] });
    // Markdown links produced by Codex; external URLs are intentionally not local previews.
    for (const match of body.matchAll(/\[([^\]\n]{1,200})\]\((?:<([^>\n]+)>|([^\s)]+))\)/g)) {
      const path = (match[2] || match[3] || "").replace(/:\d+(?::\d+)?$/, "");
      if (/\.html?$/i.test(path) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
        sources.push({ title: match[1] || "Демо", path });
    }
  }
  return sources.slice(0, 8);
}
export class Previews {
  private pending = new Map<string, Promise<string>>();
  constructor(
    readonly root: string,
    readonly store: Store,
    private target: (threadId: string) => { machine: MachineConfig; root: string },
  ) {}
  inline(scope: string, itemId: string, html: string): string | undefined {
    if (!html || Buffer.byteLength(html) > PREVIEW_LIMIT) return;
    const source = { title: "Интерактивное демо", html };
    const id = createHash("sha256")
      .update(JSON.stringify([scope, itemId, source]))
      .digest("hex");
    if (
      !this.store.db.prepare("SELECT 1 FROM html_previews WHERE id=?").get(id) &&
      Number(this.store.db.prepare("SELECT count(*) AS n FROM html_previews").get()?.n) >= 2000
    )
      return;
    this.store.db
      .prepare("INSERT OR IGNORE INTO html_previews VALUES(?,?,?,?)")
      .run(id, scope, JSON.stringify(source), new Date().toISOString());
    return id;
  }
  observe(thread: ThreadRecord, turnId: string | null, item: Record<string, unknown>): string[] {
    const results: string[] = [];
    for (const source of previewSources(item)) {
      if (source.html && Buffer.byteLength(source.html) > PREVIEW_LIMIT) continue;
      try {
        if (source.path) {
          const target = this.target(thread.id);
          source.path = previewPath(target.machine, target.root, source.path);
        }
      } catch {
        continue;
      }
      const id = createHash("sha256")
        .update(JSON.stringify([thread.id, item.id, source]))
        .digest("hex");
      const old = this.store.db.prepare("SELECT 1 FROM html_previews WHERE id=?").get(id);
      if (
        !old &&
        Number(this.store.db.prepare("SELECT count(*) AS n FROM html_previews").get()?.n) >= 2000
      )
        continue;
      this.store.db
        .prepare("INSERT OR IGNORE INTO html_previews VALUES(?,?,?,?)")
        .run(id, thread.id, JSON.stringify(source), new Date().toISOString());
      const result = this.store.result(
        thread.id,
        turnId,
        "html:" + id,
        "preview",
        source.title.slice(0, 200),
        { url: "/api/previews/" + id, ...(source.path ? { sourcePath: source.path } : {}) },
      );
      if (result) results.push(result);
    }
    return results;
  }
  thread(id: string): string {
    const row = this.store.db.prepare("SELECT threadId FROM html_previews WHERE id=?").get(id);
    if (!row) throw new HubError(404, "PREVIEW_NOT_FOUND", "Демо не найдено.");
    return String(row.threadId);
  }
  async document(id: string): Promise<string> {
    const row = this.store.db.prepare("SELECT * FROM html_previews WHERE id=?").get(id);
    if (!row) throw new HubError(404, "PREVIEW_NOT_FOUND", "Демо не найдено.");
    const pending = this.pending.get(id);
    if (pending) return pending;
    if (this.pending.size >= 4)
      throw new HubError(429, "PREVIEW_BUSY", "Другое демо ещё загружается.");
    const action = (async () => {
      const file = join(this.root, id + ".html");
      let html: string;
      try {
        html = await readFile(file, "utf8");
      } catch {
        const source = JSON.parse(String(row.source)) as Source;
        const bytes = source.html
          ? Buffer.from(source.html)
          : await (async () => {
              const target = this.target(String(row.threadId));
              return readMachinePreview(target.machine, target.root, source.path ?? "");
            })();
        if (bytes.length > PREVIEW_LIMIT)
          throw new HubError(413, "PREVIEW_TOO_LARGE", "Демо больше 2 МБ.");
        html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await writeFile(file, html, { mode: 0o600 });
      }
      // Prefix works for full documents as well as visualize-style HTML fragments.
      return (
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;}body{padding:12px;box-sizing:border-box;background:#fff;color:#202624}</style>' +
        previewControls +
        html
      );
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, action);
    return action;
  }
}
