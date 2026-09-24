import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { BrainstormRooms, brainstormSnapshotContext } from "../apps/hub/dist/brainstorm.js";
import { BrainstormGpts } from "../apps/hub/dist/brainstorm-gpt.js";
import { registerBrainstorm } from "../apps/hub/dist/brainstorm-routes.js";
import { BrainstormVoice } from "../apps/hub/dist/brainstorm-voice.js";
import { collaborationPolicy } from "../apps/hub/dist/collaboration-policy.js";
import { CollaborationSpaces } from "../apps/hub/dist/collaboration-spaces.js";
import { Store } from "../apps/hub/dist/store.js";
import {
  createTeamSnapshot,
  restoreTeamSnapshot,
  verifyTeamSnapshot,
} from "../apps/hub/dist/team-maintenance.js";
import { TeamProjects } from "../apps/hub/dist/team-projects.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import Fastify from "../apps/hub/node_modules/fastify/fastify.js";
import { strFromU8, unzipSync } from "../apps/hub/node_modules/fflate/esm/index.mjs";
import { WebSocket } from "../apps/hub/node_modules/ws/wrapper.mjs";
import { configSchema, isFileSource } from "../packages/shared/dist/index.js";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cw-brainstorm-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://rooms.test",
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "files"),
    },
    auth: { username: "owner" },
    team: { enabled: true, root: join(root, "team") },
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath);
  store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", "fixture-hash");
  await mkdir(config.team.root, { recursive: true, mode: 0o700 });
  const registry = new TeamStore(join(config.team.root, "team.db"), config, store),
    owner = registry.ownerId;
  const friend = registry.accept(
    registry.invite(owner, "friend").token,
    "friend",
    "friend",
    "fixture-hash",
    10,
  ).id;
  const team = new TeamProjects(registry),
    spaces = new CollaborationSpaces(team),
    rooms = new BrainstormRooms(team);
  const room = rooms.create(owner, randomUUID(), { title: "One", description: "Shared ideas" });
  const second = rooms.create(friend, randomUUID(), { title: "Two", description: "Other room" });
  t.after(async () => {
    registry.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, store, registry, owner, friend, team, spaces, rooms, room, second };
}
const card = (patch = {}) => ({
  kind: "note",
  title: "Idea",
  text: "Shared evidence",
  url: "",
  fileId: null,
  x: 10,
  y: 20,
  width: 300,
  points: [],
  revision: 0,
  ...patch,
});
const until = async (fn) => {
  for (let n = 0; n < 350; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Timed out");
};

test("Board groups and exact links survive edits, deltas and snapshots without crossing rooms", async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID(),
    foreign = randomUUID();
  f.rooms.put(f.owner, f.room.id, a, randomUUID(), card({ title: "Design" }));
  f.rooms.put(f.friend, f.second.id, foreign, randomUUID(), card());
  const before = f.rooms.state(f.owner, f.room.id).version;
  const grouped = f.rooms.put(
    f.friend,
    f.room.id,
    b,
    randomUUID(),
    card({ group: "  Interface  ", links: [a] }),
  );
  assert.equal(grouped.group, "Interface");
  assert.equal(
    JSON.parse(f.rooms.context(f.owner, f.room.id)).cards.find((c) => c.id === b).group,
    "Interface",
  );
  assert.deepEqual(f.rooms.state(f.owner, f.room.id, before).cards[0].links, [a]);
  const legacy = f.rooms.put(
    f.owner,
    f.room.id,
    b,
    randomUUID(),
    card({ revision: 1, text: "Older client text" }),
  );
  assert.equal(legacy.group, "Interface");
  assert.deepEqual(legacy.links, [a]);
  for (const target of [foreign, b, randomUUID()])
    assert.throws(
      () =>
        f.rooms.put(f.owner, f.room.id, b, randomUUID(), card({ revision: 2, links: [target] })),
      { code: "BOARD_LINK_UNAVAILABLE" },
    );
  assert.throws(
    () => f.rooms.put(f.friend, f.room.id, b, randomUUID(), card({ revision: 1, group: "Stale" })),
    { code: "ROOM_CHANGED" },
  );
  const snapshot = f.rooms.snapshot(f.owner, f.room.id, randomUUID(), {
    title: "Ideas",
    cardIds: [a, b],
    messageIds: [],
    summary: "",
    participants: [],
  });
  assert.deepEqual(snapshot.snapshot.cards.find((c) => c.id === b).links, [a]);
  assert.match(JSON.stringify(brainstormSnapshotContext(snapshot.snapshot)), /Interface/);
  f.rooms.remove(f.owner, f.room.id, a, randomUUID(), 1);
  // A formerly linked deleted card remains provenance; new links to it are rejected.
  f.rooms.put(f.owner, f.room.id, b, randomUUID(), card({ revision: 2, links: [a] }));
  assert.throws(
    () => f.rooms.put(f.owner, f.room.id, randomUUID(), randomUUID(), card({ links: [a] })),
    { code: "BOARD_LINK_UNAVAILABLE" },
  );
  const cleared = f.rooms.put(
    f.owner,
    f.room.id,
    b,
    randomUUID(),
    card({ revision: 3, links: [], group: "" }),
  );
  assert.deepEqual(cleared.links, []);
  assert.equal(cleared.group, "");
});

