import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collaborationPolicy } from "../apps/hub/dist/collaboration-policy.js";
import { registerCollaborationSpaces } from "../apps/hub/dist/collaboration-routes.js";
import { CollaborationSpaces } from "../apps/hub/dist/collaboration-spaces.js";
import { Store } from "../apps/hub/dist/store.js";
import { TeamProjects } from "../apps/hub/dist/team-projects.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import Fastify from "../apps/hub/node_modules/fastify/fastify.js";
import { configSchema } from "../packages/shared/dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cw-spaces-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://spaces.example.test",
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "files"),
    },
    auth: { username: "owner" },
    team: { enabled: true, root: join(root, "team") },
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath);
  store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", "fixture-password-hash");
  const registry = new TeamStore(join(root, "team.db"), config, store);
  const owner = registry.ownerId;
  const member = (name) =>
    registry.accept(registry.invite(owner, name).token, name, name, "fixture-password-hash", 10).id;
  const friend = member("friend"),
    stranger = member("stranger");
  const team = new TeamProjects(registry),
    spaces = new CollaborationSpaces(team);
  t.after(async () => {
    registry.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = (id, repository = "https://github.com/example/altar") => ({
    personalProjectId: id,
    name: id,
    repository,
  });
  const input = (kind = "space") => ({
    title: "Altar + World",
    kind,
    userId: friend,
    personalProjectId: "altar",
    access: "collaborate",
    requestedAccess: "direct",
  });
  return { root, registry, team, spaces, owner, friend, stranger, project, input };
}

test("Human chat persists paged messages, exact retries and per-member unread cursors", async (t) => {
  const f = await fixture(t);
  const s = f.spaces.create(f.owner, randomUUID(), f.input(), f.project("altar"));
  assert.throws(() => f.spaces.chat.page(f.friend, s.id, {}), /недоступно/);
  f.spaces.answer(
    f.friend,
    s.id,
    randomUUID(),
    { revision: 1, accept: true, access: "collaborate", personalProjectId: "world" },
    f.project("world", "https://github.com/example/world"),
  );
  const chat = f.spaces.chat,
    keys = Array.from({ length: 25 }, () => randomUUID());
  const sent = keys.map((key, i) =>
    chat.send(f.owner, s.id, key, { text: `Сообщение ${i}: https://example.com/`, files: [] }),
  );
  assert.deepEqual(
    chat.send(f.owner, s.id, keys[0], { text: "Сообщение 0: https://example.com/", files: [] }),
    sent[0],
  );
  assert.throws(() => chat.send(f.owner, s.id, keys[0], { text: "changed", files: [] }));
  assert.equal(f.spaces.catalog(f.friend).spaces[0].unread, 25);
  assert.equal(f.spaces.catalog(f.owner).spaces[0].unread, 0);
  const latest = chat.page(f.friend, s.id, {});
  assert.equal(latest.messages.length, 20);
  assert.equal(latest.more, true);
  assert.equal(latest.messages[0].id, sent[5].id);
  assert.equal(chat.page(f.friend, s.id, { before: sent[5].seq }).messages.length, 5);
  assert.equal(chat.page(f.friend, s.id, { after: sent[23].seq }).messages[0].id, sent[24].id);
  chat.markRead(f.friend, s.id, sent[20].seq);
  chat.markRead(f.friend, s.id, sent[0].seq);
  chat.markRead(f.friend, s.id, 999999);
  assert.equal(chat.unread(f.friend, s.id), 4);
  const restored = new CollaborationSpaces(f.team);
  assert.equal(restored.catalog(f.friend).spaces[0].unread, 4);
  chat.send(f.friend, s.id, randomUUID(), { text: "Ответ", files: [] });
  assert.equal(chat.unread(f.owner, s.id), 1);
  assert.throws(() => chat.page(f.stranger, s.id, {}));
  f.spaces.leave(f.friend, s.id, randomUUID(), { revision: 2 });
  assert.throws(() => chat.page(f.friend, s.id, {}));
  assert.throws(() =>
    chat.send(f.friend, s.id, keys[0], { text: "Сообщение 0: https://example.com/", files: [] }),
  );
});

test("Chat routes deliver exact file bytes, bind uploads to sender and revoke access on leave", async (t) => {
  const f = await fixture(t);
  const made = f.spaces.create(f.owner, randomUUID(), f.input(), f.project("altar"));
  f.spaces.answer(
    f.friend,
    made.id,
    randomUUID(),
    { revision: 1, accept: true, access: "collaborate", personalProjectId: "world" },
    f.project("world", "https://github.com/example/world"),
  );
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(error.name === "ZodError" ? 400 : (error.statusCode ?? 500))
      .send({ error: error.message }),
  );
  t.after(() => app.close());
  registerCollaborationSpaces(
    app,
    f.team,
    (req) => req.headers["test-user"],
    () => {
      throw Error("Human chat must not load personal runtime");
    },
    f.spaces,
  );
  const base = `/api/team/spaces/${made.id}/chat`;
  const request = (actor, method, url, payload, headers = {}) =>
    app.inject({ method, url, payload, headers: { "test-user": actor, ...headers } });
  const bytes = Buffer.from("Файл участникам — без замены на JSON", "utf8");
  const upload = await request(
    f.owner,
    "POST",
    base + "/files?name=example.txt&mime=text%2Fplain",
    bytes,
    { "content-type": "application/octet-stream" },
  );
  assert.equal(upload.statusCode, 200, upload.body);
  const file = upload.json();
  assert.equal((await request(f.friend, "GET", base + `/files/${file.id}`)).statusCode, 404);
  assert.equal(
    (
      await request(
        f.friend,
        "POST",
        base,
        { text: "Не мой файл", files: [file.id] },
        { "idempotency-key": randomUUID() },
      )
    ).statusCode,
    404,
  );
  const key = randomUUID(),
    body = { text: "Смотри https://example.com/", files: [file.id] };
  const sent = await request(f.owner, "POST", base, body, { "idempotency-key": key });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(
    (await request(f.owner, "POST", base, body, { "idempotency-key": key })).json(),
    sent.json(),
  );
  const download = await request(f.friend, "GET", base + `/files/${file.id}`);
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  assert.match(download.headers["content-disposition"], /example.txt/);
  assert.equal((await request(f.stranger, "GET", base)).statusCode, 404);
  assert.equal(
    (
      await request(
        f.owner,
        "POST",
        base,
        { text: "", files: [] },
        { "idempotency-key": randomUUID() },
      )
    ).statusCode,
    400,
  );
  f.spaces.leave(f.friend, made.id, randomUUID(), { revision: 2 });
  assert.equal((await request(f.friend, "GET", base + `/files/${file.id}`)).statusCode, 404);
  f.spaces.leave(f.owner, made.id, randomUUID(), { revision: 3 });
  assert.equal(f.team.db.prepare("SELECT count(*) n FROM space_chat_messages").get().n, 0);
});

