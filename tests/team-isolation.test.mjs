import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { tokenHash } from "../apps/hub/dist/auth.js";
import { createRecoveryLink, createSnapshot } from "../apps/hub/dist/maintenance.js";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { restoreTeamSnapshot, verifyTeamSnapshot } from "../apps/hub/dist/team-maintenance.js";
import WebSocket from "../apps/hub/node_modules/ws/wrapper.mjs";
import { gptSessionAllowed } from "../ops/gpt/session-watch.mjs";
import { configSchema } from "../packages/shared/dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cw-team-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "owner-results"),
    },
    auth: { username: "owner" },
    team: { enabled: true, root: join(root, "team") },
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath),
    password = randomBytes(24).toString("base64url");
  store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", await teamPasswordHash(password));
  const token = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(tokenHash(token), csrf, Date.now() + 86400000);
  const hub = await createTeamHub(config, {
    store,
    socketRoot: join(root, "sock"),
    executionService: true,
  });
  await hub.app.listen({ host: "127.0.0.1", port: 0 });
  const base = "http://127.0.0.1:" + hub.app.server.address().port;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await hub.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const owner = { cookie: `__Host-codex-session=${token}`, "x-csrf-token": csrf };
  const request = async (path, user = owner, method = "GET", body, extra = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        origin: config.hub.publicBaseUrl,
        ...user,
        ...extra,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const invite = await request("/api/team/invitations", owner, "POST", { name: "Друг" });
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  const joinToken = new URL(invite.body.url).hash.slice(6);
  const joined = await request("/api/auth/join", {}, "POST", {
    token: joinToken,
    name: "Друг",
    login: "friend",
    password,
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const friend = {
    cookie: joined.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": joined.body.csrf,
  };
  const connect = async (user) => {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/api/auth/watch", {
      headers: { origin: config.hub.publicBaseUrl, ...user },
    });
    sockets.push(socket);
    const message = once(socket, "message");
    await once(socket, "open");
    await message;
    return socket;
  };
  return {
    ...hub,
    config,
    root,
    base,
    owner,
    friend,
    password,
    joinToken,
    request,
    connect,
    friendId: joined.body.user.id,
  };
}

test("team dispatch preserves owner state and isolates real personal routes even when IDs collide", async (t) => {
  const f = await fixture(t);
  const ownerSession = await f.request("/api/auth/session");
  assert.equal(ownerSession.body.user.id, f.registry.ownerId);
  const noteId = randomUUID(),
    note = (body) => ({ title: body, body, scope: null, revision: 0, links: [] });
  const path = "/api/workspace/notes/" + noteId;
  assert.equal((await f.request(path, f.owner, "PUT", note("OWNER_PRIVATE"))).status, 200);
  assert.equal((await f.request(path, f.friend)).status, 404);
  assert.equal((await f.request(path, f.friend, "PUT", note("FRIEND_PRIVATE"))).status, 200);
  assert.equal((await f.request(path, f.owner)).body.body, "OWNER_PRIVATE");
  assert.equal((await f.request(path, f.friend)).body.body, "FRIEND_PRIVATE");
  const list = await f.request("/api/workspace/notes", f.friend);
  assert(!JSON.stringify(list).includes("OWNER_PRIVATE"));
  const spoof = await f.request(path, f.friend, "GET", undefined, {
    "x-user-id": f.registry.ownerId,
  });
  assert.equal(spoof.body.body, "FRIEND_PRIVATE");
  const privateRuntime = await f.personal(f.friendId);
  assert.deepEqual(privateRuntime.runtime.sessions.config.machines, []);
  assert.deepEqual(privateRuntime.runtime.sessions.config.devices, []);
  assert.equal(privateRuntime.runtime.sessions.config.gpt, undefined);
  assert.notEqual(
    privateRuntime.runtime.store,
    (await f.personal(f.registry.ownerId)).runtime.store,
  );
  assert.equal((await f.request("/api/team/users", f.friend)).status, 403);
  const duplicated = await f.request(path, {
    ...f.friend,
    cookie: `${f.friend.cookie}; ${f.owner.cookie}`,
  });
  assert.equal(duplicated.status, 401);
});

