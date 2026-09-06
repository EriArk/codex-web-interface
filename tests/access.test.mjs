import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { accessCapabilities } from "../apps/hub/dist/access.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema, HubError } from "../packages/shared/dist/index.js";
import { capabilityReply } from "./fixtures.mjs";

const config = configSchema.parse({
  hub: {
    publicBaseUrl: "https://example.test",
    databasePath: ":memory:",
    resultsPath: "/tmp/access-test",
  },
  auth: {},
  machines: [{ id: "pc", name: "PC", type: "local-linux" }],
  projects: [{ id: "p", name: "P", machineId: "pc", workingDirectory: "/tmp" }],
});
class Rpc extends EventEmitter {
  closed = false;
  calls = [];
  allow = true;
  requirements = null;
  failUpdate = false;
  async initialize() {
    return { userAgent: "codex/0.153.4" };
  }
  async request(method, p) {
    this.calls.push({ method, p });
    if (method === "permissionProfile/list")
      return { data: [{ id: ":danger-full-access", allowed: this.allow }], nextCursor: null };
    if (method === "configRequirements/read") return { requirements: this.requirements };
    const caps = capabilityReply(method);
    if (caps) return caps;
    if (method === "account/read") return { account: {} };
    if (method === "thread/start") return { thread: { id: randomUUID() } };
    if (method === "thread/resume") return { thread: { turns: [] } };
    if (method === "thread/settings/update") {
      this.emit("notification", "thread/settings/updated", {
        threadId: p.threadId,
        threadSettings: {
          approvalPolicy: p.approvalPolicy,
          sandboxPolicy: p.sandboxPolicy ?? { type: "dangerFullAccess" },
        },
      });
      if (this.failUpdate) throw new HubError(504, "CODEX_REQUEST_TIMEOUT", "unconfirmed");
      return {};
    }
    if (method === "turn/start") return { turn: { id: randomUUID() } };
    return {};
  }
  close() {
    this.closed = true;
  }
}
test("explicit per-thread full access is applied natively, retained on resume, and can be reduced without changing other chats", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc();
  let sessions = new Sessions(config, store, () => rpc);
  try {
    const t = await sessions.create("p", "Access"),
      other = await sessions.create("p", "Other");
    const settings = (await sessions.capabilities("p")).defaults;
    assert.deepEqual((await sessions.capabilities("p")).accessModes, ["workspace", "full"]);
    await sessions.setSettings(t.id, { ...settings, access: "full" });
    let call = rpc.calls.findLast((c) => c.method === "thread/settings/update");
    assert.equal(call.p.permissions, ":danger-full-access");
    assert.equal(call.p.approvalPolicy, "never");
    assert.equal(call.p.sandboxPolicy, undefined);
    assert.notEqual(store.threadSettings(other.id)?.access, "full");
    await sessions.close();
    const next = new Rpc();
    sessions = new Sessions(config, store, () => next);
    await sessions.resume(t.id);
    call = next.calls.find((c) => c.method === "thread/resume");
    assert.equal(call.p.permissions, ":danger-full-access");
    assert.equal(call.p.approvalPolicy, "never");
    await sessions.startTurn(t.id, "A harmless check");
    call = next.calls.findLast((c) => c.method === "turn/start");
    assert.equal(call.p.permissions, ":danger-full-access");
    await sessions.setSettings(t.id, { ...settings, access: "workspace" });
    call = next.calls.findLast((c) => c.method === "thread/settings/update");
    assert.deepEqual(call.p.sandboxPolicy, { type: "workspaceWrite", networkAccess: false });
    assert.equal(call.p.approvalPolicy, "on-request");
    assert.equal(store.threadSettings(t.id).access, "workspace");
    assert.equal(
      next.calls.filter((c) => c.method === "turn/interrupt" || c.method === "turn/steer").length,
      0,
    );
  } finally {
    await sessions.close();
    store.close();
  }
});
test("managed restrictions and unreadable permission capabilities cannot enable full access", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = await sessions.create("p", "Managed"),
      settings = (await sessions.capabilities("p")).defaults;
    rpc.allow = false;
    await assert.rejects(sessions.setSettings(t.id, { ...settings, access: "full" }), {
      code: "ACCESS_UNAVAILABLE",
    });
    rpc.allow = true;
    rpc.requirements = { allowedApprovalPolicies: ["on-request"] };
    await assert.rejects(
      sessions.startTurn(t.id, "Should not send", { ...settings, access: "full" }),
      { code: "ACCESS_UNAVAILABLE" },
    );
    assert.equal(
      rpc.calls.filter((c) => c.method === "turn/start" || c.method === "thread/settings/update")
        .length,
      0,
    );
    assert.equal(
      (
        await accessCapabilities(
          {
            request: async () => {
              throw Error("offline");
            },
          },
          "/tmp",
        )
      ).modes.includes("full"),
      false,
    );
  } finally {
    await sessions.close();
    store.close();
  }
});
test("native settings notification preserves an accepted access change if its acknowledgement is lost; no replay", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = await sessions.create("p", "Lost ack"),
      settings = (await sessions.capabilities("p")).defaults;
    await sessions.setSettings(t.id, settings);
    rpc.failUpdate = true;
    await assert.rejects(sessions.setSettings(t.id, { ...settings, access: "full" }), {
      code: "CODEX_REQUEST_TIMEOUT",
    });
    assert.equal(store.threadSettings(t.id).access, "full");
    assert.equal(rpc.calls.filter((c) => c.method === "thread/settings/update").length, 1);
  } finally {
    await sessions.close();
    store.close();
  }
});

