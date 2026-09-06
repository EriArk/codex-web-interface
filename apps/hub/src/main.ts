import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

process.umask(0o077);
const config = loadConfig(process.env.HUB_CONFIG ?? "./config.local.yaml");
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
const { app } = await createApp(config, {
  setupToken,
  store,
  webRoot: process.env.HUB_WEB_ROOT ?? fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  logger: true,
});
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await app.listen({ host: config.hub.host, port: config.hub.port });
