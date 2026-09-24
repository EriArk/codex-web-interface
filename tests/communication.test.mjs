import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { CollaborationSpaces } from "../apps/hub/dist/collaboration-spaces.js";
import {
  createTeamSnapshot,
  restoreTeamSnapshot,
  verifyTeamSnapshot,
} from "../apps/hub/dist/team-maintenance.js";
import { communicationFixture } from "./communication-fixture.mjs";

const ok = (response, code = 200) => {
  assert.equal(response.statusCode, code, response.body);
  return response.json();
};
test("DM/group isolation, exact receipts, incremental history, read/mute/leave and private files", async (t) => {
  const f = await communicationFixture();
  t.after(f.close);
  const key = randomUUID(),
    body = { title: "", members: [f.friend] };
  const dm = ok(await f.request(f.headers, "POST", "/api/team/conversations", body, key));
  assert.equal(
    ok(await f.request(f.headers, "POST", "/api/team/conversations", body, key)).id,
    dm.id,
  );
  assert.equal(
    ok(
      await f.request(f.friendHeaders, "POST", "/api/team/conversations", {
        title: "",
        members: [f.owner],
      }),
    ).id,
    dm.id,
  );
  assert.equal(
    (await f.request(f.thirdHeaders, "GET", `/api/team/conversations/${dm.id}`)).statusCode,
    404,
  );
  assert.deepEqual(ok(await f.request(f.thirdHeaders, "GET", "/api/team/conversations")).items, []);
  const path = `/api/team/conversations/${dm.id}/chat`,
    message = { text: "Private text", files: [] },
    sendKey = randomUUID();
  const sent = ok(await f.request(f.headers, "POST", path, message, sendKey));
  assert.equal(ok(await f.request(f.headers, "POST", path, message, sendKey)).seq, sent.seq);
  assert.equal(
    (await f.request(f.headers, "POST", path, { ...message, text: "changed" }, sendKey)).statusCode,
    409,
  );
  const page = ok(await f.request(f.friendHeaders, "GET", path));
  assert.equal(page.messages.length, 1);
  assert.equal(
    ok(await f.request(f.friendHeaders, "GET", `/api/team/conversations/${dm.id}`)).unread,
    1,
  );
  assert.deepEqual(
    ok(await f.request(f.friendHeaders, "GET", path + `?after=${sent.seq}`)).messages,
    [],
  );
  ok(await f.request(f.friendHeaders, "POST", path + "/read", { seq: sent.seq }));
  assert.equal(
    ok(await f.request(f.friendHeaders, "GET", `/api/team/conversations/${dm.id}`)).unread,
    0,
  );
  assert.equal(
    ok(await f.request(f.friendHeaders, "PUT", `/api/team/conversations/${dm.id}`, { muted: true }))
      .muted,
    true,
  );
  const upload = await f.hub.app.inject({
    method: "POST",
    url: path + "/files?name=private.txt&mime=text/plain",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: Buffer.from("original\r\nbytes"),
  });
  const file = ok(upload);
  assert.equal(
    (await f.request(f.friendHeaders, "GET", path + "/files/" + file.id)).statusCode,
    404,
  );
  ok(await f.request(f.headers, "POST", path, { text: "File", files: [file.id] }));
  assert.equal(
    (await f.request(f.friendHeaders, "GET", path + "/files/" + file.id)).body,
    "original\r\nbytes",
  );
  assert.equal(
    (await f.request(f.thirdHeaders, "GET", path + "/files/" + file.id)).statusCode,
    404,
  );
  const mention = ok(
    await f.request(f.headers, "POST", path, { text: "Для тебя", files: [], mentions: [f.friend] }),
  );
  assert.deepEqual(mention.mentions, [{ id: f.friend, name: "Друг" }]);
  assert.equal(
    (
      await f.request(f.headers, "POST", path, {
        text: "wrong audience",
        files: [],
        mentions: [f.third],
      })
    ).statusCode,
    404,
  );
  const fileSource = { client: "human", threadId: dm.id, resultId: file.id };
  const forwarded = ok(
    await f.request(f.headers, "POST", "/api/team/result-snapshots", fileSource),
  );
  assert.equal(forwarded.bytes, Buffer.byteLength("original\r\nbytes"));
  assert.equal(
    (await f.request(f.friendHeaders, "POST", "/api/team/result-snapshots", fileSource)).statusCode,
    404,
  );
  const group = ok(
    await f.request(f.headers, "POST", "/api/team/conversations", {
      title: "Small group",
      members: [f.friend, f.third],
    }),
  );
  assert.equal(group.members.length, 3);
  ok(await f.request(f.friendHeaders, "DELETE", `/api/team/conversations/${dm.id}`));
  assert.equal((await f.request(f.friendHeaders, "GET", path)).statusCode, 404);
  assert.equal(
    (await f.request(f.friendHeaders, "GET", path + "/files/" + file.id)).statusCode,
    404,
  );
  assert.equal(
    (await f.request(f.headers, "POST", "/api/team/conversations", body)).statusCode,
    409,
  );
});