test("invitations are one-use and CSRF, role and last-admin guards apply before mutations", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request("/api/auth/join", {}, "POST", {
        token: f.joinToken,
        login: "third",
        name: "Третий",
        password: f.password,
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/team/invitations", f.friend, "POST", { name: "Нельзя" })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/team/invitations", { cookie: f.owner.cookie }, "POST", {
        name: "Нельзя",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(`/api/team/users/${f.registry.ownerId}/state`, f.owner, "POST", {
        disabled: true,
      })
    ).status,
    409,
  );
  const users = await f.request("/api/team/users");
  assert.equal(users.body.items.length, 2);
  assert(!JSON.stringify(users.body).includes("passwordHash"));
  const wrong = await f.request("/api/auth/login", {}, "POST", {
    login: "friend",
    password: "incorrect",
  });
  assert.equal(wrong.status, 401);
});

test("revocation closes only the disabled user's streams and clears personal ticket sessions", async (t) => {
  const f = await fixture(t),
    ownerSocket = await f.connect(f.owner),
    friendSocket = await f.connect(f.friend);
  const closed = once(friendSocket, "close");
  const disabled = await f.request(`/api/team/users/${f.friendId}/state`, f.owner, "POST", {
    disabled: true,
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  await closed;
  assert.equal(ownerSocket.readyState, WebSocket.OPEN);
  assert.equal((await f.request("/api/workspace/notes", f.friend)).status, 401);
  assert.equal((await f.request("/api/workspace/notes", f.owner)).status, 200);
  assert.equal(
    (await f.request("/api/auth/login", {}, "POST", { login: "friend", password: f.password }))
      .status,
    401,
  );
});

test("team restore retains every identity and personal note, rejects missing namespaces and revokes stale capabilities", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    path = "/api/workspace/notes/" + id;
  for (const [headers, body] of [
    [f.owner, "PRIVATE_OWNER"],
    [f.friend, "PRIVATE_FRIEND"],
  ])
    assert.equal(
      (
        await f.request(path, headers, "PUT", {
          title: body,
          body,
          scope: null,
          revision: 0,
          links: [],
        })
      ).status,
      200,
    );
  const snapshot = await createSnapshot(f.config, join(f.root, "backups"), { keep: 2 });
  const manifest = await verifyTeamSnapshot(snapshot);
  assert.equal(manifest.users.length, 2);
  const restored = join(f.root, "restored");
  await restoreTeamSnapshot(snapshot, restored);
  const registry = new DatabaseSync(join(restored, "team", "team.db"));
  try {
    assert.equal(
      registry.prepare("SELECT value FROM team_meta WHERE key='originalOwner'").get().value,
      f.registry.ownerId,
    );
    assert.equal(registry.prepare("SELECT COUNT(*) n FROM team_sessions").get().n, 0);
    assert.equal(registry.prepare("SELECT COUNT(*) n FROM team_users").get().n, 2);
  } finally {
    registry.close();
  }
  for (const [base, expected] of [
    [join(restored, "owner"), "PRIVATE_OWNER"],
    [join(restored, "team", "users", f.friendId), "PRIVATE_FRIEND"],
  ]) {
    const db = new DatabaseSync(join(base, "app.db"));
    try {
      assert.equal(
        db.prepare("SELECT body FROM workspace_notes WHERE id=?").get(id).body,
        expected,
      );
    } finally {
      db.close();
    }
  }
  await assert.rejects(restoreTeamSnapshot(snapshot, restored), /TEAM_RESTORE_TARGET/);
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.users.find((user) => user.id === f.friendId).snapshot = null;
  await writeFile(join(snapshot, "team-manifest.json"), JSON.stringify(changed));
  await assert.rejects(verifyTeamSnapshot(snapshot), /TEAM_USER_STORAGE_MISSING/);
  changed.users = changed.users.filter((user) => user.id !== f.friendId);
  await writeFile(join(snapshot, "team-manifest.json"), JSON.stringify(changed));
  await assert.rejects(verifyTeamSnapshot(snapshot), /TEAM_OWNER_MAPPING_INVALID/);
});

test("host recovery uses team credentials and password replacement invalidates old sessions without touching another user", async (t) => {
  const f = await fixture(t),
    file = join(f.root, "recovery.txt");
  await createRecoveryLink(f.config, file);
  const token = new URL((await readFile(file, "utf8")).trim()).hash.slice(9),
    password = randomBytes(24).toString("base64url");
  const result = await f.request("/api/auth/recover", {}, "POST", { token, password });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, f.registry.ownerId);
  assert.equal((await f.request("/api/auth/session", f.owner)).status, 401);
  assert.equal((await f.request("/api/auth/session", f.friend)).status, 200);
  assert.equal((await f.request("/api/auth/recover", {}, "POST", { token, password })).status, 403);
  assert.equal(
    (await f.request("/api/auth/login", {}, "POST", { login: "owner", password })).status,
    200,
  );
});

