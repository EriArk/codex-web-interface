import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { engineInfo } from "../apps/hub/dist/engine-client.js";
import { prepareEngineSocket } from "../apps/hub/dist/engine-socket.js";
import { createWebGateway } from "../apps/hub/dist/web-gateway.js";
import { currentRelease, publishWeb } from "../apps/hub/dist/web-releases.js";
import { devicesFixture } from "./devices-fixture.mjs";
import { formRequest } from "./elicitation-fixture.mjs";
import { settings } from "./handoff-fixture.mjs";

const require = createRequire(new URL("../apps/hub/package.json", import.meta.url));
const { WebSocket } = require("ws");
const waitFor = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Wait timed out");
};

export async function gatewayFixture(appOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "cw-edge-")),
    socketPath = join(root, "engine.sock"),
    releaseRoot = join(root, "web");
  const origin = "http://127.0.0.1:18934";
  const f = await devicesFixture(origin, { ...appOptions, executionService: true });
  await f.release();
  await f.app.listen({ path: socketPath });
  await publishWeb({
    source: resolve("apps/web/dist"),
    root: releaseRoot,
    socketPath,
    revision: "abcdef123",
  });
  let edge;
  const start = async () => {
    edge = await createWebGateway(f.sessions.config, { socketPath, releaseRoot });
    await edge.listen({ host: "127.0.0.1", port: 18934 });
  };
  await start();
  const http = (path, body, key = randomUUID(), method = body ? "POST" : "GET") =>
    fetch(origin + path, {
      method,
      headers: { ...f.headers, "content-type": "application/json", "idempotency-key": key },
      body: body ? JSON.stringify(body) : undefined,
    });
  const attach = async (path) => {
    const ws = new WebSocket(origin.replace("http", "ws") + path, { headers: f.headers }),
      events = [];
    ws.on("message", (data) => events.push(JSON.parse(data)));
    ws.on("error", () => {});
    await once(ws, "open");
    return { ws, events };
  };
  return {
    ...f,
    root,
    socketPath,
    releaseRoot,
    origin,
    http,
    attach,
    restart: async () => {
      await edge.close();
      await start();
    },
    stopEdge: async () => edge.close(),
    startEdge: start,
    close: async () => {
      await edge.close();
      await f.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