test("Exact Result capture, grants, public-room audience, revocation, retained bytes and backup", async (t) => {
  const f = await communicationFixture();
  t.after(f.close);
  const runtime = f.runtimes.get("owner"),
    thread = runtime.thread.id;
  const artifacts = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.store);
  const data = Buffer.from("<button onclick=\"this.textContent='clicked'\">Try</button>");
  const artifact = artifacts.putFile(
    thread,
    null,
    "interactive.html",
    "C:\\private\\source.html",
    "text/html",
    data,
  );
  const resultId = runtime.store.result(
    thread,
    null,
    "fixture-html",
    "file",
    "interactive.html",
    artifact,
  );
  const source = { client: "codex", threadId: thread, resultId };
  const captureKey = randomUUID(),
    snapshot = ok(
      await f.request(f.headers, "POST", "/api/team/result-snapshots", source, captureKey),
    );
  assert.equal(snapshot.bytes, data.length);
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.equal(
    (await f.request(f.friendHeaders, "POST", "/api/team/result-snapshots", source)).statusCode,
    404,
  );
  const native = randomUUID();
  runtime.gpt.library.save("thread", native, { name: "My GPT" });
  const handoffInput = { snapshotId: snapshot.id, threadId: native },
    handoffKey = randomUUID();
  const handoff = ok(
    await f.request(f.headers, "POST", "/api/team/result-handoffs", handoffInput, handoffKey),
  );
  assert.equal(
    ok(await f.request(f.headers, "POST", "/api/team/result-handoffs", handoffInput, handoffKey))
      .id,
    handoff.id,
  );
  assert.equal(
    (await f.request(f.friendHeaders, "POST", "/api/team/result-handoffs", handoffInput))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.request(f.headers, "POST", "/api/team/result-handoffs", {
        ...handoffInput,
        threadId: randomUUID(),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    ok(await f.request(f.headers, "GET", "/api/team/result-handoffs?threadId=" + native)).items
      .length,
    1,
  );
  const staged = [];
  runtime.gpt.putFile = async (name, bytes, id) => {
    staged.push({ name, bytes, id });
    return { id, name, bytes: bytes.length, mime: "text/html", url: "/api/gpt/uploads/" + id };
  };
  const attachment = ok(
    await f.request(f.headers, "POST", `/api/team/result-handoffs/${handoff.id}/attachment`, {}),
  );
  assert.equal(attachment.sha256, snapshot.sha256);
  assert.deepEqual(staged[0].bytes, data);
  assert.equal(attachment.file.id, handoff.id);
  runtime.store.db
    .prepare(
      "INSERT INTO ai_conversation_bindings VALUES(?,?,'gpt','project',?,'companion','persistent','hidden','null',?,NULL,1)",
    )
    .run(randomUUID(), f.owner, "owner-project", native);
  assert.equal(
    (await f.request(f.headers, "POST", `/api/team/result-handoffs/${handoff.id}/attachment`, {}))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.request(f.headers, "POST", "/api/team/result-handoffs", handoffInput)).statusCode,
    404,
  );
  assert.equal(staged.length, 1);
  const dm = ok(
    await f.request(f.headers, "POST", "/api/team/conversations", {
      title: "",
      members: [f.friend],
    }),
  );
  const input = {
      snapshotId: snapshot.id,
      destination: { kind: "conversation", id: dm.id },
      publicRoom: false,
    },
    key = randomUUID();
  const grant = ok(await f.request(f.headers, "POST", "/api/team/result-shares", input, key));
  assert.equal(
    ok(await f.request(f.headers, "POST", "/api/team/result-shares", input, key)).id,
    grant.id,
  );
  assert.equal(
    (await f.request(f.friendHeaders, "POST", "/api/team/result-shares", input)).statusCode,
    404,
  );
  const history = ok(
    await f.request(f.friendHeaders, "GET", `/api/team/conversations/${dm.id}/chat`),
  );
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].results[0].sha256, snapshot.sha256);
  assert(!JSON.stringify(history).includes(thread));
  assert(!JSON.stringify(history).includes("source.html"));
  const url = `/api/team/result-shares/${grant.id}`;
  assert.equal((await f.request(f.thirdHeaders, "GET", url + "/content")).statusCode, 404);
  assert.equal((await f.request(f.friendHeaders, "GET", url + "/content")).body, data.toString());
  assert.equal((await f.request(f.friendHeaders, "GET", url + "/preview")).statusCode, 403);
  const frame = await f.request(
    { ...f.friendHeaders, "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" },
    "GET",
    url + "/preview",
  );
  assert.equal(frame.statusCode, 200);
  assert.match(frame.headers["content-security-policy"], /sandbox allow-scripts/);
  assert.match(frame.headers["content-security-policy"], /connect-src 'none'/);
  const room = ok(
    await f.request(f.headers, "POST", "/api/team/brainstorm", {
      title: "Public room",
      description: "",
    }),
  );
  const publicInput = { ...input, destination: { kind: "brainstorm", id: room.id } };
  assert.equal(
    (await f.request(f.headers, "POST", "/api/team/result-shares", publicInput)).statusCode,
    409,
  );
  const second = ok(
    await f.request(f.headers, "POST", "/api/team/result-shares", {
      ...publicInput,
      publicRoom: true,
    }),
  );
  assert.equal(
    (await f.request(f.thirdHeaders, "GET", `/api/team/result-shares/${second.id}/content`)).body,
    data.toString(),
  );
  ok(await f.request(f.headers, "DELETE", url));
  assert.equal((await f.request(f.friendHeaders, "GET", url + "/content")).statusCode, 410);
  assert.equal(
    (await f.request(f.thirdHeaders, "GET", `/api/team/result-shares/${second.id}/content`))
      .statusCode,
    200,
  );
  runtime.store.db.prepare("DELETE FROM results WHERE id=?").run(resultId);
  assert.equal(
    ok(await f.request(f.headers, "POST", "/api/team/result-snapshots", source, captureKey)).id,
    snapshot.id,
  );
  assert.equal(
    (await f.request(f.friendHeaders, "GET", `/api/team/result-shares/${second.id}/content`)).body,
    data.toString(),
  );
  const path = await createTeamSnapshot(f.config, join(f.root, "backups"));
  await verifyTeamSnapshot(path);
  const frozen = join(path, "space-chat-files", "shared_result", snapshot.id + ".bin");
  assert.deepEqual(await readFile(frozen), data);
  const restored = join(f.root, "restored");
  await restoreTeamSnapshot(path, restored);
  assert.deepEqual(
    await readFile(
      join(restored, "team", "space-chat-files", "shared_result", snapshot.id + ".bin"),
    ),
    data,
  );
  await writeFile(frozen, "changed");
  await assert.rejects(verifyTeamSnapshot(path));
});

