import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { prepareEngineSocket } from "./engine-socket.js";
import { loadPushKeys } from "./push.js";
import { Store } from "./store.js";

process.umask(0o077);
const config = loadConfig(process.env.HUB_CONFIG ?? "./config.local.yaml");
const engineSocket = process.env.HUB_ROLE === "engine" ? process.env.HUB_ENGINE_SOCKET : undefined;
if (process.env.HUB_ROLE === "engine") {
  if (!engineSocket) throw new Error("ENGINE_SOCKET_REQUIRED");
  mkdirSync(dirname(engineSocket), { recursive: true, mode: 0o700 });
  await prepareEngineSocket(engineSocket);
}
const store = new Store(config.hub.databasePath);
const setupPath = join(dirname(config.hub.databasePath), "setup-link.txt");
let setupToken: string | undefined;
if (!store.db.prepare("SELECT username FROM users LIMIT 1").get()) {
  if (existsSync(setupPath))
    setupToken = new URL(readFileSync(setupPath, "utf8").trim()).hash.slice("#setup=".length);
  else {
    setupToken = randomBytes(32).toString("base64url");
    mkdirSync(dirname(setupPath), { recursive: true, mode: 0o700 });
    writeFileSync(setupPath, `${config.hub.publicBaseUrl}/#setup=${setupToken}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
} else if (existsSync(setupPath)) unlinkSync(setupPath);
let pushKeys: ReturnType<typeof loadPushKeys> | undefined;
try {
  pushKeys = loadPushKeys(join(dirname(config.hub.databasePath), "push-keys.json"));
} catch {
  /* Optional delivery must not prevent Codex/GPT startup. */
}
const { app } = await createApp(config, {
  setupToken,
  executionService: !!engineSocket,
  store,
  webRoot:
    process.env.HUB_ROLE === "engine"
      ? undefined
      : (process.env.HUB_WEB_ROOT ?? fileURLToPath(new URL("../../web/dist/", import.meta.url))),
  logger: true,
  push: { keys: pushKeys },
});
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
app.log.info({ schemaVersion: store.schemaVersion }, "Hub storage ready");
if (process.env.HUB_ROLE === "engine") {
  await app.listen({ path: engineSocket! });
} else await app.listen({ host: config.hub.host, port: config.hub.port });