test("Public rooms, private preferences, exact optimistic edits and incremental removal survive restart", async (t) => {
  const f = await fixture(t),
    r = f.room.id,
    id = randomUUID(),
    key = randomUUID();
  assert.equal(f.rooms.catalog(f.friend).rooms.length, 2);
  const initial = f.rooms.state(f.friend, r);
  assert.equal(initial.reset, true);
  const added = f.rooms.put(f.owner, r, id, key, card());
  assert.deepEqual(f.rooms.put(f.owner, r, id, key, card()), added);
  assert.throws(() => f.rooms.put(f.friend, f.second.id, id, randomUUID(), card()), {
    code: "ROOM_MISSING",
  });
  const delta = f.rooms.state(f.friend, r, initial.version);
  assert.equal(delta.cards.length, 1);
  assert.equal(delta.reset, false);
  f.rooms.put(f.friend, r, id, randomUUID(), card({ revision: 1, text: "Edited" }));
  assert.throws(() => f.rooms.put(f.owner, r, id, randomUUID(), card({ revision: 1 })), {
    code: "ROOM_CHANGED",
  });
  const current = f.rooms.state(f.owner, r, delta.version);
  f.rooms.remove(f.owner, r, id, randomUUID(), 2);
  assert.deepEqual(f.rooms.state(f.friend, r, current.version).removed, [id]);
  f.rooms.follow(f.friend, r, { following: true, muted: true });
  assert.equal(f.rooms.view(f.owner, r).muted, false);
  const restarted = new BrainstormRooms(f.team);
  assert.equal(restarted.view(f.friend, r).muted, true);
  assert.equal(restarted.state(f.owner, r).cards.length, 0);
  assert.throws(
    () =>
      f.rooms.edit(f.friend, r, randomUUID(), {
        title: "Steal",
        description: "",
        closed: true,
        revision: 1,
      }),
    { code: "ROOM_OWNER" },
  );
  f.rooms.edit(f.owner, r, randomUUID(), {
    title: "Renamed",
    description: "",
    closed: true,
    revision: 1,
  });
  assert.equal(restarted.view(f.friend, r).title, "Renamed");
  assert.throws(() => restarted.put(f.friend, r, randomUUID(), randomUUID(), card()), {
    code: "ROOM_CLOSED",
  });
});