test("one-tap direct conversations reuse identity; explicitly named two-person groups stay separate", async (t) => {
  const f = await communicationFixture();
  t.after(f.close);
  const dm = ok(
    await f.request(f.headers, "POST", "/api/team/conversations", {
      kind: "direct",
      title: "",
      members: [f.friend],
    }),
  );
  const again = ok(
    await f.request(f.headers, "POST", "/api/team/conversations", {
      kind: "direct",
      title: "",
      members: [f.friend],
    }),
  );
  assert.equal(again.id, dm.id);
  const group = ok(
    await f.request(f.headers, "POST", "/api/team/conversations", {
      kind: "group",
      title: "Наш проект",
      members: [f.friend],
    }),
  );
  assert.notEqual(group.id, dm.id);
  assert.equal(group.kind, "group");
  assert.equal(group.title, "Наш проект");
  assert.equal(
    (
      await f.request(f.headers, "POST", "/api/team/conversations", {
        kind: "group",
        title: "",
        members: [f.friend],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.request(f.headers, "POST", "/api/team/conversations", {
        kind: "direct",
        title: "",
        members: [f.friend, f.third],
      })
    ).statusCode,
    400,
  );
  ok(
    await f.request(f.headers, "POST", `/api/team/conversations/${dm.id}/chat`, {
      text: "Latest\nmessage",
      files: [],
    }),
  );
  assert.equal(
    ok(await f.request(f.headers, "GET", `/api/team/conversations/${dm.id}`)).preview,
    "Вы: Latest message",
  );
  assert.equal(
    ok(await f.request(f.friendHeaders, "GET", `/api/team/conversations/${dm.id}`)).preview,
    "Latest message",
  );
  assert.equal(
    (await f.request(f.thirdHeaders, "GET", `/api/team/conversations/${dm.id}`)).statusCode,
    404,
  );
});

test("Activity projects only explicitly shared Space results and drops revoked materials", async (t) => {
  const f = await communicationFixture();
  t.after(f.close);
  const spaces = new CollaborationSpaces(f.hub.teamProjects);
  const { id } = spaces.create(
    f.owner,
    randomUUID(),
    {
      title: "Shared",
      kind: "project",
      userId: f.friend,
      personalProjectId: "owner-project",
      access: "collaborate",
      requestedAccess: "collaborate",
    },
    {
      personalProjectId: "owner-project",
      name: "Project",
      repository: "https://github.com/example/project",
    },
  );
  spaces.answer(
    f.friend,
    id,
    randomUUID(),
    { revision: 1, accept: true },
    {
      personalProjectId: "friend-project",
      name: "Copy",
      repository: "https://github.com/example/project",
    },
  );
  const runtime = f.runtimes.get("owner"),
    thread = runtime.thread.id;
  const artifacts = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.store);
  const artifact = artifacts.putFile(
    thread,
    null,
    "Shared.md",
    "C:privatesource.md",
    "text/markdown",
    Buffer.from("Published content"),
  );
  const resultId = runtime.store.result(
    thread,
    null,
    "private-result",
    "file",
    "Shared.md",
    artifact,
  );
  const path = `/api/team/spaces/${id}/activity/local`;
  const list = async (headers = f.friendHeaders) => ok(await f.request(headers, "GET", path)).items;
  assert(!(await list()).some((v) => v.kind === "result"));
  const snapshot = ok(
    await f.request(f.headers, "POST", "/api/team/result-snapshots", {
      client: "codex",
      threadId: thread,
      resultId,
    }),
  );
  assert(!(await list()).some((v) => v.kind === "result"), "capture alone is private");
  const input = { snapshotId: snapshot.id, destination: { kind: "space", id }, publicRoom: false },
    key = randomUUID();
  const grant = ok(await f.request(f.headers, "POST", "/api/team/result-shares", input, key));
  ok(await f.request(f.headers, "POST", "/api/team/result-shares", input, key));
  const result = (await list()).filter((v) => v.kind === "result");
  assert.equal(result.length, 1);
  assert.equal(result[0].result.id, grant.id);
  assert.equal(JSON.stringify(result).includes("source.md"), false);
  assert.equal((await f.request(f.thirdHeaders, "GET", path)).statusCode, 404);
  ok(await f.request(f.headers, "DELETE", `/api/team/result-shares/${grant.id}`));
  assert(!(await list()).some((v) => v.kind === "result"));
  assert.equal(
    (await f.request(f.friendHeaders, "GET", `/api/team/result-shares/${grant.id}/content`))
      .statusCode,
    410,
  );
});
