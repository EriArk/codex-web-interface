import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";

// Process-local marker, never returned to a browser. Bound a private canonical read before
// inject buffers it, including native streams whose metadata has no declared size.
export const resultCaptureMarker = randomUUID();
export function installResultCaptureLimit(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.headers["x-result-capture"] !== resultCaptureMarker) return payload;
    const limit = 32 * 1024 ** 2;
    const large = () => new HubError(413, "SHARE_TOO_LARGE", "Материал больше 32 МБ.");
    if (Number(reply.getHeader("content-length")) > limit) throw large();
    if (typeof payload === "string" || Buffer.isBuffer(payload)) {
      if (Buffer.byteLength(payload) > limit) throw large();
    } else if (payload instanceof Readable) {
      let bytes = 0;
      const bounded = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(bytes > limit ? large() : null, chunk);
        },
      });
      payload.on("error", (e) => bounded.destroy(e));
      bounded.on("close", () => payload.destroy());
      return payload.pipe(bounded);
    }
    return payload;
  });
}
