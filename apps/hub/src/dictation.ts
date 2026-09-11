import { createHash } from "node:crypto";
import { type HubConfig, HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "./auth.js";

export const DICTATION_BYTES = 6 * 1024 * 1024;
export type Transcribe = (bytes: Buffer, signal: AbortSignal, mime: string) => Promise<string>;
const unavailable = () =>
  new HubError(
    503,
    "DICTATION_UNAVAILABLE",
    "Распознавание сейчас недоступно. Запись можно повторно обработать.",
  );
type Job = {
  owner: string;
  fingerprint: string;
  state: "running" | "completed" | "failed";
  text: string;
  expires: number;
  controller: AbortController;
};
export class DictationJobs {
  private jobs = new Map<string, Job>();
  private timer = setInterval(() => this.sweep(), 30000);
  constructor(private transcribe: Transcribe) {
    this.timer.unref();
  }
  private sweep() {
    for (const [id, j] of this.jobs) if (j.expires <= Date.now()) this.remove(id, j.owner);
  }
  create(id: string, owner: string, bytes: Buffer, mime = "audio/wav") {
    this.sweep();
    const fingerprint = createHash("sha256").update(mime).update(bytes).digest("hex"),
      old = this.jobs.get(id);
    if (old) {
      if (old.owner !== owner || old.fingerprint !== fingerprint)
        throw new HubError(409, "DICTATION_CONFLICT", "Эта запись относится к другой попытке.");
      return;
    }
    if ([...this.jobs.values()].some((j) => j.state === "running"))
      throw new HubError(
        409,
        "DICTATION_BUSY",
        "Сервер распознаёт другую запись. Попробуй ещё раз немного позже.",
      );
    if (this.jobs.size >= 32) throw unavailable();
    const job: Job = {
      owner,
      fingerprint,
      state: "running",
      text: "",
      expires: Date.now() + 900000,
      controller: new AbortController(),
    };
    this.jobs.set(id, job);
    const timeout = setTimeout(() => {
      job.state = "failed";
      job.controller.abort();
    }, 300000);
    timeout.unref();
    void Promise.resolve()
      .then(() => this.transcribe(bytes, job.controller.signal, mime))
      .then((text) => {
        if (typeof text !== "string" || text.length > 32000) throw unavailable();
        if (!job.controller.signal.aborted) {
          job.text = text;
          job.state = "completed";
        }
      })
      .catch(() => {
        job.state = "failed";
      })
      .finally(() => {
        clearTimeout(timeout);
        if (job.controller.signal.aborted) job.state = "failed";
      });
  }
  read(id: string, owner: string) {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner)
      throw new HubError(
        404,
        "DICTATION_MISSING",
        "Запись больше не хранится на сервере. Повтори обработку.",
      );
    return { state: job.state, text: job.state === "completed" ? job.text : "" };
  }
  remove(id: string, owner: string) {
    const j = this.jobs.get(id);
    if (j?.owner === owner) {
      j.controller.abort();
      j.text = "";
      this.jobs.delete(id);
    }
  }
  close() {
    clearInterval(this.timer);
    for (const [id, j] of this.jobs) this.remove(id, j.owner);
  }
}
export function registerDictation(
  app: FastifyInstance,
  config: HubConfig,
  auth: Auth,
  transcribe?: Transcribe,
) {
  const endpoint = config.gpt?.endpoint;
  const token = config.gpt ? process.env[config.gpt.tokenSecret] : undefined;
  const native = async (bytes: Buffer, signal: AbortSignal, mime: string) => {
    if (!endpoint || !token) throw unavailable();
    const response = await fetch(new URL("/dictation", endpoint), {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ audio: bytes.toString("base64"), mime }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const value = (await response.json()) as { text?: unknown };
    if (typeof value.text !== "string" || value.text.length > 32000) throw unavailable();
    return value.text;
  };
  const jobs = new DictationJobs(transcribe ?? native);
  app.addHook("onClose", async () => jobs.close());
  const id = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.get("/api/dictation/status", async () => {
    if (transcribe) return { available: true };
    if (!endpoint || !token) return { available: false };
    try {
      const response = await fetch(new URL("/status", endpoint), {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(3000),
      });
      const value = (await response.json()) as { login?: string };
      return { available: response.ok && value.login === "authenticated" };
    } catch {
      return { available: false };
    }
  });
  app.post("/api/dictation/:id", { bodyLimit: DICTATION_BYTES }, async (req, reply) => {
    if ((!endpoint || !token) && !transcribe) throw unavailable();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > DICTATION_BYTES)
      throw new HubError(400, "DICTATION_AUDIO", "Не удалось прочитать запись.");
    const mime = z
      .enum(["audio/wav", "audio/webm", "audio/mp4", "audio/ogg"])
      .parse((req.query as { mime?: unknown }).mime);
    jobs.create(id(req.params), auth.session(req).tokenHash, req.body, mime);
    return reply.code(202).send({ accepted: true });
  });
  app.get("/api/dictation/:id", async (req) =>
    jobs.read(id(req.params), auth.session(req).tokenHash),
  );
  app.delete("/api/dictation/:id", async (req) => {
    jobs.remove(id(req.params), auth.session(req).tokenHash);
    return { ok: true };
  });
  return jobs;
}
