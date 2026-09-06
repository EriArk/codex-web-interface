import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import { Store } from "../apps/hub/dist/store.js";
import activity from "../ops/windows/desktop-activity.cjs";
import { parseDesktopReply } from "../packages/machines/dist/desktop.js";
import { configSchema } from "../packages/shared/dist/index.js";

const origin = "https://example.test";
const config = configSchema.parse({
  hub: {
    publicBaseUrl: origin,
    databasePath: ":memory:",
    resultsPath: join(tmpdir(), "codex-desktop-test"),
  },
  auth: {},
  machines: [
    {
      id: "pc",
      name: "PC",
      type: "ssh-windows",
      ssh: { target: "test-pc" },
      codex: { desktopControl: "C:/Control/CodexDesktopControl.ps1" },
    },
  ],
  projects: [{ id: "p", name: "P", machineId: "pc", workingDirectory: "C:/Project" }],
});
async function fixture() {
  const store = new Store(":memory:"),
    calls = [],
    setupToken = randomBytes(32).toString("base64url");
  let state = {
      available: true,
      running: true,
      activityKnown: true,
      activeTasks: 0,
      operation: null,
    },
    failure = false;
  const transport = async (_m, action, id) => {
    calls.push({ action, id });
    if (action === "Restart") {
      state = {
        ...state,
        operation: {
          id,
          kind: "restart",
          state: "queued",
          code: "",
          requestedAt: Date.now() / 1000,
        },
      };
      if (failure) throw Error("lost acknowledgement");
    }
    return state;
  };
  const { app } = await createApp(config, { store, setupToken, desktopTransport: transport });
  const enrolled = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin },
    payload: { token: setupToken, password: "Isolated desktop test " + randomUUID() },
  });
  assert.equal(enrolled.statusCode, 200);
  const cookie = enrolled.headers["set-cookie"].split(";")[0];
  const session = await app.inject({ url: "/api/auth/session", headers: { cookie } });
  const headers = { origin, cookie, "x-csrf-token": session.json().csrf };
  const post = (key = randomUUID(), body = { confirm: true }, extra = {}) =>
    app.inject({
      method: "POST",
      url: "/api/machines/pc/desktop/restart",
      headers: { ...headers, "idempotency-key": key, ...extra },
      payload: body,
    });
  return {
    app,
    store,
    calls,
    headers,
    post,
    set: (v) => (state = { ...state, ...v }),
    fail: () => (failure = true),
    close: () => app.close(),
  };
}
test("desktop restart requires auth, Origin, CSRF, exact body and a configured machine", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ url: "/api/machines/pc/desktop" })).statusCode, 401);
    assert.equal(
      (await f.post(randomUUID(), { confirm: true }, { origin: "https://evil.test" })).statusCode,
      403,
    );
    assert.equal(
      (await f.post(randomUUID(), { confirm: true }, { "x-csrf-token": "wrong" })).statusCode,
      403,
    );
    assert.equal(
      (await f.post(randomUUID(), { confirm: true, command: "anything" })).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url: "/api/machines/missing/desktop", headers: f.headers })).statusCode,
      404,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test("native active tasks and unknown observation never dispatch restart", async () => {
  const f = await fixture();
  try {
    f.set({ activeTasks: 2 });
    let r = await f.post();
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, "DESKTOP_BUSY");
    f.set({ activeTasks: 0, activityKnown: false });
    r = await f.post();
    assert.equal(r.statusCode, 503);
    assert.equal(f.calls.filter((c) => c.action === "Restart").length, 0);
  } finally {
    await f.close();
  }
});
test("a just-starting Hub turn blocks maintenance before Windows sees its persisted activity", async () => {
  const f = await fixture();
  try {
    const t = f.store.createThread("p", "native", "Starting");
    f.store.setStatus(t.id, "starting", null);
    const r = await f.post();
    assert.equal(r.statusCode, 409);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test("duplicate restart is dispatched once and outcome can be read after a lost acknowledgement", async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    assert.equal((await f.post(key)).statusCode, 200);
    assert.equal((await f.post(key)).statusCode, 200);
    assert.equal(f.calls.filter((c) => c.action === "Restart").length, 1);
    f.fail();
    const unknown = randomUUID();
    assert.equal((await f.post(unknown)).statusCode, 500);
    const r = await f.app.inject({ url: "/api/machines/pc/desktop", headers: f.headers });
    assert.equal(r.json().operation.id, unknown);
    const retry = await f.post(unknown);
    assert.equal(retry.statusCode, 409);
    assert.equal(f.calls.filter((c) => c.action === "Restart").length, 2);
  } finally {
    await f.close();
  }
});
test("desktop reply validation bounds protocol data and hides private paths", () => {
  const value = {
    available: true,
    running: true,
    activityKnown: true,
    activeTasks: 1,
    operation: null,
    privatePath: "secret",
  };
  assert.equal(parseDesktopReply(JSON.stringify(value)).privatePath, undefined);
  for (const v of [
    "not JSON",
    JSON.stringify({ ...value, activeTasks: -1 }),
    JSON.stringify({ ...value, operation: { state: "arbitrary" } }),
  ]) {
    assert.throws(() => parseDesktopReply(v), { code: "DESKTOP_CONTROL_UNAVAILABLE" });
  }
  assert.throws(() => parseDesktopReply('{"error":"DESKTOP_BUSY"}'), {
    code: "DESKTOP_BUSY",
    statusCode: 409,
  });
});
test("Windows maintenance activity scans all recent native work read-only and fails closed for missing schema", () => {
  const folder = mkdtempSync(join(tmpdir(), "codex-maintenance-"));
  try {
    assert.deepEqual(activity.readActivity(folder), { known: false, active: 0 });
    const s = new DatabaseSync(join(folder, "state_5.sqlite")),
      h = new DatabaseSync(join(folder, "thread_history_1.sqlite"));
    s.exec("CREATE TABLE threads(id TEXT, updated_at INTEGER, archived INTEGER)");
    h.exec(
      "CREATE TABLE thread_turns(thread_id TEXT,status TEXT,started_at INTEGER,rollout_ordinal INTEGER)",
    );
    for (const [id, updated, archived, status] of [
      ["active", 999, 0, "inProgress"],
      ["old", 1, 0, "inProgress"],
      ["archived", 999, 1, "inProgress"],
      ["done", 999, 0, "completed"],
    ]) {
      s.prepare("INSERT INTO threads VALUES(?,?,?)").run(id, updated, archived);
      h.prepare("INSERT INTO thread_turns VALUES(?,?,?,1)").run(id, status, updated);
    }
    assert.deepEqual(activity.readActivity(folder, 1000), { known: true, active: 1 });
    assert.equal(s.prepare("SELECT COUNT(*) n FROM threads").get().n, 4);
    s.close();
    h.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