test("Staged files stay private until publication; immutable snapshots and exports omit personal GPT summaries", async (t) => {
  const f = await fixture(t),
    r = f.room.id;
  const file = f.rooms.chat.stage(
    f.owner,
    r,
    "brief.txt",
    "text/plain",
    Buffer.from("EXACT ORIGINAL\r\n"),
  );
  assert.throws(() => f.rooms.chat.readFile(f.friend, r, file.id));
  assert.throws(() => f.rooms.chat.readFile(f.owner, f.second.id, file.id));
  const c = f.rooms.put(
    f.owner,
    r,
    randomUUID(),
    randomUUID(),
    card({ kind: "file", fileId: file.id, title: file.name }),
  );
  assert.equal(f.rooms.chat.readFile(f.friend, r, file.id).data.toString(), "EXACT ORIGINAL\r\n");
  const snap = f.rooms.snapshot(f.owner, r, randomUUID(), {
    title: "Project",
    cardIds: [c.id],
    messageIds: [],
    summary: "PRIVATE THOUGHT",
    participants: [],
  });
  f.rooms.remove(f.owner, r, c.id, randomUUID(), c.revision);
  assert.equal(f.rooms.conversion(f.owner, snap.id).snapshot.cards[0].text, "Shared evidence");
  assert.throws(() => f.rooms.conversion(f.friend, snap.id), { code: "ROOM_MISSING" });
  const app = Fastify();
  registerBrainstorm(
    app,
    f.rooms,
    f.spaces,
    () => f.owner,
    async () => {
      throw Error("no native access");
    },
    () => {},
  );
  t.after(() => app.close());
  const response = await app.inject({ url: `/api/team/brainstorm-conversions/${snap.id}/export` });
  assert.equal(response.statusCode, 200, response.body);
  const zip = unzipSync(response.rawPayload);
  assert.equal(strFromU8(zip[`files/${file.id}/brief.txt`]), "EXACT ORIGINAL\r\n");
  assert.doesNotMatch(strFromU8(zip["manifest.json"]), /PRIVATE THOUGHT/);
  assert(isFileSource(`/api/team/brainstorm/${r}/chat/files/${file.id}`));
  assert(!isFileSource(`/api/team/brainstorm/${r}/chat/files/${file.id}?other=user`));
  assert.equal(
    (await app.inject({ url: `/api/team/brainstorm/${r}/snapshots` })).json().items[0].id,
    snap.id,
  );
});

test("Private room GPT binds user × room, freezes retries, restores native creation and blocks closed-room delivery", async (t) => {
  const f = await fixture(t),
    native = nativeWorkspaceFixture(),
    runtime = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => runtime.close());
  const service = new BrainstormGpts(f.owner, f.rooms, runtime),
    key = randomUUID();
  const state = service.get(f.room.id),
    other = service.get(f.second.id);
  assert.equal(state.nativeId, null);
  assert.equal(other.nativeId, null);
  assert.equal(native.state.sends, 0, "opening never sends");
  const input = {
    ...native.input,
    nativeId: null,
    text: "Room-specific task",
    revision: state.revision,
  };
  native.workspace.creationKeys.add(key);
  const reconcile = native.client.reconcileDispatch;
  native.client.reconcileDispatch = async (...args) => ({
    ...(await reconcile(...args)),
    conversationId: native.conversationId,
  });
  service.send(f.room.id, key, input);
  await until(() => native.state.sends === 1);
  assert.match(native.state.input.text, /Shared ideas/);
  assert.doesNotMatch(native.state.input.text, /Other room/);
  assert.equal(service.send(f.room.id, key, input).id, key);
  assert.throws(() => service.send(f.second.id, key, input), { code: "ROOM_GPT_CHANGED" });
  assert.throws(() => service.send(f.room.id, key, { ...input, text: "Other" }), {
    code: "ROOM_GPT_CHANGED",
  });
  native.state.finished = true;
  await until(() => runtime.gpt.job(key).status === "completed").catch((e) => {
    throw Error(JSON.stringify(runtime.gpt.job(key)), { cause: e });
  });
  const restarted = new BrainstormGpts(f.owner, f.rooms, runtime);
  assert.equal(restarted.get(f.room.id).nativeId, native.conversationId);
  assert.equal(restarted.get(f.second.id).nativeId, null);
  const friendNative = nativeWorkspaceFixture(),
    friendRuntime = await handoffFixture(undefined, undefined, {
      nativeGpt: friendNative.workspace,
    });
  t.after(() => friendRuntime.close());
  const privateFriend = new BrainstormGpts(f.friend, f.rooms, friendRuntime);
  assert.equal(privateFriend.get(f.room.id).nativeId, null);
  assert.equal(friendNative.state.sends, 0);
  f.rooms.edit(f.owner, f.room.id, randomUUID(), {
    title: "Closed",
    description: "",
    closed: true,
    revision: 1,
  });
  assert.throws(
    () => restarted.send(f.room.id, randomUUID(), { ...input, nativeId: native.conversationId }),
    { code: "ROOM_CLOSED" },
  );
});

