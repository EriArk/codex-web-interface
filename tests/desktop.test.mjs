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
import { configSchema, HubError } from "../packages/shared/dist/index.js";

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
  const transport = async (_m, action, id, threadId) => {
    calls.push({ action, id, threadId, client: store.preferences().machineClients?.pc });
    if (action === "Open") {
      state = {
        ...state,
        operation: {
          id,
          kind: "open",
          state: "completed",
          code: "DESKTOP_OPENED",
          requestedAt: Date.now() / 1000,
        },
      };
      if (failure) throw failure === true ? Error("lost acknowledgement") : failure;
    }
    if (["Restart", "ForceRelease"].includes(action)) {
      state = {
        ...state,
        operation: {
          id,
          kind: action === "ForceRelease" ? "forcerelease" : "restart",
          state: "queued",
          code: "",
          requestedAt: Date.now() / 1000,
        },
      };
      if (failure) throw failure === true ? Error("lost acknowledgement") : failure;
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
    fail: (error = true) => (failure = error),
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

test("hard restart requires explicit stop confirmation, bypasses wedged activity checks and dispatches once", async () => {
  const f = await fixture();
  try {
    f.set({ activityKnown: false, activeTasks: 3 });
    const t = f.store.createThread("p", "native", "Active");
    f.store.setStatus(t.id, "running", "turn");
    const key = randomUUID(),
      url = "/api/machines/pc/desktop/force-restart";
    const post = (headers, payload) => f.app.inject({ method: "POST", url, headers, payload });
    assert.equal((await post({ origin }, { confirmStopTasks: true })).statusCode, 401);
    assert.equal(
      (
        await post(
          { ...f.headers, "x-csrf-token": "wrong", "idempotency-key": key },
          { confirmStopTasks: true },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await post({ ...f.headers, "idempotency-key": key }, { confirm: true })).statusCode,
      400,
    );
    assert.equal(f.calls.length, 0);
    for (let n = 0; n < 2; n++) {
      const r = await post({ ...f.headers, "idempotency-key": key }, { confirmStopTasks: true });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().client, "desktop");
    }
    assert.deepEqual(
      f.calls.map((c) => c.action),
      ["ForceRestart"],
    );
    assert.equal(f.store.preferences().machineClients.pc, "desktop");
  } finally {
    await f.close();
  }
});
test("handoff endpoint is authenticated, rejects unrelated fields and requires explicit return", async () => {
  const f = await fixture();
  try {
    const url = "/api/machines/pc/client";
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url,
          headers: { origin },
          payload: { client: "desktop" },
        })
      ).statusCode,
      401,
    );
    f.set({ running: false });
    for (const client of ["desktop", "web"]) {
      const r = await f.app.inject({
        method: "POST",
        url,
        headers: { ...f.headers, "idempotency-key": randomUUID() },
        payload: { client },
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(f.store.preferences().machineClients.pc, client);
    }
    assert.deepEqual(
      f.calls.map((c) => c.action),
      ["Open", "Status"],
    );
  } finally {
    await f.close();
  }
});

