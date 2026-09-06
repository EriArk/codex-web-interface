import { controlDesktop, type DesktopState, desktopError } from "@codex-web/machines";
import { type HubConfig, HubError, isActiveThread, type MachineConfig } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";
import type { Store } from "./store.js";

export type DesktopTransport = (
  machine: MachineConfig,
  action: "Status" | "Restart" | "ForceRestart" | "ForceRelease",
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
  const pendingReturns = () =>
    (store.preferences().desktopReturns ?? {}) as Record<
      string,
      { id: string; requestedAt: number }
    >;
  const clearReturn = (id: string) => {
    const pending = { ...pendingReturns() };
    delete pending[id];
    store.setPreferences({ desktopReturns: pending });
  };
  const reconcileReturn = async (m: MachineConfig, state: DesktopState) => {
    const pending = pendingReturns()[m.id];
    if (!pending) return;
    if (state.operation?.id === pending.id && state.operation.kind === "forcerelease") {
      if (
        state.operation.state === "completed" &&
        state.operation.code === "DESKTOP_RELEASED" &&
        !state.running
      ) {
        clearReturn(m.id);
        await sessions.setMachineClient(m.id, "web");
      } else if (["failed", "unknown"].includes(state.operation.state)) clearReturn(m.id);
    }
    if (Date.now() - pending.requestedAt > 120000) clearReturn(m.id);
  };
  let closing = false;
  let checkingReturns: Promise<void> | undefined;
  const checkReturns = () => {
    if (closing || checkingReturns) return checkingReturns;
    checkingReturns = (async () => {
      for (const m of config.machines.filter((m) => pendingReturns()[m.id])) {
        if (closing || busy.has(m.id)) continue;
        try {
          await reconcileReturn(m, await transport(m, "Status"));
        } catch {
          const pending = pendingReturns()[m.id];
          if (pending && Date.now() - pending.requestedAt > 120000) clearReturn(m.id);
        }
      }
    })().finally(() => {
      checkingReturns = undefined;
    });
    return checkingReturns;
  };
  const returnTimer = setInterval(() => void checkReturns(), 4000);
  returnTimer.unref();
  app.addHook("preClose", async () => {
    closing = true;
    clearInterval(returnTimer);
    await checkingReturns;
  });
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
    await reconcileReturn(m, state);
    return {
      ...state,
      client: sessions.machineClient(m.id),
      returning: !!pendingReturns()[m.id],
      webActiveTasks: active(m.id),
      activeTasks: Math.max(state.activeTasks, active(m.id)),
    };
  });
  app.post("/api/machines/:id/client", async (req) => {
    const m = machine(req.params),
      key = z.string().uuid().parse(req.headers["idempotency-key"]);
    const body = z
      .discriminatedUnion("client", [
        z
          .object({ client: z.literal("desktop"), confirmInterrupt: z.literal(true).optional() })
          .strict(),
        z
          .object({
            client: z.literal("web"),
            releaseDesktop: z.literal(true).optional(),
            confirmStopTasks: z.literal(true).optional(),
          })
          .strict(),
      ])
      .parse(req.body);
    if (busy.has(m.id)) throw desktopError("DESKTOP_RESTART_PENDING");
    busy.add(m.id);
    try {
      return await store.once("machine-client:" + m.id, key, body, async () => {
        if (pendingReturns()[m.id])
          throw new HubError(409, "HANDOFF_PENDING", "Передача управления ещё выполняется.");
        if (body.client === "desktop") {
          await sessions.handoffToDesktop(m.id, body.confirmInterrupt);
          return { client: sessions.machineClient(m.id) };
        }
        if (body.releaseDesktop !== body.confirmStopTasks)
          throw new HubError(400, "CONFIRM_STOP_REQUIRED", "Подтверди закрытие настольного Codex.");
        if (body.releaseDesktop) {
          store.setPreferences({
            desktopReturns: { ...pendingReturns(), [m.id]: { id: key, requestedAt: Date.now() } },
          });
          let state: DesktopState;
          try {
            state = await transport(m, "ForceRelease", key);
          } catch (error) {
            // These native rejections happen before queuing. Unknown outcomes remain recoverable.
            if (
              error instanceof HubError &&
              ["DESKTOP_RESTART_COOLDOWN", "DESKTOP_RESTART_PENDING"].includes(error.code)
            )
              clearReturn(m.id);
            throw error;
          }
          await reconcileReturn(m, state);
          return {
            ...state,
            client: sessions.machineClient(m.id),
            returning: !!pendingReturns()[m.id],
          };
        }
        if (sessions.machineClient(m.id) !== "web") {
          const state = await transport(m, "Status");
          if (state.running)
            throw new HubError(
              409,
              "DESKTOP_RELEASE_REQUIRED",
              "Сначала закрой настольный Codex или выбери передачу с его закрытием.",
            );
        }
        await sessions.setMachineClient(m.id, "web");
        return { client: "web", returning: false };
      });
    } finally {
      busy.delete(m.id);
    }
  });
  app.post(
    "/api/machines/:id/desktop/force-restart",
    { config: { rateLimit: { max: 4, timeWindow: "1 minute" } } },
    async (req) => {
      const m = machine(req.params),
        key = z.string().uuid().parse(req.headers["idempotency-key"]);
      const body = z
        .object({ confirmStopTasks: z.literal(true) })
        .strict()
        .parse(req.body);
      if (busy.has(m.id)) throw desktopError("DESKTOP_RESTART_PENDING");
      busy.add(m.id);
      try {
        return await store.once("desktop-force-restart:" + m.id, key, body, async () => {
          clearReturn(m.id);
          await sessions.setMachineClient(m.id, "desktop", true);
          const state = await transport(m, "ForceRestart", key);
          return { ...state, client: "desktop" };
        });
      } finally {
        busy.delete(m.id);
      }
    },
  );
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