test("Shared GPT snapshot has a strict budget and excludes every private owner field", async (t) => {
  const f = await fixture(t);
  const snapshot = {
    room: f.room,
    cards: Array.from({ length: 200 }, () => ({
      ...card({ text: "x".repeat(16000), url: "https://example.test/" }),
      id: randomUUID(),
    })),
    messages: [],
  };
  assert(JSON.stringify(brainstormSnapshotContext(snapshot)).length < 26000);
  const space = f.spaces.create(
    f.owner,
    randomUUID(),
    {
      title: "Project",
      kind: "project",
      userId: f.friend,
      personalProjectId: "project",
      access: "collaborate",
      requestedAccess: "collaborate",
    },
    {
      personalProjectId: "project",
      name: "project",
      repository: "https://github.com/example/project",
    },
  );
  f.spaces.answer(
    f.friend,
    space.id,
    randomUUID(),
    { revision: 1, accept: true },
    {
      personalProjectId: "friend-copy",
      name: "copy",
      repository: "https://github.com/example/project",
    },
  );
  const conversion = {
    id: randomUUID(),
    roomId: f.room.id,
    projectId: "project",
    spaceId: space.id,
    summary: "OWNER PRIVATE",
    snapshot,
  };
  f.team.db
    .prepare("INSERT INTO brainstorm_conversions VALUES(?,?,?,?)")
    .run(conversion.id, f.room.id, f.owner, JSON.stringify(conversion));
  const context = collaborationPolicy(f.spaces, f.friend).gptContext("friend-copy");
  assert(context.brainstorm);
  assert.doesNotMatch(JSON.stringify(context), /OWNER PRIVATE/);
});

test("Voice forwards only in-room unmuted PCM, deafen works, bad frames close and disconnect frees participants", async (t) => {
  const f = await fixture(t),
    voice = new BrainstormVoice(f.rooms),
    server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const q = new URL(req.url, "http://voice.test");
    try {
      voice.upgrade(req, socket, head, q.searchParams.get("room"), q.searchParams.get("user"), () =>
        f.registry.active(q.searchParams.get("user")),
      );
    } catch {
      socket.destroy();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.terminate();
    voice.close();
    await new Promise((r) => server.close(r));
  });
  const connect = async (user, room) => {
    const c = new WebSocket(`ws://127.0.0.1:${server.address().port}/?user=${user}&room=${room}`);
    clients.push(c);
    await once(c, "open");
    return c;
  };
  const a = await connect(f.owner, f.room.id),
    b = await connect(f.friend, f.room.id),
    other = await connect(f.friend, f.second.id);
  const frames = [],
    controls = [],
    foreign = [];
  b.on("message", (data, binary) => {
    if (binary) frames.push(data);
    else controls.push(JSON.parse(data.toString()));
  });
  other.on("message", (data, binary) => {
    if (binary) foreign.push(data);
  });
  a.send(JSON.stringify({ type: "state", muted: false, deafened: false }));
  a.send(Buffer.alloc(1280, 17));
  await until(() => frames.length === 1);
  assert.equal(
    controls.at(-1).peers.find((p) => p.id === controls.at(-1).self).name,
    f.registry.user(f.friend).name,
  );
  assert.equal(frames[0].length, 1284);
  assert.equal(frames[0][4], 17);
  assert.equal(foreign.length, 0);
  b.send(JSON.stringify({ type: "state", muted: false, deafened: true }));
  await new Promise((r) => setTimeout(r, 30));
  a.send(Buffer.alloc(1280));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(frames.length, 1);
  const closed = once(a, "close");
  a.send(Buffer.alloc(1281));
  await closed;
  await until(() => voice.active === 2);
});

