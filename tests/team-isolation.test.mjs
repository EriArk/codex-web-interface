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
import { createTeamHub, privateConfig } from "../apps/hub/dist/team-hub.js";
import { restoreTeamSnapshot, verifyTeamSnapshot } from "../apps/hub/dist/team-maintenance.js";
import { memberSetupStatus } from "../apps/hub/dist/team-onboarding.js";
import { unzipSync } from "../apps/hub/node_modules/fflate/esm/index.mjs";
import WebSocket from "../apps/hub/node_modules/ws/wrapper.mjs";
import { gptSessionAllowed } from "../ops/gpt/session-watch.mjs";
import { teamConnection } from "../ops/gpt/team-connection.mjs";
import { listenNative, NativeReadService } from "../ops/gpt-native/service.mjs";
import { configSchema } from "../packages/shared/dist/index.js";

async function fixture(t, options = {}, ownerLogin) {
  const root = await mkdtemp(join(tmpdir(), "cw-team-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "owner-results"),
    },
    auth: { username: "owner", ownerLogin },
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

test("chosen owner login preserves the original password, legacy lookup and existing session", async (t) => {
  const f = await fixture(t, {}, "eriark");
  const owner = f.registry.user(f.registry.ownerId);
  assert.equal(owner.login, "eriark");
  const runtime = (await f.personal(owner.id)).runtime;
  const original = runtime.sessions.store.db
    .prepare("SELECT username,passwordHash FROM users")
    .all();
  assert.equal(original.length, 1);
  assert.equal(original[0].username, "owner");
  assert.equal(owner.passwordHash, original[0].passwordHash);
  assert.equal((await f.request("/api/auth/session")).body.user.id, owner.id);
  const login = await f.request("/api/auth/login", {}, "POST", {
    login: "eriark",
    password: f.password,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, owner.id);
  assert.equal(
    (await f.request("/api/auth/login", {}, "POST", { password: f.password })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/auth/login", {}, "POST", { login: "owner", password: f.password }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {}, "POST", {
        login: "eriark",
        password: "incorrect-password",
      })
    ).status,
    401,
  );
  const invite = await f.request("/api/team/invitations", f.owner, "POST", { name: "Another" });
  const token = new URL(invite.body.url).hash.slice(6);
  const collision = await f.request("/api/auth/join", {}, "POST", {
    token,
    login: "eriark",
    name: "Another",
    password: f.password,
  });
  assert.equal(collision.status, 409);
});

test("pausing new registrations leaves existing owner login and project work available", async (t) => {
  const f = await fixture(t, {}, "eriark");
  const invite = await f.request("/api/team/invitations", f.owner, "POST", { name: "Later" });
  f.config.team.registrationEnabled = false;
  assert.equal((await f.request("/api/team/users")).body.registrationEnabled, false);
  assert.equal(
    (await f.request("/api/team/invitations", f.owner, "POST", { name: "Later" })).status,
    503,
  );
  assert.equal(
    (
      await f.request("/api/auth/join", {}, "POST", {
        token: new URL(invite.body.url).hash.slice(6),
        login: "later",
        name: "Later",
        password: f.password,
      })
    ).status,
    503,
  );
  const login = await f.request("/api/auth/login", {}, "POST", {
    login: "eriark",
    password: f.password,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.originalOwner, true);
  const id = randomUUID();
  assert.equal(
    (
      await f.request(`/api/team/projects/${id}`, f.owner, "PUT", {
        title: "My shared project",
        visibility: "shared",
        repository: null,
      })
    ).status,
    200,
  );
  assert.equal(f.registry.db.prepare("SELECT count(*) n FROM team_users").get().n, 2);
});

async function sharedFixture(t, role = "collaborator") {
  const f = await fixture(t),
    projectId = randomUUID(),
    path = "/api/team/projects/" + projectId;
  const created = await f.request(path, f.owner, "PUT", {
    title: "Общий проект",
    visibility: "shared",
    repository: null,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const headers = () => ({ "idempotency-key": randomUUID() });
  const invitation = await f.request(
    path + "/invitations",
    f.owner,
    "POST",
    { login: "friend", role, revision: 1 },
    headers(),
  );
  assert.equal(invitation.status, 200, JSON.stringify(invitation.body));
  assert.equal((await f.request(path, f.friend)).status, 404, "invitation does not grant access");
  assert.equal(
    (
      await f.request(
        "/api/team/project-invitations/" + invitation.body.id,
        f.friend,
        "POST",
        { accept: true },
        headers(),
      )
    ).status,
    200,
  );
  return { ...f, projectId, path, headers };
}

test("shared technical previews use only published assets, exact bytes and live membership even with a warm cache", async (t) => {
  const f = await sharedFixture(t);
  const bytes = await readFile(new URL("./fixtures/technical/cube.stp", import.meta.url));
  const runtime = (await f.personal(f.registry.ownerId)).runtime;
  const scope = { client: "codex", projectId: "private-files", name: "Private files" };
  const thread = runtime.store.createThread(scope.projectId, randomUUID(), "Private CAD");
  const artifact = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.store).putFile(
    thread.id,
    null,
    "case.step",
    "/private/case.step",
    "application/octet-stream",
    bytes,
  );
  const input = { scope, items: [{ kind: "file", id: artifact.artifactId }] };
  const preview = await f.request(f.path + "/publication-preview", f.owner, "POST", input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const file = preview.body.items[0].files[0];
  const body = {
    source: { kind: "file", download: f.path + "/assets/" + file.id },
    format: "step",
    sha256: file.sha256,
  };
  const convert = (actor) => f.request("/api/team/previews/technical", actor, "POST", body);
  assert.equal((await convert(f.friend)).status, 404, "unpublished source remains private");
  assert.equal((await convert(f.owner)).status, 200);
  const published = await f.request(
    f.path + "/publications",
    f.owner,
    "POST",
    { ...input, fingerprint: preview.body.fingerprint, files: preview.body.files },
    f.headers(),
  );
  assert.equal(published.status, 200);
  const visible = await convert(f.friend);
  assert.equal(visible.status, 200, JSON.stringify(visible.body));
  assert.equal(visible.body.triangles, 12);
  assert.equal((await convert(f.friend)).status, 200, "authorized warm cache");
  f.teamProjects.member(f.registry.ownerId, f.projectId, f.friendId, randomUUID(), {
    revision: 1,
    role: "viewer",
    remove: true,
  });
  assert.equal((await convert(f.friend)).status, 404, "revocation closes warm derivative access");
});

test("selected private files become immutable shared copies, with revocation and verified backup restore", async (t) => {
  const f = await sharedFixture(t),
    runtime = (await f.personal(f.registry.ownerId)).runtime,
    scope = { client: "codex", projectId: "private-files", name: "Личная папка" },
    thread = runtime.store.createThread(scope.projectId, randomUUID(), "Private source chat"),
    original = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.store).putFile(
      thread.id,
      null,
      "chosen.html",
      "/private/secret/source.html",
      "text/html",
      Buffer.from("<b>reviewed selected file</b>"),
    );
  const unselected = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.store).putFile(
    thread.id,
    null,
    "secret.txt",
    "/secret",
    "text/plain",
    Buffer.from("UNSELECTED_PRIVATE"),
  );
  const input = { scope, items: [{ kind: "file", id: original.artifactId }] };
  const preview = await f.request(f.path + "/publication-preview", f.owner, "POST", input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.items[0].files.length, 1);
  const file = preview.body.items[0].files[0],
    download = f.path + "/assets/" + file.id;
  assert.equal((await f.request(download, f.friend)).status, 404, "unpublished preview is private");
  assert.equal(
    (await f.request(f.path + "/publication-preview", f.friend, "POST", input)).status,
    404,
  );
  await writeFile(
    join(runtime.sessions.config.hub.resultsPath, original.artifactId + ".bin"),
    "changed after preview",
  );
  const headers = f.headers(),
    body = { ...input, fingerprint: preview.body.fingerprint, files: preview.body.files };
  const published = await f.request(f.path + "/publications", f.owner, "POST", body, headers);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(
    (await f.request(f.path + "/publications", f.owner, "POST", body, headers)).body.items[0].id,
    published.body.items[0].id,
  );
  const shared = await f.request(f.path + "/materials/" + published.body.items[0].id, f.friend);
  assert.equal(shared.body.files[0].sha256, file.sha256);
  assert.equal(shared.body.source, undefined);
  assert(!JSON.stringify(shared.body).includes(original.artifactId));
  assert(!JSON.stringify(shared.body).includes(unselected.artifactId));
  const data = await fetch(f.base + download, { headers: f.friend });
  assert.equal(data.status, 200);
  assert.equal(data.headers.get("content-type"), "application/octet-stream");
  assert.match(data.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await data.text(), "<b>reviewed selected file</b>");
  const snapshot = await createSnapshot(f.config, join(f.root, "shared-files-backups"), {
    keep: 2,
  });
  await verifyTeamSnapshot(snapshot);
  const destination = join(f.root, "shared-files-restored");
  await restoreTeamSnapshot(snapshot, destination);
  assert.equal(
    await readFile(join(destination, "team", "shared-results", file.id + ".bin"), "utf8"),
    "<b>reviewed selected file</b>",
  );
  f.teamProjects.member(f.registry.ownerId, f.projectId, f.friendId, randomUUID(), {
    revision: 1,
    role: "viewer",
    remove: true,
  });
  assert.equal((await f.request(download, f.friend)).status, 404);
  await writeFile(join(snapshot, "shared-results", file.id + ".bin"), "corrupted");
  await assert.rejects(verifyTeamSnapshot(snapshot), (e) => e.code === "SHARED_FILE_CHANGED");
});
test("GPT file publication uses only publisher's selected project and profile, never another account", async (t) => {
  const f = await sharedFixture(t),
    scope = { client: "gpt", projectId: "gpt-private", name: "Личный GPT" },
    fileId = "file-shared-fixture",
    calls = [];
  for (const [id, label] of [
    [f.registry.ownerId, "OWNER_BYTES"],
    [f.friendId, "FRIEND_BYTES"],
  ]) {
    const runtime = (await f.personal(id)).runtime,
      nativeId = "same-native-id";
    runtime.gpt.library.save("thread", nativeId, {
      name: "Private GPT",
      projectId: scope.projectId,
    });
    runtime.store.db
      .prepare(
        "INSERT INTO gpt_jobs(id,fingerprint,nativeId,text,files,model,effort,status,answer,assets,createdAt,updatedAt,error) VALUES(?,?,?,'','[]','','','completed','',?,?,?,'')",
      )
      .run(
        randomUUID(),
        randomUUID(),
        nativeId,
        JSON.stringify([{ id: fileId, name: "response.txt" }]),
        Date.now(),
        Date.now(),
      );
    runtime.gpt.asset = async (actual) => {
      assert.equal(actual, fileId);
      calls.push(id);
      return new Response(label, { headers: { "content-type": "text/plain" } });
    };
  }
  const input = { scope, items: [{ kind: "file", id: fileId }] };
  const preview = await f.request(f.path + "/publication-preview", f.friend, "POST", input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(calls, [f.friendId]);
  const published = await f.request(
    f.path + "/publications",
    f.friend,
    "POST",
    { ...input, fingerprint: preview.body.fingerprint, files: preview.body.files },
    f.headers(),
  );
  assert.equal(published.status, 200);
  assert.deepEqual(calls, [f.friendId], "confirmed snapshot doesn't redownload a mutable source");
  const result = await fetch(f.base + f.path + "/assets/" + preview.body.files[0].assetId, {
    headers: f.owner,
  });
  assert.equal(await result.text(), "FRIEND_BYTES");
  const wrong = await f.request(f.path + "/publication-preview", f.friend, "POST", {
    ...input,
    scope: { ...scope, projectId: "other-project" },
  });
  assert.equal(wrong.status, 404);
  assert.deepEqual(calls, [f.friendId]);
});

test("project invitation can be revoked before acceptance and archived Core cannot be changed", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    path = "/api/team/projects/" + id,
    headers = () => ({ "idempotency-key": randomUUID() });
  assert.equal(
    (
      await f.request(path, f.owner, "PUT", {
        title: "Согласие",
        visibility: "shared",
        repository: null,
      })
    ).status,
    200,
  );
  const invite = await f.request(
    path + "/invitations",
    f.owner,
    "POST",
    { login: "friend", role: "collaborator", revision: 1 },
    headers(),
  );
  assert.equal((await f.request(path, f.owner)).body.invitations[0].id, invite.body.id);
  assert.equal(
    (
      await f.request(
        path + "/invitations/" + invite.body.id,
        f.friend,
        "DELETE",
        undefined,
        headers(),
      )
    ).status,
    404,
  );
  const receipt = headers();
  assert.equal(
    (
      await f.request(
        path + "/invitations/" + invite.body.id,
        f.owner,
        "DELETE",
        undefined,
        receipt,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        path + "/invitations/" + invite.body.id,
        f.owner,
        "DELETE",
        undefined,
        receipt,
      )
    ).status,
    200,
  );
  assert.equal((await f.request("/api/team/project-invitations", f.friend)).body.items.length, 0);
  assert.equal(
    (
      await f.request(
        "/api/team/project-invitations/" + invite.body.id,
        f.friend,
        "POST",
        { accept: true },
        headers(),
      )
    ).status,
    404,
  );
  assert.equal((await f.request(path, f.friend)).status, 404);
  assert.equal(
    (
      await f.request(
        path,
        f.owner,
        "PATCH",
        { title: "Согласие", visibility: "shared", revision: 1, archived: true },
        headers(),
      )
    ).status,
    200,
  );
  const core = {
    kind: "core",
    title: "Основа",
    value: {
      purpose: "test",
      behavior: "",
      rules: "",
      constraints: "",
      architecture: "",
      preferences: "",
    },
  };
  const denied = await f.request(
    path + "/materials/" + randomUUID(),
    f.owner,
    "PUT",
    { revision: 0, content: core },
    headers(),
  );
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, "SHARED_ARCHIVED");
});

test("shared project keeps one owner and installation admin cannot read a member's private project", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    path = "/api/team/projects/" + id;
  const input = { title: "FRIEND_PROJECT", visibility: "shared", repository: null };
  const first = await f.request(path, f.friend, "PUT", input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual((await f.request(path, f.friend, "PUT", input)).body, first.body);
  for (const suffix of ["", "/materials", "/activity"])
    assert.equal((await f.request(path + suffix, f.owner)).status, 404);
  assert(
    !JSON.stringify((await f.request("/api/team/projects", f.owner)).body).includes(
      "FRIEND_PROJECT",
    ),
  );
  assert.equal(
    (
      await f.request(
        path,
        { cookie: f.friend.cookie },
        "PATCH",
        { revision: 1, title: "Changed", visibility: "shared", archived: false },
        { "idempotency-key": randomUUID() },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        path + "/members/" + f.friendId,
        f.friend,
        "PATCH",
        { revision: 1, role: "viewer", remove: true },
        { "idempotency-key": randomUUID() },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/team/users/" + f.friendId + "/state", f.owner, "POST", {
        disabled: true,
      })
    ).status,
    409,
    "owner must transfer or archive before offboarding",
  );
});