async function clientRequest(f, body, id = randomUUID(), extra = {}) {
  return f.app.inject({
    method: "POST",
    url: "/api/machines/pc/client",
    headers: { ...f.headers, "idempotency-key": id, ...extra },
    payload: body,
  });
}
test("return requires explicit desktop-close confirmation and leaves ownership unchanged until verified completion", async () => {
  const f = await fixture();
  try {
    assert.equal((await clientRequest(f, { client: "desktop" })).statusCode, 200);
    assert.equal(
      (await clientRequest(f, { client: "web" })).json().error.code,
      "DESKTOP_RELEASE_REQUIRED",
    );
    for (const body of [
      { client: "web", releaseDesktop: true },
      { client: "web", confirmStopTasks: true },
      { client: "desktop", releaseDesktop: true },
    ])
      assert.equal((await clientRequest(f, body)).statusCode, 400);
    const body = { client: "web", releaseDesktop: true, confirmStopTasks: true },
      key = randomUUID();
    assert.equal((await clientRequest(f, body, key, { "x-csrf-token": "wrong" })).statusCode, 403);
    assert.equal(f.calls.filter((c) => c.action === "ForceRelease").length, 0);
    f.set({ activeTasks: 3, activityKnown: false });
    for (let n = 0; n < 2; n++) {
      const r = await clientRequest(f, body, key);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().returning, true);
      assert.equal(r.json().client, "desktop");
    }
    assert.equal(f.calls.filter((c) => c.action === "ForceRelease").length, 1);
    assert.equal(
      (await clientRequest(f, { client: "desktop" })).json().error.code,
      "HANDOFF_PENDING",
    );
    const status = () => f.app.inject({ url: "/api/machines/pc/desktop", headers: f.headers });
    const operation = {
      id: key,
      kind: "forcerelease",
      state: "completed",
      code: "DESKTOP_RELEASED",
    };
    f.set({ operation });
    assert.equal(
      (await status()).json().client,
      "desktop",
      "a completed reply cannot hide a still-running desktop",
    );
    f.set({ running: false });
    const done = (await status()).json();
    assert.equal(done.client, "web");
    assert.equal(done.returning, false);
    assert.deepEqual(f.store.preferences().desktopReturns, {});
  } finally {
    await f.close();
  }
});

test("lost native close acknowledgement is recovered by background polling without another browser request or replay", async () => {
  const f = await fixture();
  try {
    await clientRequest(f, { client: "desktop" });
    f.fail();
    const key = randomUUID(),
      body = { client: "web", releaseDesktop: true, confirmStopTasks: true };
    assert.equal((await clientRequest(f, body, key)).statusCode, 500);
    assert.equal(f.store.preferences().machineClients.pc, "desktop");
    f.set({
      running: false,
      operation: { id: key, kind: "forcerelease", state: "completed", code: "DESKTOP_RELEASED" },
    });
    const deadline = Date.now() + 7000;
    while (f.store.preferences().machineClients.pc !== "web" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.store.preferences().machineClients.pc, "web");
    assert.equal((await clientRequest(f, body, key)).statusCode, 409);
    assert.equal(f.calls.filter((c) => c.action === "ForceRelease").length, 1);
  } finally {
    await f.close();
  }
});

test("failed or unrelated native close never returns the writer and pending state survives browser loss", async () => {
  const f = await fixture();
  try {
    await clientRequest(f, { client: "desktop" });
    const key = randomUUID();
    await clientRequest(f, { client: "web", releaseDesktop: true, confirmStopTasks: true }, key);
    const status = () => f.app.inject({ url: "/api/machines/pc/desktop", headers: f.headers });
    f.set({
      running: false,
      operation: {
        id: randomUUID(),
        kind: "restart",
        state: "completed",
        code: "DESKTOP_RESTARTED",
      },
    });
    assert.equal((await status()).json().returning, true);
    f.set({
      operation: { id: key, kind: "forcerelease", state: "failed", code: "DESKTOP_STOP_FAILED" },
    });
    const failed = (await status()).json();
    assert.equal(failed.client, "desktop");
    assert.equal(failed.returning, false);
  } finally {
    await f.close();
  }
});

test("a definite native cooldown rejection clears pending return immediately", async () => {
  const f = await fixture();
  try {
    await clientRequest(f, { client: "desktop" });
    f.fail(new HubError(409, "DESKTOP_RESTART_COOLDOWN", "Cooldown"));
    const r = await clientRequest(f, {
      client: "web",
      releaseDesktop: true,
      confirmStopTasks: true,
    });
    assert.equal(r.statusCode, 409);
    assert.deepEqual(f.store.preferences().desktopReturns, {});
    assert.equal(f.store.preferences().machineClients.pc, "desktop");
  } finally {
    await f.close();
  }
});

