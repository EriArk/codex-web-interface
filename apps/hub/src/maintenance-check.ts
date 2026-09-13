import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { deploymentBlockers } from "./deployment-status.js";
import { engineTerminalWork } from "./engine-client.js";

const config = JSON.parse(readFileSync(process.env.HUB_CONFIG ?? "/config/config.json", "utf8"));
const db = new DatabaseSync(config.hub.databasePath, { readOnly: true });
const blockers = deploymentBlockers({
  db,
  preferences: () =>
    JSON.parse(String(db.prepare("SELECT value FROM preferences WHERE id=1").get()?.value ?? "{}")),
});
const terminalCount = Number(
  db.prepare("SELECT count(*) n FROM device_terminals WHERE state='open'").get()?.n ?? 0,
);
db.close();
if (config.gpt) {
  try {
    const read = async (path: string) => {
      const response = await fetch(new URL(path, config.gpt.endpoint), {
        headers: { Authorization: "Bearer " + (process.env[config.gpt.tokenSecret] ?? "") },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("GPT_STATUS_UNAVAILABLE");
      return response.json() as Promise<Record<string, unknown>>;
    };
    const [active, health] = await Promise.all([read("/active"), read("/bridge-health")]);
    if (active.generating || !Array.isArray(health.activeRequests) || health.activeRequests.length)
      blockers.push({ kind: "gpt_native", count: 1, label: "GPT_BROWSER_BUSY" });
  } catch {
    blockers.push({ kind: "gpt_native", count: 1, label: "GPT_STATUS_UNAVAILABLE" });
  }
}
const reserve = process.argv.includes("--reserve-terminals");
if (
  (config.team?.enabled || terminalCount || reserve) &&
  !blockers.some((b) => !b.kind.startsWith("terminal"))
) {
  try {
    const state = await engineTerminalWork(
      process.env.HUB_ENGINE_SOCKET ?? "/run/codex-engine/engine.sock",
      reserve,
    );
    for (let i = blockers.length - 1; i >= 0; i--)
      if (blockers[i]?.kind.startsWith("terminal")) blockers.splice(i, 1);
    if (state.work)
      blockers.push({ kind: "team_work", count: state.work, label: "TEAM_WORK_PENDING" });
    if (state.busy)
      blockers.push({ kind: "terminal", count: state.busy, label: "TERMINAL_COMMAND_RUNNING" });
    if (state.unknown || (reserve && !state.reserved))
      blockers.push({
        kind: "terminal_unknown",
        count: Math.max(1, state.unknown),
        label: "TERMINAL_STATUS_UNAVAILABLE",
      });
  } catch {
    if (!blockers.some((b) => b.kind.startsWith("terminal")))
      blockers.push({
        kind: "terminal_unknown",
        count: Math.max(1, terminalCount),
        label: "TERMINAL_STATUS_UNAVAILABLE",
      });
  }
}
process.stdout.write(JSON.stringify({ idle: !blockers.length, blockers }) + "\n");
process.exitCode = blockers.length ? 20 : 0;