test("Space invitation preserves asymmetric grants and only exposes the viewer's own native Project identity", async (t) => {
  const f = await fixture(t),
    key = randomUUID(),
    input = f.input();
  const made = f.spaces.create(f.owner, key, input, f.project("altar"));
  assert.deepEqual(f.spaces.create(f.owner, key, input, f.project("ignored")), made);
  assert.deepEqual(f.spaces.catalog(f.stranger), { spaces: [], invitations: [] });
  assert.throws(() => f.spaces.access(f.stranger, made.id));
  const invited = f.spaces.catalog(f.friend);
  assert.equal(invited.spaces.length, 0);
  assert.equal(invited.invitations[0].requestedAccess, "direct");
  assert.equal(JSON.stringify(invited).includes("personalProjectId"), false);
  const answer = { revision: 1, accept: true, access: "collaborate", personalProjectId: "world" };
  const answerKey = randomUUID();
  f.spaces.answer(
    f.friend,
    made.id,
    answerKey,
    answer,
    f.project("world", "https://github.com/example/world"),
  );
  f.spaces.answer(f.friend, made.id, answerKey, answer, f.project("world"));
  const owner = f.spaces.catalog(f.owner).spaces[0],
    friend = f.spaces.catalog(f.friend).spaces[0];
  assert.equal(
    owner.projects[1].access,
    "collaborate",
    "recipient need not grant requested direct access",
  );
  assert.equal(owner.projects[1].personalProjectId, undefined);
  assert.equal(friend.projects[0].personalProjectId, undefined);
  assert.equal(friend.projects[0].access, "collaborate");
  assert.equal(friend.projects[1].personalProjectId, "world");
  assert.equal(owner.projects[0].personalProjectId, "altar");
  assert.throws(() =>
    f.spaces.rename(f.friend, made.id, randomUUID(), { revision: 2, title: "No" }),
  );
  assert.throws(() =>
    f.spaces.rename(f.owner, made.id, randomUUID(), { revision: 1, title: "Stale" }),
  );
  const reopened = new CollaborationSpaces(new TeamProjects(f.registry));
  assert.deepEqual(reopened.catalog(f.owner), f.spaces.catalog(f.owner));
  f.spaces.leave(f.friend, made.id, randomUUID(), { revision: 2 });
  assert.equal(f.spaces.catalog(f.friend).spaces.length, 0);
  assert.equal(f.spaces.catalog(f.owner).spaces[0].projects.length, 1);
  assert.equal(f.spaces.catalog(f.owner).spaces[0].projects[0].personalProjectId, "altar");
});