test("manual desktop handoff persists, closes loaded writers and never reacquires on passive reads", async () => {
  const store = new Store(":memory:"),
    clients = [];
  const factory = () => {
    const rpc = new Rpc();
    clients.push(rpc);
    return rpc;
  };
  let sessions = new Sessions(config, store, factory);
  try {
    const t = await sessions.create("p", "Handoff");
    await sessions.setMachineClient("pc", "desktop");
    assert.equal(clients[0].closed, true);
    assert.equal(sessions.machineClient("pc"), "desktop");
    await sessions.capabilities("p");
    await assert.rejects(sessions.resume(t.id), { code: "MACHINE_RELEASED" });
    await assert.rejects(sessions.startTurn(t.id, "No surprise ownership"), {
      code: "MACHINE_RELEASED",
    });
    assert.equal(
      clients
        .flatMap((r) => r.calls)
        .filter((c) => c.method === "thread/resume" || c.method === "turn/start").length,
      0,
    );
    await sessions.close();
    sessions = new Sessions(config, store, factory);
    assert.equal(sessions.machineClient("pc"), "desktop");
    await sessions.setMachineClient("pc", "web");
    await sessions.resume(t.id);
    assert.equal(clients.at(-1).calls.filter((c) => c.method === "thread/resume").length, 1);
    await sessions.startTurn(t.id, "Active");
    await assert.rejects(sessions.setMachineClient("pc", "desktop"), { code: "DESKTOP_BUSY" });
    await sessions.setMachineClient("pc", "desktop", true);
    assert.equal(clients.at(-1).closed, true);
    assert.equal(sessions.machineClient("pc"), "desktop");
  } finally {
    await sessions.close();
    store.close();
  }
});

test("compact turn details expose only bounded native summaries and actions, never raw reasoning", async () => {
  const store = new Store(":memory:"),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = await sessions.create("p", "Details"),
      threadId = t.codexThreadId,
      turnId = "turn";
    rpc.emit("notification", "turn/started", { threadId, turn: { id: turnId } });
    rpc.emit("notification", "item/started", {
      threadId,
      turnId,
      item: { id: "r", type: "reasoning" },
    });
    rpc.emit("notification", "item/reasoning/textDelta", {
      threadId,
      turnId,
      itemId: "r",
      delta: "PRIVATE RAW REASONING",
    });
    rpc.emit("notification", "item/reasoning/summaryTextDelta", {
      threadId,
      turnId,
      itemId: "r",
      summaryIndex: 0,
      delta: "Checking the inputs.",
    });
    let details = store.progressDetails(t.id, turnId);
    assert.equal(details.items.at(-1).text, "Checking the inputs.");
    rpc.emit("notification", "item/completed", {
      threadId,
      turnId,
      item: {
        id: "r",
        type: "reasoning",
        summary: ["Inputs checked."],
        content: ["PRIVATE RAW REASONING"],
      },
    });
    rpc.emit("notification", "item/started", {
      threadId,
      turnId,
      item: { id: "c", type: "commandExecution", command: "npm test" },
    });
    details = store.progressDetails(t.id, turnId);
    assert.equal(details.items.length, 2);
    assert.equal(details.items[0].text, "Inputs checked.");
    assert.equal(details.items[1].kind, "command");
    assert.equal(details.items[1].text, "npm test");
    assert(!JSON.stringify(details).includes("PRIVATE"));
    assert.deepEqual(store.progressDetails(t.id, "other"), { items: [] });
    for (let i = 0; i < 20; i++)
      rpc.emit("notification", "item/started", {
        threadId,
        turnId,
        item: { id: "cmd" + i, type: "commandExecution", command: "echo " + i },
      });
    assert.equal(store.progressDetails(t.id, turnId).items.length, 8);
  } finally {
    await sessions.close();
    store.close();
  }
});