test("work from a task creates one attributed normal Plan with shared backlinks, without starting work or crossing checkouts", async (t) => {
  const f = await sharedFixture(t),
    id = randomUUID(),
    path = f.path + "/materials/" + id;
  const content = {
    kind: "task",
    title: "Review task",
    body: "Required change",
    status: "todo",
    dueAt: null,
    priority: 1,
  };
  const create = await f.request(
    path,
    f.owner,
    "PUT",
    { revision: 0, content, assigneeId: f.friendId },
    f.headers(),
  );
  assert.equal(create.status, 200);
  assert.equal(
    (await f.request(path + "/work", f.friend, "POST", { revision: 1, confirm: true }, f.headers()))
      .status,
    409,
    "own checkout required",
  );
  f.teamProjects.bind(
    f.friendId,
    f.projectId,
    randomUUID(),
    { revision: 0, personalProjectId: "friend-work" },
    { machineId: "friend-machine", repository: null },
  );
  assert.equal(
    (await f.request(path + "/work", f.owner, "POST", { revision: 1, confirm: true }, f.headers()))
      .status,
    409,
    "only the assigned actor prepares work",
  );
  const key = f.headers(),
    result = await f.request(path + "/work", f.friend, "POST", { revision: 1, confirm: true }, key);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.kind, "plan");
  assert.equal(result.body.assigneeId, f.friendId);
  assert.equal(result.body.createdBy, f.friendId);
  assert.equal(result.body.related[0].id, id);
  assert.equal((await f.request(path, f.owner)).body.related[0].id, result.body.id);
  assert.equal(
    (await f.request(path + "/work", f.friend, "POST", { revision: 1, confirm: true }, key)).body
      .id,
    result.body.id,
  );
  assert.equal(
    (await f.request(path + "/work", f.friend, "POST", { revision: 1, confirm: true }, f.headers()))
      .body.id,
    result.body.id,
    "second client uses the same work record",
  );
  assert.equal(
    (
      await f.request(
        path,
        f.owner,
        "PUT",
        { revision: 1, content: { ...content, body: "Changed source" }, assigneeId: f.friendId },
        f.headers(),
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(path + "/work", f.friend, "POST", { revision: 2, confirm: true }, key)).status,
    409,
    "receipt cannot change revision",
  );
  assert.equal(
    (await f.request(path + "/work", f.friend, "POST", { revision: 1, confirm: true }, key)).body
      .id,
    result.body.id,
    "lost acknowledgement stays tied to old source revision",
  );
  assert.equal(f.registry.db.prepare("SELECT count(*) n FROM team_executions").get().n, 0);
  const privateRuntime = (await f.personal(f.friendId)).runtime;
  assert.equal(
    privateRuntime.store.db.prepare("SELECT count(*) n FROM project_work_actions").get().n,
    0,
  );
  assert.equal(
    (
      await f.request(
        f.path + "/members/" + f.friendId,
        f.owner,
        "PATCH",
        { revision: 1, role: "collaborator", remove: true },
        f.headers(),
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(path + "/work", f.friend, "POST", { revision: 1, confirm: true }, key)).status,
    404,
  );
});

test("shared reports freeze a bounded common checkpoint, keep edits private until exact publication, and reject overlapping periods", async (t) => {
  const f = await sharedFixture(t),
    base = f.path + "/report-drafts",
    id = randomUUID();
  const note = await f.request(
    f.path + "/materials/" + randomUUID(),
    f.owner,
    "PUT",
    {
      revision: 0,
      content: { kind: "note", title: "Common title", body: "COMMON_BODY_NOT_A_TRANSCRIPT" },
    },
    f.headers(),
  );
  assert.equal(note.status, 200);
  assert.equal(
    (
      await f.request("/api/workspace/notes/" + randomUUID(), f.friend, "PUT", {
        scope: { client: "codex", projectId: "private", name: "Private" },
        title: "PRIVATE_TITLE",
        body: "PRIVATE_BODY",
        links: [],
        revision: 0,
      })
    ).status,
    200,
  );
  const prepared = await f.request(base + "/" + id, f.friend, "PUT", {});
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.match(prepared.body.content.body, /Common title/);
  assert(!JSON.stringify(prepared.body).includes("PRIVATE_"));
  assert(!JSON.stringify(prepared.body).includes("COMMON_BODY_NOT_A_TRANSCRIPT"));
  assert.equal((await f.request(base + "/" + id, f.owner)).status, 404);
  assert.equal((await f.request(base, f.owner)).body.items.length, 0);
  const otherId = randomUUID();
  assert.equal((await f.request(base + "/" + otherId, f.owner, "PUT", {})).status, 200);
  assert.equal(
    (
      await f.request(
        f.path + "/materials/" + randomUUID(),
        f.owner,
        "PUT",
        { revision: 0, content: { kind: "note", title: "After snapshot", body: "Later" } },
        f.headers(),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await f.request(base + "/" + id, f.friend, "PUT", {})).body,
    prepared.body,
    "exact retry retains frozen period and text",
  );
  const input = {
    title: "Reviewed report",
    body: "Only the selected edited summary.",
    confirm: true,
  };
  const published = await f.request(base + "/" + id + "/publish", f.friend, "POST", input);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual(
    (await f.request(base + "/" + id + "/publish", f.friend, "POST", input)).body,
    published.body,
  );
  assert.equal(
    (
      await f.request(base + "/" + id + "/publish", f.friend, "POST", {
        ...input,
        body: "Changed retry",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request(base + "/" + otherId + "/publish", f.owner, "POST", input)).status,
    409,
  );
  const visible = await f.request(f.path + "/materials/" + published.body.itemId, f.owner);
  assert.equal(visible.body.content.body, input.body);
  assert.equal(visible.body.createdBy, f.friendId);
  assert.equal((await f.request(f.path + "/materials?kind=report", f.friend)).body.items.length, 1);
  const next = await f.request(base + "/" + randomUUID(), f.owner, "PUT", {});
  assert.equal(next.body.checkpoint.fromSeq, prepared.body.checkpoint.toSeq);
  assert.equal(next.body.content.periodFrom, prepared.body.content.periodTo);
  assert.match(next.body.content.body, /After snapshot/);
  assert(
    !next.body.content.body.includes("Common title"),
    "already checkpointed event is not repeated",
  );
  for (const user of [f.registry.ownerId, f.friendId]) {
    const { runtime } = await f.personal(user);
    assert.equal(
      runtime.store.db.prepare("SELECT count(*) n FROM project_work_actions").get().n,
      0,
    );
    assert.equal(
      runtime.store.db.prepare("SELECT count(*) n FROM project_current_chats").get().n,
      0,
    );
  }
});

test("report publication and checkpoint are atomic; cancellation and revoked membership cannot advance them", async (t) => {
  const f = await sharedFixture(t),
    base = f.path + "/report-drafts",
    id = randomUUID();
  assert.equal((await f.request(base + "/" + id, f.friend, "PUT", {})).status, 200);
  f.registry.db.exec(
    "CREATE TRIGGER report_failure BEFORE INSERT ON team_report_checkpoints BEGIN SELECT RAISE(ABORT,'fixture_failure'); END",
  );
  const input = { title: "Atomic report", body: "Reviewed content", confirm: true };
  assert.equal(
    (await f.request(base + "/" + id + "/publish", f.friend, "POST", input)).status,
    500,
  );
  assert.equal((await f.request(base + "/" + id, f.friend)).body.state, "prepared");
  assert.equal((await f.request(f.path + "/materials?kind=report", f.owner)).body.items.length, 0);
  f.registry.db.exec("DROP TRIGGER report_failure");
  assert.equal(
    (await f.request(base + "/" + id + "/cancel", f.friend, "POST", { confirm: true })).status,
    200,
  );
  assert.equal(
    (await f.request(base + "/" + id + "/publish", f.friend, "POST", input)).status,
    409,
  );
  const another = randomUUID();
  assert.equal((await f.request(base + "/" + another, f.friend, "PUT", {})).status, 200);
  assert.equal(
    (
      await f.request(
        f.path + "/members/" + f.friendId,
        f.owner,
        "PATCH",
        { revision: 1, role: "collaborator", remove: true },
        f.headers(),
      )
    ).status,
    200,
  );
  assert.equal((await f.request(base + "/" + another, f.friend)).status, 404);
  assert.equal(
    (await f.request(base + "/" + another + "/publish", f.friend, "POST", input)).status,
    404,
  );
  const invitation = await f.request(
    f.path + "/invitations",
    f.owner,
    "POST",
    {
      userId: f.friendId,
      role: "collaborator",
      revision: (await f.request(f.path)).body.project.revision,
    },
    f.headers(),
  );
  assert.equal(invitation.status, 200, JSON.stringify(invitation.body));
  assert.equal(
    (
      await f.request(
        "/api/team/project-invitations/" + invitation.body.id,
        f.friend,
        "POST",
        { accept: true },
        f.headers(),
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(base + "/" + another + "/publish", f.friend, "POST", input)).status,
    409,
    "re-adding a member does not revive the old confirmation",
  );
  assert.equal(f.registry.db.prepare("SELECT count(*) n FROM team_report_checkpoints").get().n, 0);
});

test("shared report retention is explicit and unrelated project sequence gaps do not imply truncation", async (t) => {
  const f = await sharedFixture(t),
    base = f.path + "/report-drafts",
    other = randomUUID(),
    actor = f.registry.ownerId;
  f.teamProjects.create(actor, other, {
    title: "Unrelated",
    visibility: "private",
    repository: null,
  });
  const before = await f.request(base + "/" + randomUUID(), f.owner, "PUT", {});
  assert.equal(before.body.checkpoint.truncated, false);
  for (let i = 0; i < 1005; i++) f.teamProjects.changed(actor, f.projectId, "material.updated");
  const report = await f.request(base + "/" + randomUUID(), f.owner, "PUT", {});
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.checkpoint.observedEvents, 1000);
  assert.equal(report.body.checkpoint.includedEvents, 60);
  assert.equal(report.body.checkpoint.truncated, true);
  assert(report.body.content.body.length <= 32000);
  assert.match(report.body.content.body, /Часть периода сокращена/);
});

test("shared material filters apply before pagination, distinguish creators and assignees, and retain project authorization", async (t) => {
  const f = await sharedFixture(t),
    ownerId = f.registry.ownerId;
  const put = async (user, content, assigneeId = null) => {
    const result = await f.request(
      f.path + "/materials/" + randomUUID(),
      user,
      "PUT",
      { revision: 0, content, assigneeId },
      f.headers(),
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const task = (title, status) => ({
    kind: "task",
    title,
    body: "check filters",
    status,
    priority: 1,
    dueAt: null,
  });
  const assigned = await put(f.owner, task("Older assigned work", "doing"), f.friendId);
  const own = await put(f.friend, task("Created by friend", "done"), ownerId);
  await put(f.owner, task("Unassigned", "todo"));
  for (let i = 0; i < 34; i++)
    await put(f.owner, { kind: "note", title: "New note " + i, body: "General" });
  const list = async (query, user = f.friend) => {
    const result = await f.request(f.path + "/materials?" + query, user);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  assert.equal((await list("mine=false")).items.length, 30);
  assert.deepEqual(
    (await list("mine=true")).items.map((i) => i.id).sort(),
    [assigned.id, own.id].sort(),
  );
  assert.deepEqual(
    (await list("mine=true&state=active")).items.map((i) => i.id),
    [assigned.id],
  );
  assert.deepEqual(
    (await list("author=" + f.friendId)).items.map((i) => i.id),
    [own.id],
  );
  assert.deepEqual(
    (await list("assignee=" + f.friendId)).items.map((i) => i.id),
    [assigned.id],
  );
  assert.equal((await list("kind=task&assignee=none")).items.length, 1);
  assert.equal((await list("kind=note&state=done")).items.length, 0);
  assert.deepEqual(
    (await list("state=done")).items.map((i) => i.id),
    [own.id],
  );
  assert.equal((await list("assignee=" + randomUUID())).items.length, 0);
  assert.equal((await f.request(f.path + "/materials?mine=no", f.friend)).status, 400);
  assert.equal(
    (
      await f.request(
        f.path + "/members/" + f.friendId,
        f.owner,
        "PATCH",
        { revision: 1, role: "collaborator", remove: true },
        f.headers(),
      )
    ).status,
    200,
  );
  assert.equal((await f.request(f.path + "/materials?mine=true", f.friend)).status, 404);
});

test("shared viewer permissions, attributed revisions, exact retries and revocation apply to every material route", async (t) => {
  const f = await sharedFixture(t, "viewer"),
    itemId = randomUUID(),
    path = f.path + "/materials/" + itemId;
  const note = {
    revision: 0,
    content: { kind: "note", title: "Одна заметка", body: "Общие сведения" },
    assigneeId: null,
  };
  assert.equal((await f.request(path, f.friend, "PUT", note, f.headers())).status, 403);
  const receipt = f.headers(),
    created = await f.request(path, f.owner, "PUT", note, receipt);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.createdBy, f.registry.ownerId);
  assert.deepEqual((await f.request(path, f.owner, "PUT", note, receipt)).body, created.body);
  assert.equal(
    (
      await f.request(
        path,
        f.owner,
        "PUT",
        { ...note, content: { ...note.content, body: "different" } },
        receipt,
      )
    ).status,
    409,
  );
  assert.equal((await f.request(path, f.friend)).body.content.body, "Общие сведения");
  assert.equal(
    (
      await f.request(
        f.path + "/members/" + f.friendId,
        f.owner,
        "PATCH",
        { revision: 1, role: "collaborator", remove: false },
        f.headers(),
      )
    ).status,
    200,
  );
  const updated = await f.request(
    path,
    f.friend,
    "PUT",
    { ...note, revision: 1, content: { ...note.content, body: "Правка друга" } },
    f.headers(),
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.createdBy, f.registry.ownerId);
  assert.equal(updated.body.updatedBy, f.friendId);
  assert.equal(
    (await f.request(path, f.owner, "PUT", { ...note, revision: 1 }, f.headers())).status,
    409,
  );
  const history = await f.request(path + "/history", f.friend);
  assert.deepEqual(
    history.body.items.map((v) => v.content.body),
    ["Правка друга", "Общие сведения"],
  );
  assert.equal(
    (
      await f.request(
        f.path + "/members/" + f.friendId,
        f.owner,
        "PATCH",
        { revision: 2, role: "collaborator", remove: true },
        f.headers(),
      )
    ).status,
    200,
  );
  for (const suffix of ["", "/history"])
    assert.equal((await f.request(path + suffix, f.friend)).status, 404);
  assert.equal(
    (await f.request(path, f.friend, "PUT", { ...note, revision: 2 }, f.headers())).status,
    404,
  );
  assert.equal((await f.request(f.path + "/activity", f.friend)).status, 404);
  assert.equal((await f.request(path, f.owner)).body.editorName, "Друг");
  const deletion = f.headers();
  assert.equal(
    (await f.request(path, f.owner, "DELETE", { revision: 2, confirm: true }, deletion)).status,
    200,
  );
  assert.equal(
    (await f.request(path, f.owner, "DELETE", { revision: 2, confirm: true }, deletion)).status,
    200,
    "lost deletion acknowledgement remains recoverable",
  );
});

test("shared typed plans, assignments and independent checkouts preserve private Current Chats", async (t) => {
  const f = await sharedFixture(t),
    shared = f.teamProjects;
  const a = shared.bind(
    f.registry.ownerId,
    f.projectId,
    randomUUID(),
    { revision: 0, personalProjectId: "identical" },
    { machineId: "OWNER_MACHINE", repository: null },
  );
  const b = shared.bind(
    f.friendId,
    f.projectId,
    randomUUID(),
    { revision: 0, personalProjectId: "identical" },
    { machineId: "FRIEND_MACHINE", repository: null },
  );
  assert.notEqual(a.id, b.id);
  const friend = await f.request(f.path, f.friend),
    owner = await f.request(f.path, f.owner);
  assert.equal(friend.body.checkout.machineId, "FRIEND_MACHINE");
  assert(!JSON.stringify(friend.body).includes("OWNER_MACHINE"));
  assert(!JSON.stringify(owner.body).includes("FRIEND_MACHINE"));
  assert.equal(
    (
      await f.request(
        f.path + "/checkout",
        f.friend,
        "PUT",
        { revision: 1, personalProjectId: "owner-only" },
        f.headers(),
      )
    ).status,
    404,
    "binding reads only the acting user's personal catalog",
  );
  const itemId = randomUUID(),
    subId = randomUUID(),
    point = randomUUID();
  const plan = {
    revision: 0,
    assigneeId: f.friendId,
    content: {
      kind: "plan",
      title: "Проверить",
      description: "Шаги",
      status: "draft",
      sections: [
        {
          id: subId,
          title: "Первый этап",
          items: [{ id: point, text: "Сделать работу", checked: false }],
        },
      ],
    },
  };
  const result = await f.request(
    f.path + "/materials/" + itemId,
    f.owner,
    "PUT",
    plan,
    f.headers(),
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.content, plan.content);
  assert.equal(result.body.assigneeId, f.friendId);
  const duplicate = structuredClone(plan);
  duplicate.content.sections[0].items.push({ ...duplicate.content.sections[0].items[0] });
  assert.equal(
    (await f.request(f.path + "/materials/" + randomUUID(), f.owner, "PUT", duplicate, f.headers()))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(
        f.path + "/materials/" + randomUUID(),
        f.owner,
        "PUT",
        { ...plan, assigneeId: randomUUID() },
        f.headers(),
      )
    ).status,
    409,
  );
  for (const userId of [f.registry.ownerId, f.friendId]) {
    const { runtime } = await f.personal(userId);
    assert.equal(
      runtime.store.db.prepare("SELECT COUNT(*) n FROM project_current_chats").get().n,
      0,
    );
    assert.equal(
      runtime.store.db.prepare("SELECT COUNT(*) n FROM project_work_actions").get().n,
      0,
    );
  }
});

test("publication reviews exact selected personal contents without leaking links or another colliding source", async (t) => {
  const f = await sharedFixture(t),
    noteId = randomUUID(),
    omittedId = randomUUID();
  const scope = { client: "codex", projectId: "personal-source", name: "Личный проект" };
  const note = {
    scope,
    revision: 0,
    title: "Публикация",
    body: "FRIEND_SELECTED_TEXT",
    links: [{ client: "codex", kind: "thread", id: "private-thread", title: "PRIVATE_LINK_TITLE" }],
  };
  assert.equal(
    (await f.request("/api/workspace/notes/" + noteId, f.friend, "PUT", note)).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/workspace/notes/" + omittedId, f.friend, "PUT", {
        ...note,
        body: "UNSELECTED_PRIVATE_TEXT",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/workspace/notes/" + noteId, f.owner, "PUT", {
        ...note,
        body: "OTHER_ACCOUNT_TEXT",
      })
    ).status,
    200,
  );
  const selected = { scope, items: [{ kind: "note", id: noteId }] };
  const preview = await f.request(f.path + "/publication-preview", f.friend, "POST", selected);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert(!JSON.stringify(preview.body).includes("PRIVATE_LINK_TITLE"));
  assert(!JSON.stringify(preview.body).includes("OTHER_ACCOUNT_TEXT"));
  assert.equal(
    (
      await f.request("/api/workspace/notes/" + noteId, f.friend, "PUT", {
        ...note,
        revision: 1,
        body: "Changed before publish",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        f.path + "/publications",
        f.friend,
        "POST",
        { ...selected, fingerprint: preview.body.fingerprint },
        f.headers(),
      )
    ).status,
    409,
  );
  const refreshed = await f.request(f.path + "/publication-preview", f.friend, "POST", selected),
    receipt = f.headers();
  const input = { ...selected, fingerprint: refreshed.body.fingerprint };
  const published = await f.request(f.path + "/publications", f.friend, "POST", input, receipt);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.items.length, 1);
  assert.equal(published.body.items[0].source.id, noteId);
  assert.equal(
    (
      await f.request("/api/workspace/notes/" + noteId, f.friend, "PUT", {
        ...note,
        revision: 2,
        body: "Unpublished later edit",
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await f.request(f.path + "/publications", f.friend, "POST", input, receipt)).body,
    published.body,
    "recover receipt without republishing changed source",
  );
  const shared = await f.request(f.path + "/materials", f.owner);
  assert.equal(
    (await f.request(f.path + "/materials/" + shared.body.items[0].id, f.owner)).body.content.body,
    "Changed before publish",
  );
  assert.equal(shared.body.items[0].hasPrivateSource, true);
  assert.equal(shared.body.items[0].source, undefined);
  assert(!JSON.stringify(shared.body).includes(noteId));
  assert(!JSON.stringify(shared.body).includes("UNSELECTED_PRIVATE_TEXT"));
  const privateOriginal = await f.request("/api/workspace/notes/" + noteId, f.owner);
  assert.equal(privateOriginal.body.body, "OTHER_ACCOUNT_TEXT");
});

test("ownership transfer requires the receiving participant and shared backup preserves attribution and membership", async (t) => {
  const f = await sharedFixture(t);
  const offer = await f.request(
    f.path + "/invitations",
    f.owner,
    "POST",
    { login: "friend", role: "owner", revision: 1 },
    f.headers(),
  );
  assert.equal(offer.status, 200, JSON.stringify(offer.body));
  assert.equal((await f.request(f.path, f.owner)).body.project.ownerId, f.registry.ownerId);
  assert.equal(
    (
      await f.request(
        "/api/team/project-invitations/" + offer.body.id,
        f.owner,
        "POST",
        { accept: true },
        f.headers(),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        "/api/team/project-invitations/" + offer.body.id,
        f.friend,
        "POST",
        { accept: true },
        f.headers(),
      )
    ).status,
    200,
  );
  const detail = await f.request(f.path, f.friend);
  assert.equal(detail.body.project.ownerId, f.friendId);
  assert.equal(detail.body.members.filter((m) => m.role === "owner").length, 1);
  const itemId = randomUUID();
  assert.equal(
    (
      await f.request(
        f.path + "/materials/" + itemId,
        f.friend,
        "PUT",
        { revision: 0, content: { kind: "note", title: "Сохранить", body: "shared snapshot" } },
        f.headers(),
      )
    ).status,
    200,
  );
  const snapshot = await createSnapshot(f.config, join(f.root, "shared-backups"), { keep: 2 });
  await verifyTeamSnapshot(snapshot);
  const target = join(f.root, "shared-restored");
  await restoreTeamSnapshot(snapshot, target);
  const db = new DatabaseSync(join(target, "team", "team.db"));
  try {
    assert.equal(
      db.prepare("SELECT ownerId FROM team_projects WHERE id=?").get(f.projectId).ownerId,
      f.friendId,
    );
    assert.equal(
      db.prepare("SELECT createdBy FROM team_materials WHERE id=?").get(itemId).createdBy,
      f.friendId,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) n FROM team_project_members WHERE projectId=? AND role='owner'")
        .get(f.projectId).n,
      1,
    );
    assert.equal(
      db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get().value,
      "blocked",
    );
  } finally {
    db.close();
  }
  assert.equal(
    (
      await f.request(
        f.path + "/members/" + f.registry.ownerId,
        f.friend,
        "PATCH",
        { revision: 2, role: "collaborator", remove: true },
        f.headers(),
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.request(f.path, f.owner)).status,
    404,
    "being installation admin and original creator does not bypass removal",
  );
  assert.equal(
    (
      await f.request(f.path, f.owner, "PUT", {
        title: "Общий проект",
        visibility: "shared",
        repository: null,
      })
    ).status,
    404,
    "old creation receipt cannot recover removed content",
  );
});

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
  assert.equal(privateRuntime.runtime.projectGpts.bindings.ownerUserId, f.friendId);
  assert.equal(
    (await f.personal(f.registry.ownerId)).runtime.projectGpts.bindings.ownerUserId,
    f.registry.ownerId,
  );
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

test("member onboarding resumes canonical progress, excludes the owner and cannot claim readiness", async (t) => {
  const f = await fixture(t);
  const path = "/api/team/onboarding";
  assert.equal((await f.request(path, f.owner)).body.originalOwner, true);
  assert.equal((await f.request(path, f.owner)).body.state, "complete");
  // Legacy LAN machines do not depend on member Tailnet enrollment.
  const lan = {
    id: "owner-lan",
    name: "Owner PC",
    type: "ssh-windows",
    ssh: { host: "192.168.1.10" },
  };
  f.config.machines.push(lan);
  assert.equal(f.config.team.hubTailnetAddress, undefined);
  assert.deepEqual(privateConfig(f.config, f.registry, f.registry.ownerId).machines, [lan]);
  assert.deepEqual(privateConfig(f.config, f.registry, f.friendId).machines, []);
  assert.equal((await f.request(path, f.owner)).body.ready, true);
  assert.equal((await f.request(path, f.friend)).body.state, "pending");
  assert.equal((await f.request(path, f.friend, "POST", { state: "complete" })).status, 409);
  assert.equal((await f.request(path, f.friend, "POST", { state: "deferred" })).status, 200);
  assert.equal((await f.request(path, f.friend)).body.state, "deferred");
  assert.equal(
    (await f.request(path, f.friend, "POST", { state: "complete", userId: f.registry.ownerId }))
      .status,
    400,
  );
  const gpt = { status: () => ({ enabled: true, state: "ready" }) };
  const id = randomUUID();
  const enrollments = {
    list: (actor) => {
      assert.equal(actor, f.friendId);
      return [
        {
          id,
          state: "approved",
          machineId: id,
          createdAt: 1,
          readiness: { codex: true, git: true, github: true },
        },
        { id: randomUUID(), state: "pending", createdAt: 2 },
      ];
    },
  };
  const runtime = { machines: [{ id }], nativeGpt: { userId: f.friendId } };
  assert.equal(memberSetupStatus(f.config, f.registry, enrollments, gpt, f.friendId).ready, false);
  const ready = memberSetupStatus(f.config, f.registry, enrollments, gpt, f.friendId, runtime);
  assert.equal(ready.ready, true);
  assert.equal(
    ready.machine.stage,
    "active",
    "a later pending computer does not hide the ready one",
  );
  assert.equal(ready.gpt.stage, "active");
  assert.equal(
    memberSetupStatus(
      f.config,
      f.registry,
      enrollments,
      { status: () => ({ enabled: true, state: "blocked" }) },
      f.friendId,
      runtime,
    ).ready,
    false,
  );
});

test("revocation closes only the disabled user's streams and clears personal ticket sessions", async (t) => {
  const f = await fixture(t),
    ownerSocket = await f.connect(f.owner),
    friendSocket = await f.connect(f.friend);
  const before = await f.request(`/api/team/users/${f.friendId}/offboarding`, f.owner);
  assert.equal(before.status, 200);
  assert.equal(before.body.sessions, 1);
  assert.equal(before.body.sharedOwnedProjects, 0);
  assert.deepEqual(Object.keys(before.body).sort(), [
    "gptProfile",
    "machines",
    "sessions",
    "sharedOwnedProjects",
    "user",
  ]);
  assert.equal(
    (await f.request(`/api/team/users/${f.registry.ownerId}/offboarding`, f.friend)).status,
    403,
  );
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
  assert.equal(
    (await f.request(`/api/team/users/${f.friendId}/offboarding`, f.owner)).body.sessions,
    0,
  );
  f.registry.disable(f.registry.ownerId, f.friendId, false);
  assert.equal(
    (await f.request("/api/workspace/notes", f.friend)).status,
    401,
    "enabling never revives an old session",
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

test("administrator role changes revoke sessions and preserve the installation owner", async (t) => {
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
    409,
  );
  assert.equal(
    (
      await f.request(`/api/team/users/${f.registry.ownerId}/state`, admin, "POST", {
        disabled: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request(`/api/team/users/${f.registry.ownerId}/recovery`, admin, "POST", {})).status,
    409,
  );
  assert.equal((await f.request("/api/auth/session", f.owner)).status, 200);
  assert.equal(f.registry.user(f.registry.ownerId).role, "admin");
  assert.equal(
    (await f.request(`/api/team/users/${f.registry.ownerId}/recovery`, f.owner, "POST", {})).status,
    200,
  );
  const audit = await f.request("/api/team/audit", admin);
  assert.equal(
    (
      await f.request(`/api/team/users/${f.friendId}/role`, admin, "POST", {
        role: "member",
        expectedRole: "admin",
      })
    ).status,
    200,
  );
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
  assert.equal(
    (await fetch(f.base + result.url, { method: "HEAD", headers: f.owner })).status,
    404,
  );
  assert.equal(
    (await fetch(f.base + result.url, { headers: { ...f.owner, range: "bytes=0-4" } })).status,
    404,
  );
  const resultId = runtime.store.result(
    thread.id,
    null,
    "private-file",
    "artifact",
    "private.txt",
    { url: result.url },
  );
  const reference = { source: result.url, messageId: "answer" };
  assert.equal(
    (await f.request(`/api/threads/${thread.id}/results/reveal`, f.friend, "POST", reference)).body
      .id,
    resultId,
  );
  assert.equal(
    (await f.request(`/api/threads/${thread.id}/results/reveal`, f.owner, "POST", reference))
      .status,
    404,
  );
  assert.equal((await f.request(`/api/threads/${thread.id}/history`, f.owner)).status, 404);
});

test("project file uploads isolate bytes and grants between accounts", async (t) => {
  const f = await fixture(t),
    { runtime } = await f.personal(f.registry.ownerId);
  runtime.sessions.config.machines.push({
    id: "upload-pc",
    name: "Test",
    type: "local-linux",
    codex: { command: "/nonexistent", shell: "powershell" },
  });
  runtime.sessions.config.projects.push({
    id: "upload-project",
    machineId: "upload-pc",
    name: "Private",
    workingDirectory: f.root,
    enabled: true,
  });
  runtime.store.setPreferences({ machineClients: { "upload-pc": "web" } });
  const accessPath = "/api/projects/upload-project/file-tools/access";
  const access = await f.request(accessPath, f.owner, "POST", { unlock: true });
  assert.equal(access.status, 200, JSON.stringify(access.body));
  const { capability, checkout } = access.body;
  const header = { "x-file-capability": capability },
    url = `/api/projects/upload-project/file-uploads/${randomUUID()}`;
  const spec = { name: "private-upload.bin", bytes: 3, folder: "", checkout };
  assert.equal((await f.request(url, f.owner, "POST", spec, header)).status, 200);
  for (const [method, suffix, body] of [
    ["GET", ""],
    ["POST", "", spec],
    ["POST", "/complete", {}],
    ["DELETE", ""],
  ]) {
    const denied = await f.request(url + suffix, f.friend, method, body, header);
    assert([403, 404].includes(denied.status), JSON.stringify(denied));
  }
  const put = (user) =>
    fetch(f.base + url + "?offset=0", {
      method: "PUT",
      headers: {
        origin: f.config.hub.publicBaseUrl,
        ...user,
        ...header,
        "content-type": "application/octet-stream",
      },
      body: Buffer.from([0, 255, 17]),
    });
  assert([403, 404].includes((await put(f.friend)).status));
  assert.equal((await put(f.owner)).status, 200);
  assert.equal(
    (await f.request(accessPath, f.owner, "POST", { unlock: false, capability })).status,
    200,
  );
  assert.equal((await f.request(url + "/complete", f.owner, "POST", {}, header)).status, 403);
  await assert.rejects(readFile(join(f.root, spec.name)), { code: "ENOENT" });
  const renewed = await f.request(accessPath, f.owner, "POST", { unlock: true });
  const result = await f.request(
    url + "/complete",
    f.owner,
    "POST",
    {},
    { "x-file-capability": renewed.body.capability },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(await readFile(join(f.root, spec.name)), Buffer.from([0, 255, 17]));
});

test("project ZIP archives remain private across account, copied URLs and checkout changes", async (t) => {
  const f = await fixture(t),
    { runtime } = await f.personal(f.registry.ownerId);
  runtime.sessions.config.machines.push({
    id: "zip-pc",
    name: "Fixture",
    type: "local-linux",
    codex: { command: "/nonexistent", shell: "powershell" },
  });
  runtime.sessions.config.projects.push({
    id: "zip-project",
    name: "Private",
    machineId: "zip-pc",
    workingDirectory: f.root,
    enabled: true,
  });
  runtime.store.setPreferences({ machineClients: { "zip-pc": "web" } });
  await writeFile(join(f.root, "private-zip.txt"), "PRIVATE ZIP BYTES");
  const grant = await f.request("/api/projects/zip-project/file-tools/access", f.owner, "POST", {
    unlock: true,
  });
  assert.equal(grant.status, 200);
  const url = `/api/projects/zip-project/file-archives/${randomUUID()}`,
    body = { checkout: grant.body.checkout, paths: ["private-zip.txt"] };
  const prepared = await f.request(url, f.owner, "POST", body);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  for (const [method, suffix, payload] of [
    ["GET", ""],
    ["GET", "/content"],
    ["POST", "", body],
    ["DELETE", ""],
  ]) {
    const response = await f.request(url + suffix, f.friend, method, payload);
    assert([403, 404].includes(response.status));
    assert(!JSON.stringify(response.body).includes("PRIVATE ZIP BYTES"));
  }
  assert.equal((await fetch(f.base + prepared.body.url, { headers: f.owner })).status, 200);
  runtime.sessions.config.projects[0].workingDirectory = join(f.root, "other");
  assert.equal((await f.request(url + "/content", f.owner)).status, 404);
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
    remote: { provider: "vnc", port: 5900, password: "Own_1234" },
    readiness: {
      companion: true,
      codex: true,
      node: true,
      git: true,
      github: true,
      desktop: false,
      remote: true,
    },
  };
  const reportHeaders = { authorization: `Bearer ${token}` };
  assert.equal(
    (
      await f.request(
        "/api/machine-enrollment/report",
        {},
        "POST",
        {
          ...report,
          readiness: { ...report.readiness, remote: false },
        },
        reportHeaders,
      )
    ).status,
    400,
    "Remote readiness must match the credential report",
  );
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
  for (const endpoint of ["/api/team/machines", "/api/team/machine-reviews"]) {
    const response = await f.request(endpoint, f.owner);
    assert(
      !JSON.stringify(response.body).includes(report.remote.password),
      "admin metadata omits Remote credentials",
    );
  }
  assert(!JSON.stringify(approved.body).includes(report.remote.password));
  assert(
    !JSON.stringify((await f.request("/api/team/machines", f.friend)).body).includes(
      report.remote.password,
    ),
  );
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
  assert.equal(selected.machines[0].codex.activityNode, "node.exe");
  assert.equal(enrolledRuntime(f.config, f.registry, f.registry.ownerId).machines.length, 0);
  assert.deepEqual(selected.machines[0].allowedProjectRoots, report.roots);
  assert.equal(selected.machines[0].remote.host, report.address);
  assert.equal(selected.machines[0].remote.provider, "vnc");
  assert.equal(process.env[selected.machines[0].remote.passwordSecret], report.remote.password);
  t.after(() => {
    delete process.env[selected.machines[0].remote.passwordSecret];
  });
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
  assert.equal(
    (
      await reconcileGptProfiles(f.config, f.registry.db, {
        ...options,
        health: async () => {
          f.registry.db
            .prepare("UPDATE team_users SET executionEpoch=executionEpoch+2 WHERE id=?")
            .run(f.friendId);
          return true;
        },
      })
    ).failed,
    1,
  );
  assert.equal(service.row(f.friendId).code, "GPT_REQUEST_REVOKED");
  service.request(f.friendId);
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
  const nativePasswordFile = join(f.root, "native-vnc-password");
  await writeFile(nativePasswordFile, "labpass1", { mode: 0o600 });
  const nativeConversation = randomUUID(),
    nativeSocket = join(f.root, "native.sock");
  const nativeService = new NativeReadService({
    userId: f.registry.ownerId,
    accountFingerprint: "a".repeat(64),
    statePath: join(f.root, "native-manual.json"),
    reader: {
      readConversation: async () => ({
        conversationId: nativeConversation,
        currentNode: "node",
        before: null,
        mediaResolved: false,
        messages: [
          {
            nodeId: "node",
            id: "message",
            role: "assistant",
            channel: "final",
            text: "Private native reply",
            hasAttachments: false,
            createdAt: 1,
            model: null,
            effort: null,
            complete: true,
          },
        ],
      }),
    },
  });
  const nativeServer = await listenNative(nativeService, nativeSocket);
  t.after(
    () =>
      new Promise((resolve) => {
        nativeServer.closeAllConnections();
        nativeServer.close(resolve);
      }),
  );
  const process = spawn(globalThis.process.execPath, ["ops/gpt/login-gateway.mjs"], {
    env: {
      ...globalThis.process.env,
      GPT_PUBLIC_ORIGIN: f.config.hub.publicBaseUrl,
      GPT_HUB_URL: f.base,
      HUB_ENGINE_SOCKET: socketPath,
      GPT_GATEWAY_PORT: String(port),
      GPT_NATIVE_USER_ID: f.registry.ownerId,
      GPT_NATIVE_VNC_PASSWORD_FILE: nativePasswordFile,
      GPT_NATIVE_ADAPTER_SOCKET: nativeSocket,
      GPT_NATIVE_GUACD_PORT: String(remotePort),
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
  const nativePage = await fetch(`http://127.0.0.1:${port}/gpt-connect?runtime=native`, {
    headers: { cookie: f.owner.cookie },
  });
  assert.equal(nativePage.status, 200);
  const nativeHtml = await nativePage.text();
  assert(nativeHtml.includes('name="codex-runtime" content="native"'));
  assert(!nativeHtml.includes("labpass1"));
  assert(nativeHtml.includes('name="codex-native-adapter" content="read-only"'));
  const nativeHistory = `http://127.0.0.1:${port}/gpt-connect/native/history/${nativeConversation}`;
  assert.equal((await fetch(nativeHistory, { headers: { cookie: f.friend.cookie } })).status, 401);
  assert.equal((await fetch(nativeHistory)).status, 401);
  const readable = await fetch(nativeHistory, { headers: { cookie: f.owner.cookie } });
  assert.equal(readable.status, 200);
  assert.equal((await readable.json()).items[0].text, "Private native reply");
  const nativeLive = new WebSocket(
    `ws://127.0.0.1:${port}/gpt-connect/remote?runtime=native&workspace=${f.registry.ownerId}`,
    {
      headers: { Cookie: f.owner.cookie, Origin: f.config.hub.publicBaseUrl },
    },
  );
  t.after(() => nativeLive.terminate());
  await once(nativeLive, "message");
  assert.deepEqual(connected, [["codex-web-gpt-native-lab", "5900", "labpass1"]]);
  assert.equal((await fetch(nativeHistory, { headers: { cookie: f.owner.cookie } })).status, 503);
  const resume = `http://127.0.0.1:${port}/gpt-connect/native/resume`;
  assert.equal(
    (
      await fetch(resume, {
        method: "POST",
        headers: {
          cookie: f.owner.cookie,
          origin: "https://other.test",
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await nativeService.request({ userId: f.registry.ownerId, operation: "status" })).manual,
    true,
  );
  const nativeClosed = once(nativeLive, "close");
  let resumeEntered, finishResume;
  const entered = new Promise((resolve) => {
    resumeEntered = resolve;
  });
  const holdResume = new Promise((resolve) => {
    finishResume = resolve;
  });
  const nativeRequest = nativeService.request.bind(nativeService);
  nativeService.request = async (input) => {
    if (input.operation === "resumeManual") {
      resumeEntered();
      await holdResume;
    }
    return nativeRequest(input);
  };
  const resumeRequest = () =>
    fetch(resume, {
      method: "POST",
      headers: {
        cookie: f.owner.cookie,
        origin: f.config.hub.publicBaseUrl,
        "content-type": "application/json",
      },
      body: "{}",
    });
  const returning = resumeRequest();
  await entered;
  assert.equal((await resumeRequest()).status, 409);
  finishResume();
  assert.equal((await returning).status, 200);
  await nativeClosed;
  assert.equal((await fetch(nativeHistory, { headers: { cookie: f.owner.cookie } })).status, 200);
  assert.equal(
    (await nativeService.request({ userId: f.registry.ownerId, operation: "status" })).manual,
    false,
  );
  connected.length = 0;
  for (const suffix of ["runtime=native", "runtime=native&workspace=" + f.registry.ownerId]) {
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/gpt-connect?${suffix}`, {
          headers: { cookie: f.friend.cookie },
        })
      ).status,
      401,
    );
  }
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
test("contact book exposes only active display identity, with Unicode search and no private directory", async (t) => {
  const f = await fixture(t);
  const contacts = await f.request("/api/team/contacts", f.friend);
  assert.equal(contacts.status, 200);
  assert.equal(contacts.body.items.length, 2);
  for (const contact of contacts.body.items)
    assert.deepEqual(Object.keys(contact).sort(), ["id", "name", "own"]);
  assert.equal(contacts.body.items.find((c) => c.id === f.friendId).own, true);
  assert.equal(
    (await f.request("/api/team/contacts?q=" + encodeURIComponent("ДРУ"))).body.items[0].id,
    f.friendId,
  );
  assert.equal((await f.request("/api/team/contacts", {})).status, 401);
  assert.equal((await f.request("/api/team/users", f.friend)).status, 403);
});

test("project Links: select contact, recipient alone selects private target, exact consent and no membership grant", async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID(),
    hidden = randomUUID(),
    linkId = randomUUID();
  for (const [id, user, title] of [
    [a, f.owner, "Engine"],
    [b, f.friend, "Game"],
    [hidden, f.friend, "UNPUBLISHED"],
  ])
    assert.equal(
      (await f.request("/api/team/projects/" + id, user, "PUT", { title, visibility: "private" }))
        .status,
      200,
    );
  const policy = { direction: "outgoing", consult: true, bridge: true, automatic: false, depth: 3 };
  const body = { projectId: a, userId: f.friendId, purpose: "Связать движок и игру", policy };
  const put = () => f.request("/api/team/links/" + linkId, f.owner, "PUT", body);
  assert.equal((await put()).body.target, null);
  assert.equal((await put()).body.revision, 1);
  assert.equal(
    (await f.request("/api/team/link-invitations", f.friend)).body.items[0].source.title,
    "Engine",
  );
  assert.equal((await f.request("/api/team/projects/" + a, f.friend)).status, 404);
  assert.equal((await f.request("/api/team/projects/" + b, f.owner)).status, 404);
  assert(
    !JSON.stringify((await f.request("/api/team/projects", f.owner)).body).includes("UNPUBLISHED"),
  );
  const headers = { "idempotency-key": randomUUID() },
    accept = { revision: 1, accept: true, projectId: b };
  assert.equal(
    (await f.request(`/api/team/links/${linkId}/answer`, f.owner, "POST", accept, headers)).status,
    404,
  );
  assert.equal(
    (await f.request(`/api/team/links/${linkId}/answer`, f.friend, "POST", accept, headers)).body
      .state,
    "accepted",
  );
  assert.equal(
    (await f.request(`/api/team/links/${linkId}/answer`, f.friend, "POST", accept, headers)).body
      .revision,
    2,
  );
  const saved = (await f.request(`/api/team/projects/${a}/links`, f.owner)).body.items[0];
  assert.equal(saved.target.title, "Game");
  assert(!JSON.stringify(saved).includes("UNPUBLISHED"));
  assert.equal(
    f.teamLinks.permitted(f.registry.ownerId, a, linkId, "consult").target.ownerId,
    f.friendId,
  );
  assert.throws(() => f.teamLinks.permitted(f.registry.ownerId, a, linkId, "consult", true));
  assert.throws(() => f.teamLinks.permitted(f.friendId, b, linkId, "consult"));
  assert.equal((await f.request("/api/team/projects/" + b, f.owner)).status, 404);
  assert.equal((await f.request("/api/team/projects/" + a, f.friend)).status, 404);
  assert.equal(
    (await f.request(`/api/team/links/${linkId}`, f.owner, "PUT", { ...body, purpose: "другое" }))
      .status,
    409,
  );
});

test("Links reject admin bypass, unauthorized target, stale consent and disabled owners; revocation preserves history", async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID(),
    linkId = randomUUID();
  f.teamProjects.create(f.registry.ownerId, a, {
    title: "A",
    visibility: "private",
    repository: null,
  });
  f.teamProjects.create(f.friendId, b, { title: "B", visibility: "private", repository: null });
  const input = {
    projectId: a,
    userId: f.friendId,
    purpose: "API",
    policy: { direction: "both", consult: true, bridge: true, automatic: true, depth: 2 },
  };
  assert.throws(() =>
    f.teamLinks.propose(f.registry.ownerId, randomUUID(), { ...input, projectId: b }),
  );
  f.teamLinks.propose(f.registry.ownerId, linkId, input);
  assert.throws(() =>
    f.teamLinks.answer(f.friendId, linkId, randomUUID(), {
      revision: 1,
      accept: true,
      projectId: a,
    }),
  );
  assert.throws(() =>
    f.teamLinks.answer(f.friendId, linkId, randomUUID(), {
      revision: 2,
      accept: true,
      projectId: b,
    }),
  );
  f.teamLinks.answer(f.friendId, linkId, randomUUID(), { revision: 1, accept: true, projectId: b });
  assert.equal(f.teamLinks.permitted(f.friendId, b, linkId, "consult", true, 2).target.id, a);
  const receipt = randomUUID();
  f.teamLinks.revoke(f.friendId, b, linkId, receipt, 2);
  f.teamLinks.revoke(f.friendId, b, linkId, receipt, 2);
  assert.equal(f.teamLinks.page(f.registry.ownerId, a).items[0].state, "revoked");
  assert.throws(() => f.teamLinks.permitted(f.registry.ownerId, a, linkId, "consult"));
  assert.throws(() =>
    f.teamLinks.answer(f.friendId, linkId, randomUUID(), {
      revision: 3,
      accept: true,
      projectId: b,
    }),
  );
  const next = randomUUID();
  f.teamLinks.propose(f.registry.ownerId, next, input);
  f.registry.db.prepare("UPDATE team_users SET state='disabled' WHERE id=?").run(f.friendId);
  assert.throws(() =>
    f.teamLinks.answer(f.friendId, next, randomUUID(), { revision: 1, accept: true, projectId: b }),
  );
  assert.equal((await f.request("/api/team/contacts")).body.items.length, 1);
});

test("native GPT owner admission never leaks through member configuration or injected client", async (t) => {
  const marker = { client: {}, conversations: new Set(), creationKeys: new Set() },
    seen = [];
  const f = await fixture(t, {
    nativeGpt: marker,
    personalFactory: async (config, options) => {
      seen.push(options.nativeGpt);
      return createApp(config, options);
    },
  });
  f.config.nativeGpt = {
    userId: f.registry.ownerId,
    accountFingerprint: "a".repeat(64),
    socketPath: "/private/adapter.sock",
  };
  assert.equal(
    privateConfig(f.config, f.registry, f.registry.ownerId).nativeGpt,
    f.config.nativeGpt,
  );
  assert.equal(privateConfig(f.config, f.registry, f.friendId).nativeGpt, undefined);
  await f.personal(f.registry.ownerId);
  await f.personal(f.friendId);
  assert.equal(seen[0], marker);
  assert.equal(seen[1], undefined);
  f.registry.db
    .prepare("INSERT OR REPLACE INTO team_meta VALUES('nativeAdmission','blocked')")
    .run();
  assert.equal(privateConfig(f.config, f.registry, f.registry.ownerId).nativeGpt, undefined);
});
