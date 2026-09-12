import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { deploymentBlockers } from "./deployment-status.js";

const config = JSON.parse(readFileSync(process.env.HUB_CONFIG ?? "/config/config.json", "utf8"));
const db = new DatabaseSync(config.hub.databasePath, { readOnly: true });
const blockers = deploymentBlockers({
  db,
  preferences: () =>
    JSON.parse(String(db.prepare("SELECT value FROM preferences WHERE id=1").get()?.value ?? "{}")),
});
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
process.stdout.write(JSON.stringify({ idle: !blockers.length, blockers }) + "\n");
process.exitCode = blockers.length ? 20 : 0;