test("One-project acceptance requires the same repository and reuses each person's Project, closing restores navigation metadata", async (t) => {
  const f = await fixture(t),
    made = f.spaces.create(f.owner, randomUUID(), f.input("project"), f.project("altar"));
  const answer = { revision: 1, accept: true, personalProjectId: "my-altar" };
  assert.throws(() =>
    f.spaces.answer(
      f.friend,
      made.id,
      randomUUID(),
      answer,
      f.project("my-altar", "https://github.com/elsewhere/repo"),
    ),
  );
  assert.equal(f.spaces.catalog(f.friend).invitations.length, 1);
  f.spaces.answer(f.friend, made.id, randomUUID(), answer, f.project("my-altar"));
  const seen = f.spaces.catalog(f.friend).spaces[0];
  assert.equal(seen.projects.length, 1);
  assert.equal(seen.projects[0].personalProjectId, "my-altar");
  assert.throws(() =>
    f.spaces.create(
      f.friend,
      randomUUID(),
      { ...f.input(), userId: f.owner, personalProjectId: "my-altar" },
      f.project("my-altar"),
    ),
  );
  f.spaces.leave(f.owner, made.id, randomUUID(), { revision: 2 });
  assert.deepEqual(f.spaces.catalog(f.friend), { spaces: [], invitations: [] });
  // Available again: no native project or chat is deleted by leaving/closing.
  f.spaces.create(
    f.friend,
    randomUUID(),
    { ...f.input(), userId: f.owner, personalProjectId: "my-altar" },
    f.project("my-altar"),
  );
});

test("Routes inspect only the actor's selected checkout, survive lost acknowledgements, and reject foreign selection", async (t) => {
  const f = await fixture(t),
    app = Fastify();
  t.after(() => app.close());
  const roots = {};
  for (const user of [f.owner, f.friend]) {
    roots[user] = join(f.root, user);
    await mkdir(roots[user]);
    execFileSync("git", ["init", "-q", roots[user]]);
    execFileSync("git", [
      "-C",
      roots[user],
      "remote",
      "add",
      "origin",
      "https://github.com/example/altar.git",
    ]);
  }
  let reads = 0;
  const machine = {
    id: "local",
    name: "Local",
    type: "local-linux",
    allowedRoots: [f.root],
    codex: {},
  };
  registerCollaborationSpaces(
    app,
    f.team,
    (req) => f.registry.active(String(req.headers["test-actor"])).id,
    async (actor) => ({
      runtime: {
        sessions: {
          project: (id) => {
            reads++;
            assert.equal(id, actor, "must use the actor's own catalog");
            return { id, name: actor, machineId: "local", workingDirectory: roots[actor] };
          },
          catalog: { machine: () => machine },
        },
        projectWork: { context: { assertProject: () => {} } },
      },
    }),
  );
  const send = (actor, path, body, key = randomUUID()) =>
    app.inject({
      method: "POST",
      url: path,
      headers: { "test-actor": actor, "idempotency-key": key },
      payload: body,
    });
  const key = randomUUID(),
    input = { ...f.input("project"), personalProjectId: f.owner };
  const made = await send(f.owner, "/api/team/spaces", input, key);
  assert.equal(made.statusCode, 200, made.body);
  const id = made.json().id;
  const again = await send(f.owner, "/api/team/spaces", input, key);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(reads, 1, "receipt retry does not re-read Git or acquire native writers");
  const wrong = await send(f.friend, `/api/team/spaces/${id}/answer`, {
    revision: 1,
    accept: true,
    personalProjectId: f.owner,
  });
  assert.notEqual(wrong.statusCode, 200);
  const answer = { revision: 1, accept: true, personalProjectId: f.friend },
    answerKey = randomUUID();
  const accepted = await send(f.friend, `/api/team/spaces/${id}/answer`, answer, answerKey);
  assert.equal(accepted.statusCode, 200, accepted.body);
  const acceptedAgain = await send(f.friend, `/api/team/spaces/${id}/answer`, answer, answerKey);
  assert.equal(acceptedAgain.statusCode, 200, acceptedAgain.body);
  assert.equal(f.spaces.catalog(f.friend).spaces[0].projects[0].personalProjectId, f.friend);
});

