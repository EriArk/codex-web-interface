import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema, HubError } from "../packages/shared/dist/index.js";
import { capabilityReply } from "./fixtures.mjs";

const config = configSchema.parse({
  hub: {
    publicBaseUrl: "https://example.test",
    databasePath: ":memory:",
    resultsPath: join(tmpdir(), "codex-compat"),
  },
  auth: {},
  machines: [{ id: "pc", name: "PC", type: "local-linux", codex: { command: "codex" } }],
  projects: [{ id: "p", name: "P", machineId: "pc", workingDirectory: tmpdir() }],
});
class Rpc extends EventEmitter {
  closed = false;
  version = "0.154.0";
  missing = new Set();
  offline = false;
  login = false;
  calls = [];
  async initialize() {
    return { userAgent: "codex/" + this.version };
  }
  async request(method, p) {
    this.calls.push({ method, p });
    if (this.offline) throw new HubError(503, "CODEX_DISCONNECTED", "Offline");
    if (this.missing.has(method))
      throw new HubError(501, "CODEX_METHOD_UNSUPPORTED", "Unsupported");
    if (method === "account/read")
      return this.login ? { requiresOpenaiAuth: true, account: null } : { account: {} };
    const cap = capabilityReply(method);
    if (cap) return cap;
    if (method === "thread/start") return { thread: { id: randomUUID() } };
    if (method === "turn/start") return { turn: { id: randomUUID() } };
    return {};
  }
  close() {
    this.closed = true;
  }
}
test("unsupported optional Plan/config do not prevent Work; unknown versions are explicit and unsupported selections never send", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    rpc.missing.add("collaborationMode/list");
    rpc.missing.add("config/read");
    const caps = await sessions.capabilities("p");
    assert.deepEqual(caps.modes, ["default"]);
    assert.equal(caps.serverVersion, "0.154.0");
    assert.equal(caps.warnings.length, 3);
    const t = await sessions.create("p", "Compatibility");
    await assert.rejects(sessions.startTurn(t.id, "Plan", { ...caps.defaults, mode: "plan" }), {
      code: "MODE_UNAVAILABLE",
    });
    assert.equal(rpc.calls.filter((c) => c.method === "turn/start").length, 0);
    await sessions.startTurn(t.id, "Work", caps.defaults);
    assert.equal(rpc.calls.find((c) => c.method === "turn/start").p.collaborationMode, undefined);
  } finally {
    await sessions.close();
    store.close();
  }
});
test("offline, expired native login and missing core methods remain distinct without mutating a conversation", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    assert.equal((await sessions.status("p")).available, true);
    rpc.login = true;
    assert.equal((await sessions.status("p")).code, "CODEX_LOGIN_REQUIRED");
    rpc.login = false;
    rpc.offline = true;
    assert.equal((await sessions.status("p")).code, "CODEX_DISCONNECTED");
    rpc.offline = false;
    rpc.missing.add("model/list");
    await assert.rejects(sessions.capabilities("p"), { code: "CODEX_METHOD_UNSUPPORTED" });
    assert.equal(
      rpc.calls.filter((c) => ["turn/start", "thread/resume"].includes(c.method)).length,
      0,
    );
  } finally {
    await sessions.close();
    store.close();
  }
});

test("unsupported native project family disables only project creation before filesystem mutation", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    rpc.missing.add("project/list");
    await sessions.catalog.refresh();
    assert.equal(sessions.catalog.machines()[0].canCreateProjects, false);
    assert.equal(
      sessions.catalog.projects().some((p) => p.id === "p"),
      true,
    );
    await assert.rejects(
      sessions.catalog.createProject("pc", "New", "/tmp/new", true, randomUUID()),
      { code: "CODEX_METHOD_UNSUPPORTED" },
    );
    assert.equal(rpc.calls.filter((c) => c.method === "fs/createDirectory").length, 0);
    assert.equal((await sessions.status("p")).available, true);
  } finally {
    await sessions.close();
    store.close();
  }
});
test("known external work refuses turn/start before opening a native writer", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = store.createThread("p", "external", "Desktop");
    sessions.externalActivity.refresh = async () => {
      store.db.prepare("UPDATE threads SET activitySource='external' WHERE id=?").run(t.id);
      store.setStatus(t.id, "running", "external-turn");
    };
    await assert.rejects(sessions.startTurn(t.id, "Follow up"), { code: "THREAD_IN_USE" });
    assert.equal(rpc.calls.length, 0);
    assert.equal(store.history(t.id).messages.length, 0);
  } finally {
    await sessions.close();
    store.close();
  }
});