test("old tabs cannot read or change the newly selected account; replacing login revokes only the replaced browser", async (t) => {
  const f = await fixture(t);
  const mismatch = { "x-workspace-id": f.registry.ownerId };
  assert.equal(
    (await f.request("/api/workspace/notes", f.friend, "GET", undefined, mismatch)).status,
    401,
  );
  assert.equal(
    (await f.request("/api/auth/logout", f.friend, "POST", undefined, mismatch)).status,
    401,
  );
  assert.equal((await f.request("/api/auth/session", f.friend)).status, 200);
  const second = await f.request("/api/auth/login", {}, "POST", {
    login: "owner",
    password: f.password,
  });
  const secondOwner = {
    cookie: second.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": second.body.csrf,
  };
  const secondSocket = await f.connect(secondOwner),
    firstSocket = await f.connect(f.owner),
    closed = once(firstSocket, "close");
  const switched = await f.request("/api/auth/login", f.owner, "POST", {
    login: "friend",
    password: f.password,
  });
  assert.equal(switched.status, 200);
  await closed;
  assert.equal(secondSocket.readyState, WebSocket.OPEN);
  assert.equal((await f.request("/api/auth/session", f.owner)).status, 401);
  assert.equal((await f.request("/api/auth/session", secondOwner)).status, 200);
});

test("the native GPT gateway rejects another account including a member carrying an old gateway cookie", async (t) => {
  const f = await fixture(t);
  const owner = (await f.request("/api/auth/session")).body;
  const friend = (await f.request("/api/auth/session", f.friend)).body;
  assert(gptSessionAllowed(owner));
  assert(!gptSessionAllowed(friend));
  assert(gptSessionAllowed(friend, f.friendId));
  assert(!gptSessionAllowed(owner, f.friendId));
  assert(
    !gptSessionAllowed({ ...friend, user: { ...friend.user, state: "disabled" } }, f.friendId),
  );
  assert(gptSessionAllowed({ authenticated: true }));
  assert(!gptSessionAllowed({ authenticated: true }, f.friendId));
  const legacyGateway = await f.app.inject({
    url: "/api/auth/session",
    headers: { cookie: f.friend.cookie },
  });
  assert.equal(legacyGateway.statusCode, 403);
});

