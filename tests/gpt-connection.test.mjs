import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { Store } from "../apps/hub/dist/store.js";
import { connectorReport } from "../ops/gpt/browser-health.mjs";
import { configSchema, normalizeGptConnection } from "../packages/shared/dist/index.js";
import { healthyConnection } from "./fixtures/gpt-connection.mjs";

const wait = async (fn) => {
  const until = Date.now() + 3000;
  while (!fn()) {
    assert(Date.now() < until, "state timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
test("connector states distinguish login, transport, control drift and unsupported protocol without private diagnostics", () => {
  assert.equal(normalizeGptConnection(null, false).state, "disabled");
  assert.equal(normalizeGptConnection(null).state, "unavailable");
  for (const state of [
    "starting",
    "healthy",
    "login_required",
    "busy",
    "degraded",
    "incompatible",
  ]) {
    const result = normalizeGptConnection({
      ...healthyConnection,
      state,
      login: state === "login_required" ? "required" : "authenticated",
      token: "PRIVATE",
      signedUrl: "PRIVATE",
      profile: "PRIVATE",
    });
    assert.equal(result.state, state);
    assert(!JSON.stringify(result).includes("PRIVATE"));
  }
  for (const field of ["composer", "attachments", "models", "effort", "settingsReadback"]) {
    const result = normalizeGptConnection({
      ...healthyConnection,
      capabilities: { ...healthyConnection.capabilities, [field]: false },
    });
    assert.equal(result.state, "degraded");
    assert.equal(result.canSend, false);
    assert.equal(result.canRead, true);
  }
  for (const changed of [
    { bridgeRevision: "other" },
    { extensionProtocol: 6 },
    { bridgeVersion: "99.0.0" },
    { contract: 2 },
  ])
    assert.equal(
      normalizeGptConnection({ ...healthyConnection, ...changed }).state,
      "incompatible",
    );
});
test("browser health checks actual bridge capabilities and readiness", () => {
  const health = {
    ok: true,
    activeRequests: [],
    activeClient: {
      ready: true,
      pageReady: true,
      compatible: true,
      extensionProtocolVersion: 5,
      compatibility: { bridgeVersion: "6.3.14" },
      capabilities: {
        promptInput: true,
        fileUpload: true,
        modelSelection: true,
        effortSelection: true,
      },
    },
  };
  const input = {
    health,
    login: "authenticated",
    controls: { composer: true, attachments: true, models: true },
    privateState: { permissions: true, locked: true },
  };
  assert.equal(connectorReport(input).state, "healthy");
  assert.equal(connectorReport({ ...input, login: "required" }).state, "login_required");
  assert.equal(
    connectorReport({ ...input, health: { ...health, activeRequests: [{}] } }).state,
    "busy",
  );
  assert.equal(
    connectorReport({ ...input, controls: { ...input.controls, attachments: false } }).state,
    "degraded",
  );
  assert.equal(
    connectorReport({
      ...input,
      health: { ...health, activeClient: { ...health.activeClient, compatible: false } },
    }).state,
    "incompatible",
  );
});
test("degraded connector preserves queued files, re-auth resumes only unsubmitted work and unknown remains blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-health-")),
    store = new Store(":memory:");
  process.env.GPT_HEALTH_FIXTURE = "fixture";
  const service = new GptService(
    configSchema.parse({
      hub: { publicBaseUrl: "https://qa.example", databasePath: ":memory:", resultsPath: root },
      auth: {},
      machines: [],
      projects: [],
      gpt: { endpoint: "http://127.0.0.1:1", tokenSecret: "GPT_HEALTH_FIXTURE" },
    }),
    store,
  );
  let report = { ...healthyConnection, state: "login_required", login: "required" },
    writes = 0;
  service.json = async (path, body) => {
    if (path === "/status") return report;
    if (path === "/models")
      return {
        models: [{ id: "Latest", label: "Latest" }],
        efforts: [{ id: "2", label: "High" }],
        currentModel: "Latest",
        currentEffort: "2",
      };
    if (path === "/settings") return body;
    if (path === "/bridge/files") return { file: { id: "file-fixture" } };
    return { ok: true };
  };
  service.response = async (path) => {
    assert.equal(path, "/bridge/chat");
    writes++;
    return new Response('data: {"type":"request.started","requestId":"request-test"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const file = await service.put("draft.txt", Buffer.from("preserved attachment")),
      id = randomUUID();
    service.enqueue(id, {
      nativeId: null,
      text: "Preserved question",
      files: [file.id],
      model: "Latest",
      effort: "2",
    });
    await wait(() => !service.working);
    assert.equal(service.job(id).status, "queued");
    assert.equal(writes, 0);
    assert.equal(service.upload(file.id).bytes, 20);
    report = healthyConnection;
    assert.equal((await service.reconnect()).state, "healthy");
    await wait(() => service.job(id).status === "unknown");
    assert.equal(writes, 1);
    await service.reconnect();
    await service.pump();
    assert.equal(service.job(id).status, "unknown");
    assert.equal(writes, 1);
  } finally {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.GPT_HEALTH_FIXTURE;
  }
});
test("unconfirmed model readback never dispatches a prompt or uploads its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-readback-")),
    store = new Store(":memory:");
  process.env.GPT_READBACK_FIXTURE = "fixture";
  const service = new GptService(
      configSchema.parse({
        hub: { publicBaseUrl: "https://qa.example", databasePath: ":memory:", resultsPath: root },
        auth: {},
        machines: [],
        projects: [],
        gpt: { endpoint: "http://127.0.0.1:1", tokenSecret: "GPT_READBACK_FIXTURE" },
      }),
      store,
    ),
    calls = [];
  service.json = async (path) => {
    calls.push(path);
    if (path === "/status") return healthyConnection;
    if (path === "/settings") return { model: "Other", effort: "0" };
    return { ok: true };
  };
  try {
    const id = randomUUID();
    service.enqueue(id, {
      nativeId: null,
      text: "Keep draft",
      files: [],
      model: "Latest",
      effort: "2",
    });
    await wait(() => service.job(id).status === "failed");
    assert.equal(service.job(id).text, "Keep draft");
    assert(!calls.includes("/bridge/chat"));
    assert(!calls.includes("/bridge/composer/attachments/clear"));
    assert.equal((await service.connection()).state, "degraded");
  } finally {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.GPT_READBACK_FIXTURE;
  }
});
