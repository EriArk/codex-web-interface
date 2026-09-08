import { uptime } from "node:os";
import { CodexClient } from "@codex-web/codex";
import { probeCodex, readMachineResources, spawnCodex } from "@codex-web/machines";
import {
  type DiagnosticCheck,
  HubError,
  type MachineConfig,
  type MachineHealth,
  type MachineProbe,
  type MachinesOverview,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { safeVersion, sshProbe, tcp } from "./doctor.js";
import type { Sessions } from "./sessions.js";

type Rpc = Pick<CodexClient, "initialize" | "request" | "close">;
export type MachineProbeDependencies = {
  ssh?: typeof sshProbe;
  codex?: typeof probeCodex;
  resources?: typeof readMachineResources;
  remote?: typeof tcp;
  rpc?: (m: MachineConfig, root: string) => Rpc;
  now?: () => number;
};
export async function probeMachine(
  machine: MachineConfig,
  root: string,
  dependencies: MachineProbeDependencies = {},
): Promise<MachineProbe> {
  const checks: DiagnosticCheck[] = [];
  const add = (layer: DiagnosticCheck["layer"], state: DiagnosticCheck["state"], code: string) =>
    checks.push({ layer, state, code });
  const transport =
    machine.type === "local-linux"
      ? "LOCAL"
      : await (dependencies.ssh ?? sshProbe)(machine).catch(() => "SSH_UNREACHABLE");
  const online = transport === "SSH_OK" || transport === "LOCAL";
  add(
    "transport",
    online ? "ok" : "error",
    [
      "LOCAL",
      "SSH_OK",
      "SSH_HOST_KEY_FAILED",
      "SSH_AUTH_FAILED",
      "SSH_TIMEOUT",
      "SSH_CLIENT_UNAVAILABLE",
      "SSH_NOT_CONFIGURED",
    ].includes(transport)
      ? transport
      : "SSH_UNREACHABLE",
  );
  const metrics = online
    ? (dependencies.resources ?? readMachineResources)(machine, root).catch(() => ({}))
    : Promise.resolve({});
  const remote = machine.remote
    ? (dependencies.remote ?? tcp)(machine.remote.host, machine.remote.port).catch(() => false)
    : Promise.resolve(null);
  const gateway = machine.remote
    ? (dependencies.remote ?? tcp)("127.0.0.1", 4822).catch(() => false)
    : Promise.resolve(null);
  let codexVersion: string | undefined;
  if (online) {
    const executable = await (dependencies.codex ?? probeCodex)(machine, root).catch(() => ({
      available: false,
    }));
    codexVersion = safeVersion("version" in executable ? executable.version : undefined);
    add(
      "executable",
      executable.available ? "ok" : "error",
      executable.available ? "CODEX_EXECUTABLE_OK" : "CODEX_EXECUTABLE_UNAVAILABLE",
    );
    if (executable.available) {
      let rpc: Rpc | undefined;
      try {
        rpc = dependencies.rpc
          ? dependencies.rpc(machine, root)
          : new CodexClient(spawnCodex(machine, root), 8000);
        if (rpc instanceof CodexClient) {
          rpc.on("fault", () => {});
          rpc.on(
            "request",
            (request) => rpc instanceof CodexClient && rpc.rejectRequest(request.id),
          );
        }
        await rpc.initialize();
        add("protocol", "ok", "CODEX_PROTOCOL_OK");
        if (machine.type === "ssh-windows" && machine.codex.launcher)
          add("companion", "ok", "COMPANION_LAUNCH_OK");
        const [account, models] = await Promise.allSettled([
          rpc.request("account/read", { refreshToken: false }),
          rpc.request("model/list", {}),
        ]);
        if (account.status === "rejected") add("account", "warning", "CODEX_ACCOUNT_UNKNOWN");
        else {
          const value = account.value,
            known = value.requiresOpenaiAuth === false || !!value.account;
          add(
            "account",
            known ? "ok" : value.requiresOpenaiAuth === true ? "error" : "warning",
            known
              ? "CODEX_ACCOUNT_OK"
              : value.requiresOpenaiAuth === true
                ? "CODEX_LOGIN_REQUIRED"
                : "CODEX_ACCOUNT_UNKNOWN",
          );
        }
        add(
          "models",
          models.status === "fulfilled" &&
            Array.isArray(models.value.data) &&
            models.value.data.length > 0
            ? "ok"
            : "warning",
          models.status === "fulfilled" &&
            Array.isArray(models.value.data) &&
            models.value.data.length > 0
            ? "CODEX_MODELS_OK"
            : "CODEX_MODELS_UNAVAILABLE",
        );
      } catch {
        add("protocol", "error", "CODEX_PROTOCOL_UNAVAILABLE");
        if (machine.type === "ssh-windows" && machine.codex.launcher)
          add("companion", "warning", "COMPANION_LAUNCH_UNCONFIRMED");
      } finally {
        rpc?.close();
      }
    }
  }
  if (!checks.some((c) => c.layer === "companion"))
    add(
      "companion",
      "skipped",
      machine.codex.launcher ? "COMPANION_NOT_CHECKED" : "COMPANION_NOT_CONFIGURED",
    );
  const reachable = await remote;
  add(
    "remote",
    reachable === null ? "skipped" : reachable ? "ok" : "error",
    reachable === null
      ? "REMOTE_NOT_CONFIGURED"
      : reachable
        ? "REMOTE_PORT_REACHABLE"
        : "REMOTE_UNREACHABLE",
  );
  if (machine.remote)
    add(
      "gateway",
      (await gateway) ? "ok" : "error",
      (await gateway) ? "REMOTE_GATEWAY_OK" : "REMOTE_GATEWAY_UNAVAILABLE",
    );
  return {
    checkedAt: (dependencies.now ?? Date.now)(),
    online,
    checks,
    codexVersion,
    metrics: await metrics,
  };
}
export class MachineHealthService {
  private inflight = new Map<string, Promise<MachineProbe>>();
  private active = 0;
  constructor(
    readonly sessions: Sessions,
    readonly dependencies: MachineProbeDependencies = {},
  ) {}
  private now() {
    return (this.dependencies.now ?? Date.now)();
  }
  private saved() {
    return (this.sessions.store.preferences().machineHealth ?? {}) as Record<
      string,
      { probe: MachineProbe; lastSeenAt?: number }
    >;
  }
  overview(): MachinesOverview {
    const saved = this.saved(),
      prefs = this.sessions.store.preferences();
    return {
      hub: {
        startedAt: Date.now() - process.uptime() * 1000,
        hostStartedAt: Date.now() - uptime() * 1000,
      },
      machines: this.sessions.config.machines.map((machine) => {
        const projects = this.sessions.catalog
            .projects()
            .filter(
              (p) =>
                p.machineId === machine.id &&
                p.enabled &&
                !p.unassigned &&
                !this.sessions.catalog.library.get("project", p.id)?.deleted,
            ),
          active = { web: 0, external: 0, unknown: 0 };
        for (const project of this.sessions.catalog
          .projects()
          .filter((p) => p.machineId === machine.id))
          for (const thread of this.sessions.store.threads(project.id)) {
            if (thread.status === "unknown") active.unknown++;
            else if (["starting", "running", "waiting_approval"].includes(thread.status))
              active[thread.activitySource === "external" ? "external" : "web"]++;
          }
        const value = saved[machine.id],
          owners = prefs.machineClients as Record<string, string> | undefined;
        return {
          id: machine.id,
          name: machine.name,
          os: machine.type === "ssh-windows" ? "Windows" : "Linux",
          transport: machine.type === "ssh-windows" ? "SSH" : "Local",
          remoteProvider: machine.remote?.provider,
          lastSeenAt: value?.lastSeenAt,
          probe: value?.probe,
          stale: !value?.probe || this.now() - value.probe.checkedAt > 60000,
          busy: this.inflight.has(machine.id),
          owner: owners?.[machine.id] === "desktop" ? "desktop" : "web",
          active,
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            remoteAvailable: !!machine.remote,
          })),
        } satisfies MachineHealth;
      }),
    };
  }
  async check(id: string) {
    const machine = this.sessions.catalog.machine(id),
      existing = this.inflight.get(id);
    if (existing) return existing;
    const previous = this.saved()[id];
    if (previous && this.now() - previous.probe.checkedAt < 15000) return previous.probe;
    if (this.active >= 2)
      throw new HubError(429, "DIAGNOSTICS_BUSY", "Проверка других компьютеров ещё идёт.");
    const project = this.sessions.catalog
      .projects()
      .find((p) => p.machineId === id && p.enabled && !p.unassigned);
    if (!project)
      throw new HubError(409, "MACHINE_WORKSPACE_REQUIRED", "Для проверки подключи папку проекта.");
    this.active++;
    const pending = probeMachine(machine, project.workingDirectory, this.dependencies)
      .then((probe) => {
        this.sessions.store.setPreferences({
          machineHealth: {
            ...this.saved(),
            [id]: { probe, lastSeenAt: probe.online ? probe.checkedAt : previous?.lastSeenAt },
          },
        });
        return probe;
      })
      .finally(() => {
        this.inflight.delete(id);
        this.active--;
      });
    this.inflight.set(id, pending);
    return pending;
  }
}
export function registerMachineHealth(
  app: FastifyInstance,
  sessions: Sessions,
  dependencies: MachineProbeDependencies = {},
) {
  const health = new MachineHealthService(sessions, dependencies);
  app.get("/api/machines/overview", (req) => {
    z.object({}).strict().parse(req.query);
    return health.overview();
  });
  app.post("/api/machines/:id/diagnostics", async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    z.object({}).strict().parse(req.query);
    await health.check(id);
    return health.overview();
  });
  return health;
}
