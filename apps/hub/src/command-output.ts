import { stripVTControlCharacters } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";

/** Read the exact stored command event only on expansion, including older result cards. */
export function registerCommandOutput(app: FastifyInstance, sessions: Sessions) {
  app.get("/api/threads/:id/results/:resultId/output", async (req) => {
    const p = z
      .object({ id: z.string().min(1).max(100), resultId: z.string().uuid() })
      .parse(req.params);
    sessions.thread(p.id);
    const result = sessions.store.resultById(p.id, p.resultId) as {
      type: string;
      turnId: string | null;
      sourceKey: string;
      payload: { command?: string };
    };
    if (result.type !== "check" || !result.payload.command)
      return { available: false, text: null, truncated: false };
    const row = sessions.store.db
      .prepare(
        "SELECT payload FROM events WHERE threadId=? AND turnId IS ? AND type='activity.command' AND (json_extract(payload,'$.itemId')=? OR json_extract(payload,'$.id')=?) ORDER BY seq DESC LIMIT 1",
      )
      .get(p.id, result.turnId, result.sourceKey, result.sourceKey);
    const event = row ? JSON.parse(String(row.payload)) : null;
    if (typeof event?.output !== "string")
      return { available: false, text: null, truncated: false };
    return {
      available: true,
      text: stripVTControlCharacters(event.output.slice(0, 64000)),
      truncated: event.output.length >= 64000,
    };
  });
}