test("Conversion requires its exact completed setup receipt, survives repeated completion and keeps room GPT independent", async (t) => {
  const f = await fixture(t);
  execFileSync("git", ["init", "-q", f.root]);
  execFileSync("git", [
    "-C",
    f.root,
    "remote",
    "add",
    "origin",
    "https://github.com/example/room.git",
  ]);
  const runtime = await handoffFixture(undefined, undefined, {
    configure: (cfg) => {
      cfg.machines[0] = { ...cfg.machines[0], type: "local-linux", allowedRoots: [f.root] };
      cfg.projects[0].workingDirectory = f.root;
    },
  });
  t.after(() => runtime.close());
  const snapshot = f.rooms.snapshot(f.owner, f.room.id, randomUUID(), {
    title: "From room",
    cardIds: [],
    messageIds: [],
    summary: "OWN PRIVATE",
    participants: [{ userId: f.friend, access: "direct" }],
  });
  const app = Fastify();
  registerBrainstorm(
    app,
    f.rooms,
    f.spaces,
    () => f.owner,
    async () => ({ runtime }),
    () => {},
  );
  t.after(() => app.close());
  const complete = () =>
    app.inject({
      method: "POST",
      url: `/api/team/brainstorm-conversions/${snapshot.id}/complete`,
      payload: { projectId: "project" },
    });
  assert.equal((await complete()).statusCode, 409);
  runtime.store.db
    .prepare("INSERT INTO project_setup_operations VALUES(?,?,?,?,?,?)")
    .run(snapshot.id, "pc", "complete", JSON.stringify({ project: { id: "project" } }), 1, 1);
  const response = await complete();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.projectId, "project");
  assert(result.spaceId);
  const invite = f.spaces.catalog(f.friend).invitations[0];
  assert.equal(invite.spaceId, result.spaceId);
  assert.match(runtime.projectGpts.get("project").context, /OWN PRIVATE/);
  assert.doesNotMatch(JSON.stringify(f.rooms.catalog(f.friend)), /OWN PRIVATE/);
  assert.deepEqual((await complete()).json(), result);
  assert.equal(f.spaces.catalog(f.friend).invitations.length, 1);
  assert.equal(f.rooms.view(f.owner, f.room.id).closed, false);
});

test("Audio worklet emits bounded 16 kHz PCM, default mute sends nothing and playback queues stay bounded", async () => {
  let Processor;
  const sent = [];
  class Base {
    constructor() {
      this.port = { postMessage: (m) => sent.push(m), onmessage: null };
    }
  }
  runInNewContext(await readFile("apps/web/public/brainstorm-audio.js", "utf8"), {
    AudioWorkletProcessor: Base,
    sampleRate: 48000,
    registerProcessor: (_name, value) => {
      Processor = value;
    },
  });
  const audio = new Processor(),
    input = [[new Float32Array(128).fill(0.2)]],
    output = [[new Float32Array(128)]];
  for (let n = 0; n < 375; n++) audio.process(input, output);
  assert.equal(sent.length, 0);
  audio.port.onmessage({ data: { type: "state", muted: false, deafened: false } });
  for (let n = 0; n < 375; n++) audio.process(input, output);
  assert.equal(sent.length, 25);
  assert(sent.every((m) => m.buffer.byteLength === 1280));
  for (let id = 0; id < 15; id++)
    for (let n = 0; n < 30; n++)
      audio.port.onmessage({ data: { type: "pcm", id, buffer: new Int16Array(640).buffer } });
  assert.equal(audio.peers.size, 8);
  assert([...audio.peers.values()].every((p) => p.frames.length <= 6));
  audio.port.onmessage({ data: { type: "peers", ids: [7, 20] } });
  audio.port.onmessage({ data: { type: "pcm", id: 20, buffer: new Int16Array(640).buffer } });
  assert.deepEqual(
    [...audio.peers.keys()],
    [7, 20],
    "departed peers release playback slots for later participants",
  );
  audio.port.onmessage({ data: { type: "state", muted: true, deafened: true } });
  assert.equal(audio.peers.size, 0);
});

