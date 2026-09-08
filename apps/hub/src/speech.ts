import { createHash } from "node:crypto";
import { request } from "node:http";
import { type HubConfig, HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "./auth.js";

const limit = 64 * 1024 * 1024;
const ttl = 30 * 60 * 1000;
const bad = () =>
  new HubError(
    503,
    "SPEECH_UNAVAILABLE",
    "Не удалось подготовить озвучивание. Можно попробовать ещё раз.",
  );
export function speechWorker(
  socketPath: string,
  text: string | null,
  language: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = text === null ? undefined : Buffer.from(JSON.stringify({ text, language }));
    const req = request(
      {
        socketPath,
        path: text === null ? "/health" : "/synthesize",
        method: body ? "POST" : "GET",
        signal,
        headers: body ? { "Content-Type": "application/json", "Content-Length": body.length } : {},
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(bad());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (body ? limit : 4096)) {
            res.destroy();
            reject(bad());
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => reject(bad()));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (
            body &&
            (bytes.length < 44 ||
              bytes.toString("ascii", 0, 4) !== "RIFF" ||
              bytes.toString("ascii", 8, 12) !== "WAVE")
          ) {
            reject(bad());
            return;
          }
          resolve(bytes);
        });
      },
    );
    req.setTimeout(body ? 180000 : 2000, () => req.destroy());
    req.on("error", () => reject(bad()));
    req.end(body);
  });
}

type Clip = {
  owner: string;
  fingerprint: string;
  expires: number;
  controller: AbortController;
  ready: Promise<void>;
  bytes?: Buffer;
  failed?: boolean;
};
export class SpeechClips {
  private clips = new Map<string, Clip>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private render: (text: string, language: string, signal: AbortSignal) => Promise<Buffer>,
  ) {
    this.timer = setInterval(() => this.prune(), 60000);
    this.timer.unref();
  }
  private prune() {
    for (const [id, clip] of this.clips)
      if (clip.expires <= Date.now()) this.remove(id, clip.owner);
  }
  create(id: string, owner: string, text: string, language: string) {
    this.prune();
    const fingerprint = createHash("sha256")
      .update(language + "\0" + text)
      .digest("hex");
    const old = this.clips.get(id);
    if (old) {
      if (old.owner !== owner || old.fingerprint !== fingerprint)
        throw new HubError(409, "SPEECH_CONFLICT", "Озвучивание уже создано для другого ответа.");
      return;
    }
    if ([...this.clips.values()].some((clip) => !clip.bytes && !clip.failed))
      throw new HubError(409, "SPEECH_BUSY", "Дождись подготовки текущего озвучивания.");
    while (
      this.clips.size >= 3 ||
      [...this.clips.values()].reduce((sum, clip) => sum + (clip.bytes?.length ?? 0), 0) >
        32 * 1024 * 1024
    ) {
      const first = this.clips.entries().next().value;
      if (!first) break;
      this.remove(first[0], first[1].owner);
    }
    const controller = new AbortController();
    const clip: Clip = {
      owner,
      fingerprint,
      expires: Date.now() + ttl,
      controller,
      ready: Promise.resolve(),
    };
    this.clips.set(id, clip);
    clip.ready = this.render(
      text,
      language,
      AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
    )
      .then((bytes) => {
        if (bytes.length > limit) throw bad();
        if (!controller.signal.aborted) clip.bytes = bytes;
      })
      .catch(() => {
        clip.failed = true;
      });
  }
  async read(id: string, owner: string) {
    // The audio request starts in the original tap, concurrently with its CSRF-protected POST.
    for (let i = 0; i < 30 && !this.clips.has(id); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const clip = this.clips.get(id);
    if (!clip || clip.owner !== owner || clip.expires <= Date.now())
      throw new HubError(404, "SPEECH_NOT_FOUND", "Озвучивание истекло. Нажми на динамик ещё раз.");
    await clip.ready;
    if (clip.controller.signal.aborted || clip.failed || !clip.bytes) throw bad();
    clip.expires = Date.now() + ttl;
    return clip.bytes;
  }
  remove(id: string, owner: string) {
    const clip = this.clips.get(id);
    if (!clip || clip.owner !== owner) return;
    this.clips.delete(id);
    clip.controller.abort();
    clip.bytes = undefined;
  }
  close() {
    clearInterval(this.timer);
    for (const [id, clip] of this.clips) this.remove(id, clip.owner);
  }
}
export function registerSpeech(app: FastifyInstance, config: HubConfig, auth: Auth) {
  const socket = config.hub.speechSocket;
  const clips = new SpeechClips((text, language, signal) =>
    socket ? speechWorker(socket, text, language, signal) : Promise.reject(bad()),
  );
  app.addHook("onClose", async () => clips.close());
  app.get("/api/speech/status", async () => {
    if (!socket) return { available: false };
    try {
      await speechWorker(socket, null, "ru", AbortSignal.timeout(2500));
      return { available: true };
    } catch {
      return { available: false };
    }
  });
  app.post("/api/speech/:id", async (req, reply) => {
    if (!socket) throw bad();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { text, language } = z
      .object({
        text: z
          .string()
          .min(1)
          .max(30000)
          .refine((value) => !!value.trim()),
        language: z.enum(["ru", "en"]),
      })
      .strict()
      .parse(req.body);
    clips.create(id, auth.session(req).tokenHash, text, language);
    reply.code(202);
    return { ok: true };
  });
  app.delete("/api/speech/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    clips.remove(id, auth.session(req).tokenHash);
    return { ok: true };
  });
  app.get("/api/speech/:id/audio", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const owner = auth.session(req).tokenHash;
    const bytes = await clips.read(id, owner);
    auth.session(req); // A logout during synthesis must not release private audio.
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", "audio/wav");
    reply.header("Content-Disposition", "inline");
    const range = req.headers.range;
    if (!range) return reply.header("Content-Length", bytes.length).send(bytes);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
    const end =
      match?.[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    if (
      !match ||
      (!match[1] && !match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= bytes.length
    )
      return reply.code(416).header("Content-Range", `bytes */${bytes.length}`).send();
    return reply
      .code(206)
      .header("Content-Range", `bytes ${start}-${end}/${bytes.length}`)
      .header("Content-Length", end - start + 1)
      .send(bytes.subarray(start, end + 1));
  });
  return clips;
}
