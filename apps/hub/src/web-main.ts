import { loadConfig } from "./config.js";
import { createWebGateway } from "./web-gateway.js";

process.umask(0o077);
const socketPath = process.env.HUB_ENGINE_SOCKET;
const releaseRoot = process.env.HUB_RELEASE_ROOT;
if (!socketPath || !releaseRoot) throw new Error("WEB_GATEWAY_CONFIGURATION_REQUIRED");
const config = loadConfig(process.env.HUB_CONFIG ?? "./config.local.yaml");
const app = await createWebGateway(config, { socketPath, releaseRoot });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
await app.listen({ host: config.hub.host, port: config.hub.port });