test("Team backup includes board/chat attachment bytes and refuses a damaged room archive", async (t) => {
  const f = await fixture(t),
    file = f.rooms.chat.stage(
      f.owner,
      f.room.id,
      "kept.txt",
      "text/plain",
      Buffer.from("keep this room file"),
    );
  f.rooms.put(
    f.owner,
    f.room.id,
    randomUUID(),
    randomUUID(),
    card({ kind: "file", fileId: file.id, title: file.name }),
  );
  const checkpoint = await createTeamSnapshot(f.config, join(f.root, "backups"));
  const exported = join(checkpoint, "space-chat-files", "brainstorm", file.id + ".bin");
  assert.equal(await readFile(exported, "utf8"), "keep this room file");
  await restoreTeamSnapshot(checkpoint, join(f.root, "restored"));
  assert.equal(
    await readFile(
      join(f.root, "restored", "team", "space-chat-files", "brainstorm", file.id + ".bin"),
      "utf8",
    ),
    "keep this room file",
  );
  await writeFile(exported, "damaged");
  await assert.rejects(() => verifyTeamSnapshot(checkpoint));
});

test("Room closure during GPT preparation prevents the native send", async (t) => {
  const f = await fixture(t),
    native = nativeWorkspaceFixture(),
    runtime = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => runtime.close());
  let release, started;
  native.state.preparing = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const prepare = native.client.prepareDispatch;
  native.client.prepareDispatch = async (input) => {
    started();
    return prepare(input);
  };
  const service = new BrainstormGpts(f.owner, f.rooms, runtime),
    key = randomUUID();
  native.workspace.creationKeys.add(key);
  service.send(f.room.id, key, {
    ...native.input,
    nativeId: null,
    text: "Must not dispatch",
    revision: service.get(f.room.id).revision,
  });
  await entered;
  f.rooms.edit(f.owner, f.room.id, randomUUID(), {
    title: "Closed",
    description: "",
    revision: 1,
    closed: true,
  });
  release();
  await until(() => ["failed", "cancelled"].includes(runtime.gpt.job(key).status));
  assert.equal(native.state.sends, 0);
});

test("A conversion review reset binds the exact fingerprint and never resets an uncertain machine operation", async (t) => {
  const f = await fixture(t),
    runtime = await handoffFixture();
  t.after(() => runtime.close());
  const snapshot = f.rooms.snapshot(f.owner, f.room.id, randomUUID(), {
    title: "Project",
    cardIds: [],
    messageIds: [],
    summary: "",
    participants: [],
  });
  const app = Fastify();
  registerBrainstorm(
    app,
    f.rooms,
    f.spaces,
    () => f.owner,
    async () => ({ runtime }),
    () => {},
  );
  t.after(() => app.close());
  const reset = (fingerprint) =>
    app.inject({
      method: "POST",
      url: `/api/team/brainstorm-conversions/${snapshot.id}/reset-review`,
      payload: { fingerprint },
    });
  const row = { inspection: { fingerprint: "exact" } };
  runtime.store.db
    .prepare("INSERT INTO project_setup_operations VALUES(?,?,?,?,?,?)")
    .run(snapshot.id, "pc", "prepared", JSON.stringify(row), 1, 1);
  assert.equal((await reset("wrong")).statusCode, 409);
  runtime.store.db
    .prepare("UPDATE project_setup_operations SET state='unknown' WHERE id=?")
    .run(snapshot.id);
  assert.equal((await reset("exact")).statusCode, 409);
  runtime.store.db
    .prepare("UPDATE project_setup_operations SET state='prepared' WHERE id=?")
    .run(snapshot.id);
  assert.equal((await reset("exact")).statusCode, 200);
  assert.equal(
    runtime.store.db.prepare("SELECT id FROM project_setup_operations WHERE id=?").get(snapshot.id),
    undefined,
  );
});
