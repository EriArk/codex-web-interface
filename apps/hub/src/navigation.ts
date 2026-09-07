import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { Auth } from "./auth.js";
import type { Sessions } from "./sessions.js";
import type { Store } from "./store.js";

export function registerNavigation(
  app: FastifyInstance,
  store: Store,
  sessions: Sessions,
  auth: Auth,
  sockets: Map<WebSocket, string>,
): void {
  const snapshot = () => ({
    ...store.navigation(sessions.catalog.projects().map((p) => p.id)),
    library: sessions.catalog.library.all().map((e) => ({
      ...e,
      ...(e.kind === "thread" ? { id: e.localId ?? store.threadByCodex(e.id)?.id ?? e.id } : {}),
    })),
    warnings: [...(sessions.externalActivity?.errors?.values() ?? [])],
  });
  app.get("/api/navigation", async () => snapshot());
  app.post("/api/threads/:id/seen", async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const { completedSeq } = z
      .object({ completedSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .parse(req.body);
    sessions.thread(id);
    store.markSeen(id, completedSeq);
    return { ok: true };
  });
  app.get(
    "/api/navigation/events",
    {
      websocket: true,
      preValidation: async (req) => {
        auth.requireOrigin(req);
        auth.session(req);
      },
    },
    (socket, req) => {
      const session = auth.session(req);
      sockets.set(socket, session.tokenHash);
      const unwatch = sessions.externalActivity?.watch();
      let pending: ReturnType<typeof setTimeout> | undefined;
      let previous = "";
      const send = () => {
        pending = undefined;
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.close(1013, "Refresh navigation");
          return;
        }
        const data = JSON.stringify(snapshot());
        if (data !== previous) {
          socket.send(data);
          previous = data;
        }
      };
      const schedule = () => {
        if (!pending) pending = setTimeout(send, 80);
      };
      store.changes.on("navigation", schedule);
      send();
      const timer = setInterval(() => {
        try {
          auth.session(req);
        } catch {
          socket.close(1008, "Session expired");
          return;
        }
        // Also reconcile catalog changes which did not touch a thread.
        send();
        if (socket.readyState === 1) socket.ping();
      }, 25000);
      timer.unref();
      socket.once("close", () => {
        unwatch?.();
        clearInterval(timer);
        clearTimeout(pending);
        store.changes.off("navigation", schedule);
        sockets.delete(socket);
      });
      socket.on("error", () => socket.close());
      socket.on("message", () => socket.close(1008, "Read-only stream"));
    },
  );
}
