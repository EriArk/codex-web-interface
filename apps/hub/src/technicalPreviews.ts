import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { HubError, isFileSource } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  convertTechnical,
  technicalConverterVersion,
  technicalInputLimit,
} from "./technicalConvert.js";

export function registerTechnicalPreviews(
  app: FastifyInstance,
  auth: { session(req: FastifyRequest): { tokenHash: string } },
  shared = false,
) {
  const internal = randomUUID();
  const cache = new Map<string, { bytes: Buffer; expires: number }>();
  const active = new Map<string, AbortController>();
  let cacheBytes = 0;
  const discard = (key: string) => {
    const row = cache.get(key);
    if (row) cacheBytes -= row.bytes.length;
    cache.delete(key);
  };
  const expiry = setInterval(() => {
    for (const [key, row] of cache) if (row.expires < Date.now()) discard(key);
  }, 60000);
  expiry.unref();
  // The internal read still traverses ordinary authentication, workspace routing and source ACLs.
  // Bound streamed originals before inject collects them; this marker is never returned to clients.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.headers["x-technical-read"] !== internal) return payload;
    const tooLarge = () =>
      new HubError(413, "PREVIEW_TOO_LARGE", "Файл слишком большой для просмотра.");
    if (Number(reply.getHeader("content-length")) > technicalInputLimit) throw tooLarge();
    if (typeof payload === "string" || Buffer.isBuffer(payload)) {
      if (Buffer.byteLength(payload) > technicalInputLimit) throw tooLarge();
    } else if (payload instanceof Readable) {
      let size = 0;
      const bounded = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(size > technicalInputLimit ? tooLarge() : null, chunk);
        },
      });
      payload.on("error", (e) => bounded.destroy(e));
      bounded.on("close", () => payload.destroy());
      return payload.pipe(bounded);
    }
    return payload;
  });
  app.post(
    shared ? "/api/team/previews/technical" : "/api/previews/technical",
    { bodyLimit: 16384 },
    async (req, reply) => {
      const owner = auth.session(req).tokenHash;
      const input = z
        .object({
          source: z
            .object({ kind: z.literal("file"), download: z.string().refine(isFileSource) })
            .strict(),
          format: z.enum(["step", "iges"]),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      if (input.source.download.startsWith("/api/team/") !== shared)
        throw new HubError(400, "PREVIEW_SOURCE_SCOPE", "Неверный источник файла.");
      if (active.has(owner) || active.size >= 2)
        throw new HubError(429, "PREVIEW_BUSY", "Другой файл ещё обрабатывается.");
      const controller = new AbortController();
      active.set(owner, controller);
      const abort = () => controller.abort();
      req.raw.on("aborted", abort);
      reply.raw.on("close", abort);
      const timeout = setTimeout(abort, 60000);
      try {
        const readSource = () =>
          app.inject({
            method: "GET",
            url: input.source.download,
            headers: {
              cookie: req.headers.cookie ?? "",
              "x-workspace-id": String(req.headers["x-workspace-id"] ?? ""),
              "x-technical-read": internal,
            },
            signal: controller.signal,
          });
        const response = await readSource();
        if (response.statusCode !== 200 || response.rawPayload.length > technicalInputLimit)
          throw new HubError(404, "PREVIEW_SOURCE_UNAVAILABLE", "Исходный файл недоступен.");
        const digest = createHash("sha256").update(response.rawPayload).digest("hex");
        if (digest !== input.sha256)
          throw new HubError(409, "PREVIEW_SOURCE_CHANGED", "Файл изменился. Открой его заново.");
        // No lookup before source authorization and exact-byte verification, including on cache hits.
        const key = createHash("sha256")
          .update(
            [owner, input.source.download, digest, input.format, technicalConverterVersion].join(
              "\0",
            ),
          )
          .digest("hex");
        for (const [k, row] of cache) if (row.expires < Date.now()) discard(k);
        let bytes = cache.get(key)?.bytes;
        if (!bytes) {
          bytes = await convertTechnical(response.rawPayload, input.format, controller.signal);
          if (controller.signal.aborted) throw Error();
          // Permissions or a working/index file can change while the converter is running.
          const current = await readSource();
          if (current.statusCode !== 200)
            throw new HubError(404, "PREVIEW_SOURCE_UNAVAILABLE", "Исходный файл недоступен.");
          if (createHash("sha256").update(current.rawPayload).digest("hex") !== digest)
            throw new HubError(409, "PREVIEW_SOURCE_CHANGED", "Файл изменился. Открой его заново.");
          while (cache.size >= 8 || cacheBytes + bytes.length > 64 * 1024 * 1024)
            discard(cache.keys().next().value!);
          cache.set(key, { bytes, expires: Date.now() + 10 * 60000 });
          cacheBytes += bytes.length;
        }
        auth.session(req);
        if (controller.signal.aborted) throw Error();
        return reply
          .header("Cache-Control", "private, no-store")
          .type("application/json")
          .send(bytes);
      } catch (error) {
        if (error instanceof HubError) throw error;
        throw new HubError(
          422,
          "PREVIEW_CONVERSION_FAILED",
          "Не удалось построить модель в пределах лимита просмотра. Исходный файл можно скачать.",
        );
      } finally {
        clearTimeout(timeout);
        active.delete(owner);
        req.raw.off("aborted", abort);
        reply.raw.off("close", abort);
      }
    },
  );
  app.addHook("onClose", async () => {
    clearInterval(expiry);
    for (const c of active.values()) c.abort();
    cache.clear();
    cacheBytes = 0;
  });
}
