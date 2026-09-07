import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import {
  createRecoveryLink,
  createSnapshot,
  restoreSnapshot,
} from "../apps/hub/dist/maintenance.js";
import { Store } from "../apps/hub/dist/store.js";
import WebSocket from "../apps/hub/node_modules/ws/wrapper.mjs";
import { watchHubSession } from "../ops/gpt/session-watch.mjs";
import { configSchema } from "../packages/shared/dist/index.js";

const secret = () => randomBytes(24).toString("base64url");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-account-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "owner" },
    machines: [{ id: "local", name: "Local", type: "local-linux" }],
    projects: [{ id: "p", name: "Project", machineId: "local", workingDirectory: root }],
  });
  const setupToken = randomBytes(32).toString("base64url");
  const value = await createApp(config, { setupToken });
  const { app } = value,
    sockets = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = config.hub.publicBaseUrl;
  const post = (url, payload, headers = {}) =>
    app.inject({
      method: "POST",
      url: "/api/auth/" + url,
      headers: { origin, ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
  const headers = (res) => ({
    origin,
    cookie: res.headers["set-cookie"].split(";")[0],
    "x-csrf-token": res.json().csrf,
  });
  const password = secret(),
    enrolled = await post("setup", { token: setupToken, password });
  assert.equal(enrolled.statusCode, 200);
  const owner = headers(enrolled);
  const session = (h) => app.inject({ url: "/api/auth/session", headers: h });
  const connect = async (path, h = owner) => {
    const ws = new WebSocket("ws://127.0.0.1:" + app.server.address().port + path, { headers: h });
    sockets.push(ws);
    const first = once(ws, "message");
    await once(ws, "open");
    await first;
    return ws;
  };
  const link = async (name) => {
    const file = join(root, name),
      metadata = await createRecoveryLink(config, file);
    const text = await readFile(file, "utf8"),
      token = new URL(text.trim()).hash.slice("#recover=".length);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert(!JSON.stringify(metadata).includes(token));
    assert.equal(new URL(text.trim()).search, "");
    assert.equal(token.length, 43);
    return { file, token, metadata };
  };
  return { ...value, root, config, origin, password, owner, post, headers, session, connect, link };
}

test("password rotation preserves current browser and running work, revoking every old session and stream", async (t) => {
  const f = await fixture(t),
    second = f.headers(await f.post("login", { password: f.password }));
  const thread = f.store.createThread("p", randomUUID(), "Still working");
  f.store.append(thread.id, "user.message", { id: "u", text: "Keep this task" }, "turn");
  f.store.setStatus(thread.id, "running", "turn");
  const streams = await Promise.all([
    f.connect("/api/navigation/events", second),
    f.connect("/api/events?threadId=" + thread.id + "&after=0", second),
  ]);
  let ended;
  const stopped = new Promise((resolve) => {
    ended = resolve;
  });
  let stopWatch;
  await new Promise((resolve) => {
    stopWatch = watchHubSession(
      "http://127.0.0.1:" + f.app.server.address().port,
      f.origin,
      second.cookie,
      resolve,
      ended,
    );
  });
  t.after(() => stopWatch());
  const invalid = await f.post(
    "password",
    { currentPassword: "wrong", password: secret() },
    f.owner,
  );
  assert.equal(invalid.statusCode, 403);
  assert.equal(invalid.json().error.code, "PASSWORD_MISMATCH");
  assert.equal((await f.session(f.owner)).statusCode, 200);
  assert.equal(streams[0].readyState, 1);
  const next = secret(),
    closures = streams.map((s) => once(s, "close"));
  const changed = await f.post(
    "password",
    { currentPassword: f.password, password: next },
    f.owner,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  await stopped;
  for (const close of closures) assert.equal((await close)[0], 1008);
  const fresh = f.headers(changed);
  assert.notEqual(fresh.cookie, f.owner.cookie);
  assert.notEqual(fresh["x-csrf-token"], f.owner["x-csrf-token"]);
  assert.equal((await f.session(fresh)).statusCode, 200);
  for (const old of [f.owner, second]) assert.equal((await f.session(old)).statusCode, 401);
  assert.equal((await f.post("login", { password: f.password })).statusCode, 401);
  assert.equal((await f.post("login", { password: next })).statusCode, 200);
  assert.equal(f.store.thread(thread.id).status, "running");
  assert.equal(f.store.thread(thread.id).activeTurnId, "turn");
  assert.equal(f.store.history(thread.id).messages[0].text, "Keep this task");
  const denied = await f.app.inject({
    method: "PATCH",
    url: "/api/preferences",
    headers: { ...fresh, "x-csrf-token": f.owner["x-csrf-token"] },
    payload: { theme: "classic-dark" },
  });
  assert.equal(denied.statusCode, 403);
  const saved = await f.app.inject({
    method: "PATCH",
    url: "/api/preferences",
    headers: fresh,
    payload: { theme: "classic-dark" },
  });
  assert.equal(saved.statusCode, 200, saved.body);
});

test("logout-all revokes sockets, recovery links and a login already verifying the old credentials", async (t) => {
  const f = await fixture(t),
    recovery = await f.link("recovery.txt"),
    socket = await f.connect("/api/auth/watch");
  const closed = once(socket, "close");
  // Verification yields; revocation must win before it is allowed to issue a session.
  const late = f.auth.login(f.password, {
    setCookie() {
      throw Error("A revoked login issued a cookie");
    },
  });
  const rejected = assert.rejects(late, { code: "LOGIN_FAILED" });
  assert.equal((await f.post("logout-all", undefined, f.owner)).statusCode, 200);
  await rejected;
  assert.equal((await closed)[0], 1008);
  assert.equal((await f.session(f.owner)).statusCode, 401);
  assert.equal(
    (await f.post("recover", { token: recovery.token, password: secret() })).statusCode,
    403,
  );
  assert.equal((await f.post("login", { password: f.password })).statusCode, 200);
});

test("recovery expires, replaces earlier links, permits one concurrent redemption and invalidates old sessions", async (t) => {
  const f = await fixture(t),
    a = await f.link("a.txt"),
    b = await f.link("b.txt");
  assert(Date.parse(b.metadata.expiresAt) > Date.now() + 14 * 60000);
  assert(Date.parse(b.metadata.expiresAt) <= Date.now() + 15 * 60000);
  assert.equal((await f.post("recover", { token: a.token, password: secret() })).statusCode, 403);
  f.store.db.prepare("UPDATE auth_state SET recoveryExpires=?").run(Date.now() - 1);
  assert.equal((await f.post("recover", { token: b.token, password: secret() })).statusCode, 403);
  const c = await f.link("c.txt"),
    password = secret();
  const socket = await f.connect("/api/auth/watch"),
    closed = once(socket, "close");
  const results = await Promise.all([
    f.post("recover", { token: c.token, password }),
    f.post("recover", { token: c.token, password }),
  ]);
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 403 || r.statusCode === 409).length, 1);
  assert.equal((await closed)[0], 1008);
  assert.equal((await f.session(f.owner)).statusCode, 401);
  const fresh = f.headers(results.find((r) => r.statusCode === 200));
  assert.equal((await f.session(fresh)).statusCode, 200);
  assert.equal((await f.post("recover", { token: c.token, password: secret() })).statusCode, 403);
  assert.equal((await f.post("login", { password })).statusCode, 200);
  assert.equal(f.store.db.prepare("SELECT recoveryHash FROM auth_state").get().recoveryHash, null);
});

test("credential endpoints enforce origin, CSRF, strict input and bounded retries", async (t) => {
  const f = await fixture(t);
  for (const url of ["password", "logout-all"]) {
    const payload = url === "password" ? { currentPassword: f.password, password: secret() } : {};
    assert.equal(
      (await f.post(url, payload, { ...f.owner, origin: "https://foreign.example" })).statusCode,
      403,
    );
    assert.equal(
      (await f.post(url, payload, { origin: f.origin, cookie: f.owner.cookie })).statusCode,
      403,
    );
    assert.equal((await f.post(url, { ...payload, extra: "unwanted" }, f.owner)).statusCode, 400);
  }
  assert.equal(
    (
      await f.post(
        "recover",
        { token: "x".repeat(43), password: secret() },
        { origin: "https://foreign.example" },
      )
    ).statusCode,
    403,
  );
  assert.equal((await f.post("recover", { token: "invalid", password: "short" })).statusCode, 400);
  let last;
  for (let i = 0; i < 7; i++)
    last = await f.post("recover", { token: "x".repeat(43), password: secret() });
  assert.equal(last.statusCode, 429);
  assert.equal((await f.session(f.owner)).statusCode, 200);
  const rejected = new WebSocket(
    "ws://127.0.0.1:" + f.app.server.address().port + "/api/auth/watch",
    { headers: { ...f.owner, origin: "https://foreign.example" } },
  );
  rejected.on("error", () => {});
  const status = await new Promise((resolve) =>
    rejected.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode);
      rejected.terminate();
    }),
  );
  assert.equal(status, 403);
});

