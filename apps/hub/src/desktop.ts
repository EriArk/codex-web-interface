import { controlDesktop, type DesktopState, desktopError } from "@codex-web/machines";
import { type HubConfig, HubError, isActiveThread, type MachineConfig } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";
import type { Store } from "./store.js";

export type DesktopTransport = (
  machine: MachineConfig,
  action: "Status" | "Restart",
  id?: string,
) => Promise<DesktopState>;
export function registerDesktop(
  app: FastifyInstance,
  config: HubConfig,
  store: Store,
  sessions: Sessions,
  transport: DesktopTransport = controlDesktop,
) {
  const busy = new Set<string>();
  const machine = (params: unknown) => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(params);
    const m = config.machines.find((m) => m.id === id);
    if (!m) throw new HubError(404, "MACHINE_NOT_FOUND", "Компьютер не найден");
    if (m.type !== "ssh-windows" || !m.codex.desktopControl)
      throw desktopError("DESKTOP_CONTROL_UNAVAILABLE");
    return m;
  };
  const active = (id: string) =>
    sessions.catalog
      .projects()
      .filter((p) => p.machineId === id)
      .reduce(
        (count, p) =>
          count +
          store
            .threads(p.id)
            .filter((t) => isActiveThread(t.status) && t.activitySource !== "external").length,
        0,
      );
  app.get("/api/machines/:id/desktop", async (req) => {
    const m = machine(req.params),
      state = await transport(m, "Status");
    return { ...state, activeTasks: Math.max(state.activeTasks, active(m.id)) };
  });
  app.post(
    "/api/machines/:id/desktop/restart",
    { config: { rateLimit: { max: 4, timeWindow: "1 minute" } } },
    async (req) => {
      const m = machine(req.params),
        key = z.string().uuid().parse(req.headers["idempotency-key"]);
      const body = z
        .object({ confirm: z.literal(true) })
        .strict()
        .parse(req.body);
      if (busy.has(m.id)) throw desktopError("DESKTOP_RESTART_PENDING");
      busy.add(m.id);
      try {
        return await store.once("desktop-restart:" + m.id, key, body, async () => {
          // Windows repeats the complete native activity check in the scheduled user-session task.
          if (active(m.id)) throw desktopError("DESKTOP_BUSY");
          const state = await transport(m, "Status");
          if (!state.activityKnown) throw desktopError("DESKTOP_ACTIVITY_UNAVAILABLE");
          if (state.activeTasks) throw desktopError("DESKTOP_BUSY");
          return transport(m, "Restart", key);
        });
      } finally {
        busy.delete(m.id);
      }
    },
  );
}