test("administrator role changes require current roles, revoke old sessions and cannot remove the last admin", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request(`/api/team/users/${f.friendId}/role`, f.owner, "POST", {
        role: "admin",
        expectedRole: "member",
      })
    ).status,
    200,
  );
  assert.equal((await f.request("/api/team/me", f.friend)).status, 401);
  assert.equal(
    (
      await f.request(`/api/team/users/${f.friendId}/role`, f.owner, "POST", {
        role: "member",
        expectedRole: "member",
      })
    ).status,
    409,
  );
  const login = await f.request("/api/auth/login", {}, "POST", {
    login: "friend",
    password: f.password,
  });
  const admin = {
    cookie: login.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": login.body.csrf,
  };
  assert.equal(
    (
      await f.request(`/api/team/users/${f.registry.ownerId}/role`, admin, "POST", {
        role: "member",
        expectedRole: "admin",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(`/api/team/users/${f.friendId}/role`, admin, "POST", {
        role: "member",
        expectedRole: "admin",
      })
    ).status,
    409,
  );
  const audit = await f.request("/api/team/audit", admin);
  assert(
    audit.body.items.some(
      (item) => item.action === "team.request_denied" && item.outcome === "denied",
    ),
  );
  assert(!JSON.stringify(audit.body).includes(f.password));
});

test("private artifact bytes and copied download URLs stay scoped even for administrators", async (t) => {
  const f = await fixture(t),
    { runtime } = await f.personal(f.friendId);
  // Metadata-only fixture; no native process is launched to read a saved artifact.
  runtime.sessions.config.machines.push({
    id: "test-machine",
    name: "Test",
    type: "local-linux",
    codex: { command: "/nonexistent", shell: "powershell" },
  });
  runtime.sessions.config.projects.push({
    id: "test-project",
    machineId: "test-machine",
    name: "Private",
    workingDirectory: f.root,
    enabled: true,
  });
  const thread = runtime.store.createThread("test-project", randomUUID(), "PRIVATE_THREAD");
  const artifacts = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.store);
  const result = artifacts.putFile(
    thread.id,
    null,
    "private.txt",
    "private.txt",
    "text/plain",
    Buffer.from("FRIEND_PRIVATE_BYTES"),
  );
  const response = await fetch(f.base + result.url, { headers: f.friend });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "FRIEND_PRIVATE_BYTES");
  assert.equal((await f.request(result.url, f.owner)).status, 404);
  assert.equal((await f.request(`/api/threads/${thread.id}/history`, f.owner)).status, 404);
});

test("engine maintenance considers another user's unknown work and releases failed freezes", async (t) => {
  const f = await fixture(t),
    { runtime } = await f.personal(f.friendId);
  f.registry.db
    .prepare("INSERT INTO team_receipts VALUES(?,?,?,?,?,?,?)")
    .run(f.friendId, "test", "key", "digest", "unknown", "{}", Date.now());
  let result = await f.request("/internal/terminals/maintenance", {}, "POST");
  assert.equal(result.body.reserved, false);
  assert(result.body.work > 0);
  assert.equal(
    (await f.request("/api/team/invitations", f.owner, "POST", { name: "После проверки" })).status,
    200,
  );
  f.registry.db.exec("DELETE FROM team_receipts");
  // A disabled account's durable personal outbox is still an update blocker.
  runtime.store.db
    .prepare(
      "INSERT INTO commands(key,scope,digest,state,response,createdAt) VALUES(?,?,'digest','pending','{}',?)",
    )
    .run("test-maintenance", "test", new Date().toISOString());
  await f.request(`/api/team/users/${f.friendId}/state`, f.owner, "POST", { disabled: true });
  result = await f.request("/internal/terminals/maintenance", {}, "POST");
  assert.equal(result.body.reserved, false);
  assert(result.body.work > 0);
  runtime.store.db.exec("DELETE FROM commands WHERE key='test-maintenance'");
  const results = await Promise.all([
    f.request("/internal/terminals/maintenance", {}, "POST"),
    f.request("/internal/terminals/maintenance", {}, "POST"),
  ]);
  for (const item of results) assert.equal(item.body.reserved, true, JSON.stringify(item.body));
  assert.equal(
    (await f.request("/api/team/invitations", f.owner, "POST", { name: "Сейчас нельзя" })).status,
    503,
  );
  assert.equal((await f.request("/api/workspace/notes", f.owner)).status, 200);
  assert.throws(() => runtime.sessions.authorizeExecution(), /./);
});
