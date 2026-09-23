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
import { SpaceActivity } from "../apps/hub/dist/space-activity.js";
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
  return { root, store, registry, team, spaces, owner, friend, stranger, project, input };
}

test("Space activity uses the viewer's checkout, coalesces reads, persists exact references and rechecks revocation", async (t) => {
  const f = await fixture(t),
    s = f.spaces;
  const { id } = s.create(f.owner, randomUUID(), f.input("project"), f.project("altar"));
  s.answer(
    f.friend,
    id,
    randomUUID(),
    { revision: 1, accept: true, access: "direct" },
    f.project("friend-copy"),
  );
  const projectId = s.catalog(f.owner).spaces[0].projects[0].id;
  const calls = [],
    personalCalls = [];
  const sends = new Map();
  const personal = async (actor) => {
    personalCalls.push(actor);
    return {
      runtime: {
        store: f.store,
        projectGpts: {
          get: () => ({ revision: 0, nativeId: "own-project-gpt" }),
          send: (project, key, body, evidence) => {
            if (!sends.has(key)) sends.set(key, { id: key, project, body, evidence });
            return sends.get(key);
          },
        },
        sessions: {
          project: (id) => ({
            id,
            name: id,
            machineId: actor,
            workingDirectory: "/fixture/" + actor,
          }),
          catalog: {
            machine: () => ({
              id: actor,
              type: "local-linux",
              name: "local",
              allowedRoots: ["/fixture"],
            }),
          },
        },
        projectWork: { context: { assertProject() {} } },
      },
    };
  };
  let access = "read",
    repositoryId = 42,
    during;
  let evidenceBody = "Exact patch: + nullable field";
  const source = (kind, n, author) => ({
    kind,
    key: kind + ":" + (kind === "commit" ? String(n).repeat(40) : n),
    title: `${kind} ${n}`,
    author: { id: author, login: "author" + author },
    authorName: "author" + author,
    at: "2026-09-23T10:00:00Z",
    url: `https://github.com/example/altar/${kind === "commit" ? "commit/" + String(n).repeat(40) : "issues/" + n}`,
  });
  const probe = async (machine, root, request) => {
    calls.push({ machine: machine.id, root, request });
    await new Promise((done) => setTimeout(done, 10));
    if (during) {
      const action = during;
      during = null;
      action();
    }
    return {
      repository: "example/altar",
      repositoryId,
      access,
      identity: { id: 7, login: "viewer" },
      checkedAt: Date.now(),
      query: request.query,
      commit:
        request.query.kind === "evidence" && request.query.source.startsWith("commit:")
          ? {
              sha: request.query.source.slice(7),
              message: "Commit",
              parents: [],
              files: [],
              truncated: false,
            }
          : undefined,
      record:
        request.query.kind === "detail"
          ? { type: request.query.type, number: request.query.number }
          : undefined,
      evidence:
        request.query.kind === "evidence"
          ? {
              source: request.query.source,
              text: evidenceBody,
              truncated: false,
            }
          : undefined,
      activity:
        request.query.kind === "activity"
          ? [source("commit", 1, 11), source("commit", 2, 12), source("issue", 3, 11)]
          : undefined,
    };
  };
  let activity = new SpaceActivity(s, personal, probe);
  const [a, b] = await Promise.all([
    activity.page(f.friend, id, projectId),
    activity.page(f.friend, id, projectId),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].machine, f.friend);
  assert(personalCalls.every((v) => v === f.friend));
  assert.equal(a.items.length, 3);
  assert(!JSON.stringify(a).includes("/fixture"));
  activity = new SpaceActivity(s, personal, probe);
  const restored = await activity.page(f.friend, id, projectId);
  assert.deepEqual(restored.items, a.items);
  assert.equal(calls.at(-1).request.query.kind, "identity");
  const opened = await activity.page(f.friend, id, projectId, a.items[0].key);
  assert.equal(opened.items.length, 1);
  assert.equal(
    (await activity.sourceDetails(f.friend, id, projectId, 42, "commit:" + "1".repeat(40), 1))
      .commit.sha,
    "1".repeat(40),
  );
  assert.equal(
    (await activity.sourceDetails(f.friend, id, projectId, 42, "issue:3", 1)).record.number,
    3,
  );
  await assert.rejects(activity.sourceDetails(f.stranger, id, projectId, 42, "issue:3", 1));
  await assert.rejects(activity.sourceDetails(f.friend, id, projectId, 99, "issue:3", 1));
  // Local social state stays attached to exact sources and authorizes every content operation.
  const socialReads = calls.length;
  const [scope, duplicateScope] = await Promise.all([
    activity.socialScope(f.friend, id, projectId, 42, a.items[0].key),
    activity.socialScope(f.friend, id, projectId, 42, a.items[0].key),
  ]);
  assert.deepEqual(scope, duplicateScope);
  assert.equal(calls.length, socialReads + 1);
  const scope2 = await activity.socialScope(f.friend, id, projectId, 42, a.items[1].key);
  const reactionKey = randomUUID();
  s.social.react(f.friend, scope, reactionKey, "like");
  s.social.react(f.friend, scope, reactionKey, "like");
  assert.deepEqual(s.social.summary(f.friend, scope).reactions, [
    { kind: "like", count: 1, mine: true },
  ]);
  assert.equal(s.social.summary(f.friend, scope2).reactions.length, 0);
  assert.equal(s.social.attention(f.owner, id).length, 0, "reactions are silent");
  const replyKey = randomUUID(),
    replyInput = { text: "Check the old saves", recipientId: f.owner };
  const reply = s.social.reply(f.friend, scope, replyKey, replyInput);
  assert.deepEqual(s.social.reply(f.friend, scope, replyKey, replyInput), reply);
  assert.equal(s.social.page(f.friend, scope).replies.length, 1);
  assert.throws(() => s.social.reply(f.friend, scope, replyKey, { text: "changed" }), {
    code: "SHARED_REQUEST_REUSED",
  });
  assert.throws(() =>
    s.social.reply(f.friend, scope2, randomUUID(), { text: "Wrong source", replyTo: reply.seq }),
  );
  assert.throws(() =>
    s.social.reply(f.friend, scope, randomUUID(), {
      text: "Foreign recipient",
      recipientId: f.stranger,
    }),
  );
  assert.equal(s.social.attention(f.owner, id).length, 1);
  assert(!JSON.stringify(s.social.attention(f.owner, id)).includes(replyInput.text));
  assert.throws(() => s.social.notification(f.stranger, id, reply.seq));
  const addressed = s.social.notification(f.owner, id, reply.seq);
  assert.equal(addressed.source.key, scope.source.key);
  const response = s.social.reply(f.owner, scope, randomUUID(), {
    text: "Will check",
    replyTo: reply.seq,
  });
  assert.equal(s.social.attention(f.friend, id)[0].id, response.seq);
  s.social.reply(f.friend, scope, randomUUID(), { text: "Ordinary quiet reply" });
  assert.equal(s.social.attention(f.owner, id).length, 1);
  s.social.markRead(f.owner, scope2, [reply.seq]);
  assert.equal(s.social.attention(f.owner, id).length, 1, "wrong source cannot acknowledge");
  s.social.markRead(f.owner, scope, [reply.seq]);
  assert.equal(s.social.attention(f.owner, id).length, 0);
  for (let i = 0; i < 21; i++)
    s.social.reply(f.friend, scope, randomUUID(), { text: "Reply " + i });
  const latest = s.social.page(f.friend, scope);
  assert.equal(latest.replies.length, 20);
  assert(latest.more);
  const older = s.social.page(f.friend, scope, latest.replies[0].seq);
  assert.equal(older.replies.length, 4);
  assert(!older.more);
  f.team.db.prepare("DELETE FROM space_activity_index").run();
  activity = new SpaceActivity(s, personal, probe);
  assert.equal(
    (await activity.socialScope(f.friend, id, projectId, 42, scope.source.key)).source.key,
    scope.source.key,
    "discussion survives index expiry and service recreation",
  );
  access = "unavailable";
  await assert.rejects(activity.sourceDetails(f.friend, id, projectId, 42, "issue:3", 1));
  await assert.rejects(activity.socialScope(f.friend, id, projectId, 42, scope.source.key));
  access = "read";
  repositoryId = 99;
  await assert.rejects(activity.socialScope(f.friend, id, projectId, 42, scope.source.key));
  repositoryId = 42;
  await activity.page(f.friend, id, projectId);
  const handoffId = randomUUID(),
    sources = a.items.map((v) => v.key);
  const prepared = await activity.prepare(f.friend, id, projectId, handoffId, sources);
  assert.equal(prepared.projectId, "friend-copy");
  assert.equal(prepared.sources, 3);
  assert.equal(sends.size, 0, "preparing discussion must not send");
  await assert.rejects(activity.handoff(f.owner, handoffId));
  const sendKey = randomUUID(),
    body = {
      revision: 0,
      nativeId: "own-project-gpt",
      text: "Explain",
      files: [],
      model: "native-model",
      effort: "0",
    };
  const first = await activity.sendHandoff(f.friend, handoffId, sendKey, body);
  assert.match(first.evidence, /Exact patch/);
  assert.doesNotMatch(first.evidence, /\/fixture/);
  activity = new SpaceActivity(s, personal, probe);
  assert.equal((await activity.sendHandoff(f.friend, handoffId, sendKey, body)).id, first.id);
  assert.equal(sends.size, 1);
  evidenceBody = "Большой патч ".repeat(10000);
  const large = await activity.prepare(f.friend, id, projectId, randomUUID(), sources);
  assert.equal(large.truncated, true);
  const largeSnapshot = JSON.parse(
    String(
      f.team.db.prepare("SELECT data FROM activity_gpt_handoffs WHERE id=?").get(large.id).data,
    ),
  );
  assert(Buffer.byteLength(largeSnapshot.text) < 16384);
  for (const source of sources) assert(largeSnapshot.text.includes(source));
  await assert.rejects(activity.sendHandoff(f.friend, handoffId, randomUUID(), body), {
    code: "ACTIVITY_ALREADY_SENT",
  });
  await assert.rejects(
    activity.sendHandoff(f.friend, handoffId, sendKey, { ...body, revision: 1 }),
    { code: "PROJECT_GPT_CHANGED" },
  );
  await assert.rejects(activity.page(f.stranger, id, projectId), { code: "SPACE_NOT_FOUND" });
  const before = calls.length;
  await assert.rejects(activity.page(f.owner, id, randomUUID()));
  assert.equal(calls.length, before);
  repositoryId = 99;
  await assert.rejects(activity.page(f.friend, id, projectId, a.items[0].key), {
    code: "ACTIVITY_UNAVAILABLE",
  });
  repositoryId = 42;
  access = "unavailable";
  await assert.rejects(activity.sendHandoff(f.friend, handoffId, sendKey, body));
  await assert.rejects(activity.page(f.friend, id, projectId), { code: "ACTIVITY_UNAVAILABLE" });
  assert.equal(f.team.db.prepare("SELECT count(*) AS n FROM space_activity_index").get().n, 0);
  access = "read";
  during = () =>
    s.removeMember(f.owner, id, randomUUID(), {
      revision: s.catalog(f.owner).spaces[0].revision,
      userId: f.friend,
    });
  await assert.rejects(activity.page(f.friend, id, projectId));
  await assert.rejects(activity.socialScope(f.friend, id, projectId, 42, scope.source.key));
  assert.equal(f.team.db.prepare("SELECT count(*) AS n FROM space_activity_index").get().n, 0);
  assert.equal(s.chat.unread(f.owner, id), 0);
});