test("local recovery refuses overwrite and restored snapshots cannot resurrect a reset link", async (t) => {
  const f = await fixture(t),
    link = await f.link("restore-link.txt");
  await assert.rejects(createRecoveryLink(f.config, link.file), { code: "EEXIST" });
  assert.equal(new URL((await readFile(link.file, "utf8")).trim()).hash, "#recover=" + link.token);
  const storedHash = f.store.db.prepare("SELECT passwordHash FROM users").get().passwordHash;
  const snapshot = await createSnapshot(f.config, join(f.root, "snapshots"));
  const target = join(f.root, "restored");
  await restoreSnapshot(snapshot, target);
  const restored = new Store(join(target, "app.db"));
  try {
    assert.equal(
      restored.db.prepare("SELECT recoveryHash FROM auth_state").get().recoveryHash,
      null,
    );
    assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    assert.equal(
      restored.db.prepare("SELECT passwordHash FROM users").get().passwordHash,
      storedHash,
    );
  } finally {
    restored.close();
  }
  assert.equal(
    (await f.session(f.owner)).statusCode,
    200,
    "offline restore must not change live access",
  );
  assert.equal(
    (await f.post("recover", { token: link.token, password: secret() })).statusCode,
    200,
  );
});

test("recovery CLI emits only private-file metadata and has no network issuance step", async (t) => {
  const f = await fixture(t),
    file = join(f.root, "cli-link.txt"),
    configFile = join(f.root, "config.json");
  await writeFile(configFile, JSON.stringify(f.config), { mode: 0o600 });
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "apps/hub/dist/maintenance.js",
    "recovery",
    "--config",
    configFile,
    "--output",
    file,
  ]);
  const link = (await readFile(file, "utf8")).trim(),
    token = new URL(link).hash.slice("#recover=".length);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.path, file);
  assert(!stdout.includes(token));
  assert(!stderr.includes(token));
  assert(!stdout.includes(f.password));
  assert(!stderr.includes(f.password));
  assert.equal((await f.post("recover", { token, password: secret() })).statusCode, 200);
});