test("Project management, explicit elevation and Git publication follow the owning participant's current grant", async (t) => {
  const f = await fixture(t),
    { spaces: s, owner, friend } = f;
  const { id } = s.create(owner, randomUUID(), f.input(), f.project("altar"));
  s.answer(
    friend,
    id,
    randomUUID(),
    { revision: 1, accept: true, personalProjectId: "world", access: "collaborate" },
    f.project("world", "https://github.com/example/world"),
  );
  const current = () => s.catalog(owner).spaces[0];
  const altar = current().projects[0];
  assert.throws(() =>
    s.bindCopy(
      friend,
      id,
      randomUUID(),
      { revision: current().revision, projectId: altar.id, personalProjectId: "wrong" },
      f.project("wrong", "https://github.com/example/wrong"),
    ),
  );
  s.bindCopy(
    friend,
    id,
    randomUUID(),
    { revision: current().revision, projectId: altar.id, personalProjectId: "friend-altar" },
    f.project("friend-altar"),
  );
  const policy = collaborationPolicy(s, friend);
  assert.match(policy.instructions("friend-altar"), /working branch and a pull request/);
  assert.equal(policy.instructions("private"), null);
  const receipt = (branch = "main") => ({
    kind: "push",
    snapshot: { branch, github: { repository: "example/altar", defaultBranch: "main" } },
  });
  assert.throws(() => policy.delivery("friend-altar", receipt()), {
    code: "SPACE_WORKING_BRANCH_REQUIRED",
  });
  policy.delivery("friend-altar", receipt("feature/world"));
  assert.throws(() =>
    s.grant(friend, id, randomUUID(), {
      revision: current().revision,
      projectId: altar.id,
      userId: friend,
      access: "direct",
    }),
  );
  s.requestAccess(friend, id, randomUUID(), { revision: current().revision, projectId: altar.id });
  assert.deepEqual(current().projects[0].requests, [friend]);
  assert.throws(() => policy.delivery("friend-altar", receipt()), "a request alone grants nothing");
  s.grant(owner, id, randomUUID(), {
    revision: current().revision,
    projectId: altar.id,
    userId: friend,
    access: "direct",
  });
  policy.delivery("friend-altar", receipt());
  assert.match(policy.instructions("friend-altar"), /Direct publication/);
  assert.deepEqual(current().projects[0].requests, []);
  s.grant(owner, id, randomUUID(), {
    revision: current().revision,
    projectId: altar.id,
    userId: friend,
    access: "collaborate",
  });
  assert.throws(
    () => policy.delivery("friend-altar", receipt()),
    "existing prepared publication uses the current grant",
  );
  const add = { revision: current().revision, personalProjectId: "assets", access: "direct" },
    key = randomUUID();
  s.addProject(owner, id, key, add, f.project("assets", "https://github.com/example/assets"));
  s.addProject(owner, id, key, add, f.project("assets", "https://github.com/example/assets"));
  const asset = current().projects.find((p) => p.personalProjectId === "assets");
  assert.equal(
    s.catalog(friend).spaces[0].projects.find((p) => p.id === asset.id).access,
    "direct",
  );
  assert.throws(() =>
    s.removeProject(friend, id, randomUUID(), {
      revision: current().revision,
      projectId: asset.id,
    }),
  );
  s.removeProject(owner, id, randomUUID(), { revision: current().revision, projectId: asset.id });
  assert.equal(s.binding(owner, "assets"), null);
  s.removeMember(owner, id, randomUUID(), { revision: current().revision, userId: friend });
  assert.equal(s.binding(friend, "friend-altar"), null);
  assert.equal(policy.instructions("friend-altar"), null);
  assert.deepEqual(s.catalog(friend), { spaces: [], invitations: [] });
  assert.equal(current().projects.length, 1);
});
