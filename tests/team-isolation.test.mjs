import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createApp } from "../apps/hub/dist/app.js";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { tokenHash } from "../apps/hub/dist/auth.js";
import { enrolledRuntime } from "../apps/hub/dist/machine-enrollment.js";
import { enrollmentReport, hostFingerprint } from "../apps/hub/dist/machine-enrollment-store.js";
import { createRecoveryLink, createSnapshot } from "../apps/hub/dist/maintenance.js";
import { GuacParser, instruction } from "../apps/hub/dist/remote.js";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { TeamGpt, teamGptName } from "../apps/hub/dist/team-gpt.js";
import { reconcileGptProfiles } from "../apps/hub/dist/team-gpt-host.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { restoreTeamSnapshot, verifyTeamSnapshot } from "../apps/hub/dist/team-maintenance.js";
import { unzipSync } from "../apps/hub/node_modules/fflate/esm/index.mjs";
import WebSocket from "../apps/hub/node_modules/ws/wrapper.mjs";
import { gptSessionAllowed } from "../ops/gpt/session-watch.mjs";
import { teamConnection } from "../ops/gpt/team-connection.mjs";
import { configSchema } from "../packages/shared/dist/index.js";

async function fixture(t, options = {}) {
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
    ...options,
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
    assert.equal(
      registry.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get().value,
      "blocked",
      "restoration cannot reacquire a live native writer",
    );
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

test("computer enrollment uses a distinct token, reviewed identity and owner-only transport keys", async (t) => {
  let verified = 0;
  const f = await fixture(t, {
    enrollmentVerifier: async (_config, row) => {
      assert.equal(row.state, "reported");
      verified++;
    },
  });
  f.config.team.hubTailnetAddress = "100.64.0.1";
  const intent = {
    name: "Личный ПК",
    request: { id: randomUUID(), token: randomBytes(32).toString("base64url") },
  };
  const created = await f.request("/api/team/machines", f.friend, "POST", intent);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const { enrollment, token } = created.body;
  const keys = JSON.parse(f.enrollments.row(enrollment.id).keys);
  assert.deepEqual(
    (await f.request("/api/team/machines", f.friend, "POST", intent)).body,
    created.body,
    "lost creation acknowledgement recovers the same installer",
  );
  assert.deepEqual(
    JSON.parse(f.enrollments.row(enrollment.id).keys),
    keys,
    "retry keeps the original SSH keys",
  );
  assert.equal(
    (await f.request("/api/team/machines", f.friend, "POST", { ...intent, name: "Changed" }))
      .status,
    409,
  );
  assert.equal((await f.request("/api/team/machines", f.owner, "POST", intent)).status, 409);
  assert.notEqual(keys.command, keys.terminal);
  assert(
    !JSON.stringify((await f.request("/api/team/machines", f.friend)).body).includes("PRIVATE KEY"),
  );
  assert.equal(
    (await f.request(`/api/team/machines/${enrollment.id}/bundle`, f.owner, "POST", { token }))
      .status,
    404,
  );
  assert.equal((await f.request("/api/auth/invitation", {}, "POST", { token })).status, 403);
  assert.equal(
    (
      await f.request("/api/workspace/notes", {}, "GET", undefined, {
        authorization: `Bearer ${token}`,
      })
    ).status,
    401,
  );
  const archive = await f.request(`/api/team/machines/${enrollment.id}/bundle`, f.friend, "POST", {
    token,
  });
  assert.equal(archive.status, 200, JSON.stringify(archive.body));
  const files = unzipSync(Buffer.from(archive.body.base64, "base64"));
  assert.deepEqual(Object.keys(files).sort(), [
    "Connect-CodexWeb.ps1",
    "Connect.cmd",
    "README.txt",
  ]);
  const script = Buffer.from(files["Connect-CodexWeb.ps1"]).toString("utf8");
  assert(script.startsWith("\uFEFF"));
  const encoded = /\$encoded = '([A-Za-z0-9+/=]+)'/.exec(script)[1];
  const payload = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")));
  assert.equal(payload.descriptor.token, token);
  assert.equal(payload.descriptor.commandKey, keys.commandPublic);
  assert(!JSON.stringify(payload).includes("PRIVATE KEY"));
  for (const file of payload.files)
    if (file.name.endsWith(".ps1"))
      assert(Buffer.from(file.data, "base64").toString("utf8").startsWith("\uFEFF"), file.name);
  const report = {
    version: 1,
    address: "100.64.0.2",
    hostKey: keys.commandPublic,
    machineGuid: randomUUID(),
    sid: "S-1-5-21-111-222-333-1001",
    username: "friend",
    profile: "C:\\Users\\Friend",
    roots: ["D:\\Projects"],
    readiness: {
      companion: true,
      codex: true,
      node: true,
      git: true,
      github: true,
      desktop: false,
    },
  };
  const reportHeaders = { authorization: `Bearer ${token}` };
  assert.equal(
    (await f.request("/api/machine-enrollment/report", f.friend, "POST", report, reportHeaders))
      .status,
    403,
    "ambient session cannot substitute script authentication",
  );
  assert.equal(
    (
      await f.request(
        "/api/machine-enrollment/report",
        {},
        "POST",
        { ...report, address: "127.0.0.1" },
        reportHeaders,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "/api/machine-enrollment/report",
        {},
        "POST",
        { ...report, address: "100.64.0.1" },
        reportHeaders,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/api/machine-enrollment/report", {}, "POST", report, reportHeaders)).status,
    200,
  );
  assert.equal(
    (await f.request("/api/machine-enrollment/report", {}, "POST", report, reportHeaders)).status,
    200,
    "exact report retry",
  );
  assert.equal(
    (
      await f.request(
        "/api/machine-enrollment/report",
        {},
        "POST",
        { ...report, roots: ["D:\\Other"] },
        reportHeaders,
      )
    ).status,
    409,
  );
  const fingerprint = hostFingerprint(report.hostKey);
  assert.equal(
    (
      await f.request(`/api/team/machines/${enrollment.id}/approve`, f.friend, "POST", {
        fingerprint,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(`/api/team/machines/${enrollment.id}/approve`, f.owner, "POST", {
        fingerprint: "SHA256:changed",
      })
    ).status,
    409,
  );
  const approved = await f.request(`/api/team/machines/${enrollment.id}/approve`, f.owner, "POST", {
    fingerprint,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(verified, 1);
  assert.equal(
    (await f.request(`/api/team/machines/${enrollment.id}/bundle`, f.friend, "POST", { token }))
      .status,
    200,
    "the exact unexpired installer remains recoverable after approval",
  );
  assert.equal(
    (await f.request("/api/machine-enrollment/report", {}, "POST", report, reportHeaders)).status,
    200,
    "lost report acknowledgement after approval",
  );
  const selected = enrolledRuntime(f.config, f.registry, f.friendId);
  assert.equal(selected.machines.length, 1);
  assert.equal(enrolledRuntime(f.config, f.registry, f.registry.ownerId).machines.length, 0);
  assert.deepEqual(selected.machines[0].allowedProjectRoots, report.roots);
  const ssh = await readFile(selected.machines[0].ssh.configFile, "utf8");
  assert.match(ssh, /StrictHostKeyChecking yes/);
  assert.match(ssh, /IdentitiesOnly yes/);
  assert(!ssh.includes("ProxyCommand"));
  const snapshot = await createSnapshot(f.config, join(f.root, "enrollment-backups"), { keep: 2 });
  const target = join(f.root, "enrollment-restored");
  await restoreTeamSnapshot(snapshot, target);
  const restoredRegistry = new DatabaseSync(join(target, "team", "team.db"));
  try {
    const saved = restoredRegistry
      .prepare("SELECT * FROM team_machine_enrollments WHERE id=?")
      .get(enrollment.id);
    assert.equal(saved.ownerId, f.friendId);
    assert.equal(saved.report, f.enrollments.row(enrollment.id).report);
    assert.equal(saved.keys, f.enrollments.row(enrollment.id).keys);
    assert.equal(saved.state, "approved");
    assert.equal(
      restoredRegistry.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()
        .value,
      "blocked",
    );
  } finally {
    restoredRegistry.close();
  }
  // Store-only transport materialization performs no SSH/RPC. Do not activate fixture fake computers.
  f.enrollments.revoke(f.friendId, enrollment.id);
  assert.equal(enrolledRuntime(f.config, f.registry, f.friendId).machines.length, 0);
  assert.equal(
    (await f.request("/api/machine-enrollment/report", {}, "POST", report, reportHeaders)).status,
    404,
  );
});

test("personal runtime activation keeps the owner store and refuses concurrent or uncertain work", async (t) => {
  const f = await fixture(t),
    original = await f.personal(f.friendId),
    owner = await f.personal(f.registry.ownerId);
  original.runtime.store.db
    .prepare(
      "INSERT INTO commands(key,scope,digest,state,response,createdAt) VALUES('activation','test','digest','pending','{}',?)",
    )
    .run(new Date().toISOString());
  assert.equal((await f.request("/api/team/machines/apply", f.friend, "POST")).status, 409);
  assert.equal(await f.personal(f.friendId), original);
  original.runtime.store.db.exec("DELETE FROM commands WHERE key='activation'");
  const activated = await f.request("/api/team/machines/apply", f.friend, "POST");
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.notEqual(await f.personal(f.friendId), original);
  assert.equal(await f.personal(f.registry.ownerId), owner);
  assert.equal((await f.request("/api/team/machines/apply", f.owner, "POST")).status, 200);
  assert.equal((await f.request("/api/workspace/notes", f.owner)).status, 200);
  assert.equal((await f.request("/api/auth/session", f.owner)).status, 200);
});

test("enrollment paths and host keys reject command injection and malformed native identities", () => {
  const blob = Buffer.alloc(51);
  blob.writeUInt32BE(11, 0);
  blob.write("ssh-ed25519", 4);
  blob.writeUInt32BE(32, 15);
  const base = {
    version: 1,
    address: "100.70.80.90",
    hostKey: "ssh-ed25519 " + blob.toString("base64"),
    machineGuid: randomUUID(),
    sid: "S-1-5-21-1-2-3-1001",
    username: "friend",
    profile: "C:\\Users\\Friend",
    roots: ["D:\\Projects"],
    readiness: {
      companion: true,
      codex: true,
      node: true,
      git: true,
      github: false,
      desktop: false,
    },
  };
  for (const patch of [
    { address: "example.com" },
    { address: "100.128.0.1" },
    { address: "100.064.0.2" },
    { username: "friend\nProxyCommand x" },
    { roots: ["D:\\Projects:secret"] },
    { profile: "\\\\server\\profile" },
    { hostKey: "ssh-ed25519 " + Buffer.alloc(51).toString("base64") },
    { roots: [] },
  ])
    assert.throws(() => enrollmentReport({ ...base, ...patch }));
  assert.deepEqual(enrollmentReport(base).roots, ["D:\\Projects"]);
  assert.equal(
    enrollmentReport({ ...base, username: "Иван Иванов", profile: "C:\\Users\\Иван" }).username,
    "Иван Иванов",
  );
});

test("failed personal startup releases session listeners and can be explicitly retried", async (t) => {
  let fail = true;
  const f = await fixture(t, {
    personalFactory: async (config, options) => {
      const runtime = await createApp(config, options);
      if (config.auth.username === "friend" && fail) {
        fail = false;
        runtime.app.addHook("onReady", async () => {
          throw Error("FIXTURE_STARTUP_FAILURE");
        });
      }
      return runtime;
    },
  });
  const before = f.registry.events.listenerCount("sessions");
  await assert.rejects(f.personal(f.friendId), /FIXTURE_STARTUP_FAILURE/);
  assert.equal(f.registry.events.listenerCount("sessions"), before);
  assert.equal(
    (await f.request("/api/team/machines", f.friend)).status,
    200,
    "connection recovery stays accessible",
  );
  assert.equal((await f.request("/api/team/machines/apply", f.friend, "POST")).status, 200);
  assert.equal((await f.request("/api/workspace/notes", f.friend)).status, 200);
});

test("personal GPT provisioning is idempotent and never reuses another account, profile, or gateway identity", async (t) => {
  const f = await fixture(t);
  f.config.team.gptProfiles = { enabled: true, maxProfiles: 2, portBase: 8900 };
  const service = new TeamGpt(f.config, f.registry);
  assert.equal(
    (await f.request("/api/team/gpt", f.friend, "POST", { userId: f.registry.ownerId })).status,
    400,
  );
  assert.equal((await f.request("/api/team/gpt", f.friend, "POST", {})).status, 200);
  const row = service.row(f.friendId);
  assert.equal(service.runtime(f.friendId), undefined);
  assert.equal((await f.request("/api/team/gpt", f.friend, "POST", {})).status, 200);
  assert.deepEqual(service.row(f.friendId), row);
  assert(
    !JSON.stringify((await f.request("/api/team/gpt", f.friend)).body).includes(row.serviceToken),
  );
  assert.equal(service.row(f.registry.ownerId), undefined);
  const commands = [],
    networks = new Map(),
    containers = new Map();
  const run = async (args) => {
    commands.push(args);
    if (args[0] === "network" && args[1] === "ls") return [...networks.keys()].join("\n");
    if (args[0] === "container" && args[1] === "ls") return [...containers.keys()].join("\n");
    if (args[1] === "inspect")
      return JSON.stringify([(args[0] === "network" ? networks : containers).get(args[2])]);
    const labels = Object.fromEntries(
      args.flatMap((arg, i) => (arg === "--label" ? [args[i + 1].split("=")] : [])),
    );
    if (args[0] === "network" && args[1] === "create") {
      networks.set(args.at(-1), {
        Labels: labels,
        Driver: "bridge",
        Internal: args.includes("--internal"),
        Options: {
          "com.docker.network.bridge.gateway_mode_ipv4": args.includes("--internal")
            ? "isolated"
            : "nat",
        },
      });
      return "network";
    }
    if (args[0] === "create") {
      const get = (flag) => args[args.indexOf(flag) + 1];
      const imageIndex = args.findIndex(
        (arg) => arg.startsWith("codex-web-gpt:") || arg.startsWith("guacamole/guacd:"),
      );
      containers.set(get("--name"), {
        Config: {
          Labels: labels,
          Image: args[imageIndex],
          User: get("--user"),
          Cmd: args.slice(imageIndex + 1),
          Env: args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]] : [])),
        },
        State: { Running: false },
        Mounts: args.includes("--mount")
          ? [
              {
                Type: "bind",
                Source: get("--mount").split("source=")[1].split(",")[0],
                Destination: "/data",
              },
            ]
          : [],
        HostConfig: {
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PortBindings: Object.fromEntries(
            args.flatMap((arg, i) =>
              arg === "--publish"
                ? [
                    [
                      args[i + 1].split(":")[2] + "/tcp",
                      [{ HostIp: "127.0.0.1", HostPort: args[i + 1].split(":")[1] }],
                    ],
                  ]
                : [],
            ),
          ),
        },
        NetworkSettings: { Networks: { [get("--network")]: {} } },
      });
      return "container";
    }
    if (args[0] === "network" && args[1] === "connect") {
      containers.get(args[3]).NetworkSettings.Networks[args[2]] = {};
      return "";
    }
    if (args[0] === "start") {
      containers.get(args[1]).State.Running = true;
      return "started";
    }
    throw Error("UNEXPECTED_FIXTURE_DOCKER_COMMAND");
  };
  const options = { image: "codex-web-gpt:75a5929", run, health: async () => false };
  await reconcileGptProfiles(f.config, f.registry.db, options);
  assert.equal(
    service.row(f.friendId).state,
    "requested",
    "startup delay is not a failed or duplicate profile",
  );
  const outcome = await reconcileGptProfiles(f.config, f.registry.db, {
    ...options,
    health: async (endpoint, token) => {
      assert.equal(endpoint, "http://127.0.0.1:8900/service-health");
      assert.equal(token, row.serviceToken);
      return true;
    },
  });
  assert.equal(outcome.prepared, 1);
  assert.equal(commands.filter((args) => args[0] === "create").length, 3);
  assert.equal(commands.filter((args) => args[0] === "start").length, 3);
  assert(!JSON.stringify(commands).includes(row.serviceToken));
  assert.equal(process.env[service.runtime(f.friendId).tokenSecret], row.serviceToken);
  assert.equal(service.runtime(f.registry.ownerId), undefined);
  assert.equal(service.connection(f.friendId).host, teamGptName(f.friendId));
  f.registry.db
    .prepare("UPDATE team_gpt_profiles SET state='requested' WHERE userId=?")
    .run(f.friendId);
  const container = containers.get(teamGptName(f.friendId) + "-edge");
  container.HostConfig.PortBindings["8786/tcp"][0].HostIp = "0.0.0.0";
  assert.equal((await reconcileGptProfiles(f.config, f.registry.db, options)).failed, 1);
  assert.equal(service.row(f.friendId).code, "GPT_CONTAINER_IDENTITY_CHANGED");
  assert.equal(service.runtime(f.friendId), undefined);
  container.HostConfig.PortBindings["8786/tcp"][0].HostIp = "127.0.0.1";
  service.request(f.friendId);
  await reconcileGptProfiles(f.config, f.registry.db, { ...options, health: async () => true });
  const socketPath = join(f.root, "gateway.sock");
  const gateway = createServer(async (req, res) => {
    const reply = await f.app.inject({ method: "GET", url: req.url, headers: req.headers });
    res.writeHead(reply.statusCode, { "content-type": "application/json" }).end(reply.body);
  });
  await new Promise((resolve) => gateway.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const connection = await teamConnection(
    socketPath,
    f.friend.cookie,
    f.config.hub.publicBaseUrl,
    f.friendId,
  );
  assert.equal(connection.password, row.vncPassword);
  assert.equal(connection.gatewayPort, 9000);
  await assert.rejects(
    teamConnection(socketPath, f.owner.cookie, f.config.hub.publicBaseUrl, f.friendId),
  );
  await assert.rejects(
    teamConnection(socketPath, f.friend.cookie, f.config.hub.publicBaseUrl, f.registry.ownerId),
  );
  assert.equal((await f.request("/api/internal/gpt/connection", f.friend)).status, 404);
  f.registry.disable(f.registry.ownerId, f.friendId, true);
  await assert.rejects(
    teamConnection(socketPath, f.friend.cookie, f.config.hub.publicBaseUrl, f.friendId),
  );
  f.registry.disable(f.registry.ownerId, f.friendId, false);
  f.registry.db
    .prepare("INSERT OR REPLACE INTO team_meta VALUES('nativeAdmission','blocked')")
    .run();
  assert.equal(service.runtime(f.friendId), undefined);
  await assert.rejects(
    reconcileGptProfiles(f.config, f.registry.db, options),
    /RESTORE_ADMISSION_REQUIRED/,
  );
  await assert.rejects(
    teamConnection(socketPath, f.friend.cookie, f.config.hub.publicBaseUrl, f.friendId),
  );
});

test("protected GPT connection page and live Remote bind one user and close on revocation", async (t) => {
  const f = await fixture(t),
    connected = [],
    sockets = new Set();
  const guacd = tcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const parser = new GuacParser();
    socket.on("data", (data) => {
      for (const parts of parser.feed(String(data))) {
        if (parts[0] === "select")
          socket.write(instruction("args", "hostname", "port", "password"));
        if (parts[0] === "connect") {
          connected.push(parts.slice(1));
          socket.write(instruction("ready", "fixture"));
        }
      }
    });
  });
  await new Promise((resolve) => guacd.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => guacd.close(resolve));
  });
  const remotePort = guacd.address().port;
  assert(remotePort >= 9000 && remotePort <= 65109);
  f.config.team.gptProfiles = { enabled: true, maxProfiles: 2, portBase: remotePort - 100 };
  const service = new TeamGpt(f.config, f.registry);
  service.request(f.friendId);
  f.registry.db
    .prepare("UPDATE team_gpt_profiles SET state='ready' WHERE userId=?")
    .run(f.friendId);
  const row = service.row(f.friendId),
    socketPath = join(f.root, "login.sock");
  const uds = createServer(async (req, res) => {
    const reply = await f.app.inject({ method: "GET", url: req.url, headers: req.headers });
    res.writeHead(reply.statusCode, { "content-type": "application/json" }).end(reply.body);
  });
  await new Promise((resolve) => uds.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => uds.close(resolve)));
  const portProbe = tcpServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const process = spawn(globalThis.process.execPath, ["ops/gpt/login-gateway.mjs"], {
    env: {
      ...globalThis.process.env,
      GPT_PUBLIC_ORIGIN: f.config.hub.publicBaseUrl,
      GPT_HUB_URL: f.base,
      HUB_ENGINE_SOCKET: socketPath,
      GPT_GATEWAY_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (process.exitCode === null) {
      process.kill("SIGTERM");
      await once(process, "exit");
    }
  });
  await new Promise((resolve, reject) => {
    process.stdout.once("data", resolve);
    process.once("error", reject);
    process.once("exit", () => reject(Error("gateway startup failed")));
  });
  const page = await fetch(`http://127.0.0.1:${port}/gpt-connect`, {
    headers: { cookie: f.friend.cookie },
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(html.includes(`content="${f.friendId}"`));
  assert(!html.includes(row.vncPassword));
  const denied = async (workspace) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/gpt-connect/remote?workspace=${workspace}`,
        { headers: { Cookie: f.friend.cookie, Origin: f.config.hub.publicBaseUrl } },
      );
      socket.on("unexpected-response", (_, res) => {
        res.resume();
        socket.terminate();
        resolve(res.statusCode);
      });
      socket.on("error", () => {});
      socket.on("open", () => {
        socket.terminate();
        reject(Error("unexpected cross-workspace connection"));
      });
    });
  assert.equal(await denied(f.registry.ownerId), 401);
  assert.equal(await denied(""), 401);
  const live = new WebSocket(`ws://127.0.0.1:${port}/gpt-connect/remote?workspace=${f.friendId}`, {
    headers: { Cookie: f.friend.cookie, Origin: f.config.hub.publicBaseUrl },
  });
  t.after(() => live.terminate());
  await once(live, "message");
  assert.deepEqual(connected, [[teamGptName(f.friendId), "5900", row.vncPassword]]);
  const closed = once(live, "close");
  f.registry.disable(f.registry.ownerId, f.friendId, true);
  await closed;
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/gpt-connect`, { headers: { cookie: f.friend.cookie } }))
      .status,
    401,
  );
});