test("handoff opens the selected native thread after release, once, and accepts no arbitrary URL", async () => {
  const f = await fixture();
  try {
    const native = randomUUID(),
      t = f.store.createThread("p", native, "Handoff");
    const key = randomUUID(),
      body = { client: "desktop", threadId: t.id };
    for (let i = 0; i < 2; i++) {
      const result = await clientRequest(f, body, key);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().operation.kind, "open");
    }
    assert.deepEqual(
      f.calls.filter((c) => c.action === "Open"),
      [{ action: "Open", id: key, threadId: native, client: "desktop" }],
    );
    for (const extra of [
      { threadId: "codex://threads/invalid" },
      { url: "https://evil.test" },
      { command: "calc.exe" },
    ])
      assert.equal((await clientRequest(f, { client: "desktop", ...extra })).statusCode, 400);
    assert.equal(
      (await clientRequest(f, { client: "desktop", threadId: randomUUID() })).statusCode,
      404,
    );
    const unrelated = f.store.createThread("different-machine-project", randomUUID(), "Other");
    assert.equal(
      (await clientRequest(f, { client: "desktop", threadId: unrelated.id })).statusCode,
      400,
    );
    assert.equal(f.calls.filter((c) => c.action === "Open").length, 1);
  } finally {
    await f.close();
  }
});

test("active handoff cannot open the desktop before work has stopped", async () => {
  const f = await fixture();
  try {
    const t = f.store.createThread("p", randomUUID(), "Active");
    f.store.setStatus(t.id, "running", "turn");
    assert.equal((await clientRequest(f, { client: "desktop", threadId: t.id })).statusCode, 409);
    assert.equal(f.calls.filter((c) => c.action === "Open").length, 0);
    assert.notEqual(f.store.preferences().machineClients?.pc, "desktop");
  } finally {
    await f.close();
  }
});

test("an unconfirmed open preserves desktop ownership, never replays and blocks return until resolved", async () => {
  const f = await fixture();
  try {
    f.fail();
    const key = randomUUID(),
      body = { client: "desktop" };
    assert.equal((await clientRequest(f, body, key)).statusCode, 500);
    assert.equal(f.store.preferences().machineClients.pc, "desktop");
    assert.equal((await clientRequest(f, body, key)).statusCode, 409);
    f.set({
      running: false,
      operation: {
        id: key,
        kind: "open",
        state: "queued",
        code: "",
        requestedAt: Date.now() / 1000,
      },
    });
    for (const next of [
      { client: "web" },
      { client: "web", releaseDesktop: true, confirmStopTasks: true },
    ]) {
      const r = await clientRequest(f, next);
      assert.equal(r.statusCode, 409);
      assert.equal(r.json().error.code, "HANDOFF_PENDING");
    }
    assert.equal(f.calls.filter((c) => c.action === "ForceRelease").length, 0);
    f.set({
      operation: {
        id: key,
        kind: "open",
        state: "failed",
        code: "DESKTOP_WINDOW_UNAVAILABLE",
        requestedAt: Date.now() / 1000,
      },
    });
    assert.equal((await clientRequest(f, { client: "web" })).statusCode, 200);
    assert.equal(f.calls.filter((c) => c.action === "Open").length, 1);
  } finally {
    await f.close();
  }
});

test("confirmed web return skips process actions when the desktop is already closed", async () => {
  const f = await fixture();
  try {
    await clientRequest(f, { client: "desktop" });
    f.set({
      running: false,
      operation: {
        id: randomUUID(),
        kind: "open",
        state: "failed",
        code: "DESKTOP_WINDOW_UNAVAILABLE",
      },
    });
    const result = await clientRequest(f, {
      client: "web",
      releaseDesktop: true,
      confirmStopTasks: true,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().client, "web");
    assert.equal(f.calls.filter((c) => c.action === "ForceRelease").length, 0);
  } finally {
    await f.close();
  }
});
