import { randomUUID } from "node:crypto";
import { HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "./auth.js";
import { assertPreviewFrame, previewCsp, previewMarkup } from "./previews.js";

// Short-lived renderings of bytes the owner already opened through authenticated file routes.
// This is not a file-reading API and never resolves a supplied URL or machine path.
export function registerFilePreviews(app: FastifyInstance, auth: Auth) {
  const frames = new Map<string, { owner: string; html: string; expires: number }>();
  const prune = () => {
    for (const [id, frame] of frames) if (frame.expires < Date.now()) frames.delete(id);
  };
  app.post("/api/previews/file", { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const owner = auth.session(req).tokenHash;
    const { html } = z
      .object({ html: z.string().min(1).max(262144) })
      .strict()
      .parse(req.body);
    if (Buffer.byteLength(html) > 262144)
      throw new HubError(413, "PREVIEW_TOO_LARGE", "Предпросмотр слишком большой.");
    prune();
    if (frames.size >= 16) throw new HubError(429, "PREVIEW_BUSY", "Предпросмотр занят.");
    const id = randomUUID();
    frames.set(id, { owner, html: previewMarkup(html), expires: Date.now() + 10 * 60000 });
    return { url: "/api/previews/file/" + id };
  });
  app.get("/api/previews/file/:id", async (req, reply) => {
    assertPreviewFrame(req.headers);
    prune();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const frame = frames.get(id);
    if (!frame || frame.owner !== auth.session(req).tokenHash)
      throw new HubError(404, "PREVIEW_NOT_FOUND", "Предпросмотр недоступен.");
    return reply
      .header("Content-Security-Policy", previewCsp)
      .removeHeader("X-Frame-Options")
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
      .type("text/html; charset=utf-8")
      .send(frame.html);
  });
  app.delete("/api/previews/file/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (frames.get(id)?.owner === auth.session(req).tokenHash) frames.delete(id);
    return { ok: true };
  });
  app.addHook("onClose", async () => {
    frames.clear();
  });
}
