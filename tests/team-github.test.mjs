import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { TeamBridges } from "../apps/hub/dist/team-bridges.js";
import { TeamGitHub } from "../apps/hub/dist/team-github.js";
import { fixture } from "./team-consultation-fixture.mjs";

async function githubFixture(t) {
  const f = await fixture(t),
    db = f.registry.db;
  db.prepare("UPDATE team_projects SET repository=?,visibility='shared' WHERE id=?").run(
    "https://github.com/Owner/Project",
    f.a,
  );
  db.prepare("UPDATE team_checkouts SET repository=? WHERE projectId=?").run(
    "https://github.com/Owner/Project",
    f.a,
  );
  const join = () => {
    const p = f.projects.detail(f.ownerId, f.a).project;
    const invite = f.projects.invite(f.ownerId, f.a, randomUUID(), {
      login: "friend",
      role: "collaborator",
      revision: p.revision,
    });
    f.projects.answerInvitation(f.friendId, invite.id, randomUUID(), true);
  };
  join();
  db.prepare("DELETE FROM team_checkouts WHERE projectId=?").run(f.b);
  f.projects.bind(
    f.friendId,
    f.a,
    randomUUID(),
    { revision: 0, personalProjectId: "project" },
    { machineId: "pc", repository: "https://github.com/Owner/Project" },
  );
  const calls = [],
    receipts = new Map();
  let behavior = async () => {},
    stamp = "2026-09-13T01:00:00Z";
  const record = () => ({
    type: "pr",
    number: 15,
    title: "Exact PR",
    body: "Shared work",
    truncated: false,
    author: { id: 22, login: "Friend" },
    state: "open",
    url: "https://github.com/Owner/Project/pull/15",
    createdAt: stamp,
    updatedAt: stamp,
    comments: 0,
    assignees: [],
    labels: [],
    head: { branch: "feature", sha: "a".repeat(40), repository: "Owner/Project" },
    base: "main",
  });
  const probe = async (machine, root, req) => {
    const actor =
      root === f.owner.sessions.project("project").workingDirectory ? f.ownerId : f.friendId;
    calls.push({ actor, root, req });
    await behavior(req, actor);
    const snapshot = {
      repository: req.repository,
      repositoryId: 100,
      identity: actor === f.ownerId ? { id: 11, login: "Owner" } : { id: 22, login: "Friend" },
      access: actor === f.ownerId ? "admin" : "write",
      issues: true,
      checkedAt: Date.now(),
    };
    if (req.op === "observe")
      return {
        ...snapshot,
        query: req.query,
        ...(req.query.kind === "detail" ? { record: record() } : {}),
      };
    if (req.op === "prepare") {
      const v = {
        id: req.id,
        input: req.input,
        fingerprint: createHash("sha256").update(req.id).digest("hex"),
        snapshot,
        state: "prepared",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      receipts.set(req.id, v);
      return structuredClone(v);
    }
    const v = receipts.get(req.id);
    if (req.op === "apply") v.state = "completed";
    return structuredClone(v ?? null);
  };
  const rooms = new TeamBridges(f.links);
  let github = new TeamGitHub(f.projects, rooms, f.personal, f.authorize, probe);
  t.after(() => github.close());
  const remove = () => {
    const m = f.projects.detail(f.ownerId, f.a).members.find((m) => m.userId === f.friendId);
    f.projects.member(f.ownerId, f.a, f.friendId, randomUUID(), {
      revision: m.revision,
      role: "collaborator",
      remove: true,
    });
  };
  const prepare = (
    user = f.ownerId,
    input = { kind: "issue-create", title: "Reviewed issue", body: "Selected public summary" },
    extra = {},
  ) => github.prepare(user, f.a, randomUUID(), { input, ...extra });
  return {
    ...f,
    calls,
    rooms,
    receipts,
    join,
    remove,
    prepare,
    record,
    get github() {
      return github;
    },
    behavior: (v) => {
      behavior = v;
    },
    stamp: (v) => {
      stamp = v;
    },
    restart: async () => {
      await github.close();
      github = new TeamGitHub(f.projects, rooms, f.personal, f.authorize, probe);
    },
  };
}

test("GitHub uses each actor's checkout/account; private observations and receipts never cross users", async (t) => {
  const f = await githubFixture(t);
  const a = await f.github.observe(f.ownerId, f.a, { kind: "identity" });
  const b = await f.github.observe(f.friendId, f.a, { kind: "identity" });
  assert.equal(a.value.identity.login, "Owner");
  assert.equal(b.value.identity.login, "Friend");
  assert.throws(() => f.github.observation(f.friendId, f.a, a.id));
  await f.github.observe(f.friendId, f.a, { kind: "identity" });
  assert.equal(f.calls.length, 2, "bounded cache avoids repeated native reads");
  await f.github.confirmIdentity(f.friendId, f.a, b.id, randomUUID());
  assert.equal(f.github.page(f.ownerId, f.a).accounts[0].identity.login, "Friend");
  const p = await f.prepare(f.friendId);
  assert.equal(p.native.snapshot.identity.login, "Friend");
  assert(!JSON.stringify(p).includes("workingDirectory"));
  assert.equal(f.github.page(f.ownerId, f.a).operations.length, 0);
  await assert.rejects(() => f.github.confirm(f.ownerId, f.a, p.id));
  await f.github.confirm(f.friendId, f.a, p.id);
  await f.github.confirm(f.friendId, f.a, p.id);
  assert.equal(f.calls.filter((c) => c.req.op === "apply").length, 1);
  assert.equal(f.count(f.owner) + f.count(f.friend), 0);
});

test("GitHub recipient actions require a project contact and owner rights independent of GitHub access", async (t) => {
  const f = await githubFixture(t);
  await assert.rejects(() =>
    f.prepare(
      f.friendId,
      { kind: "invite", login: "Someone", permission: "push" },
      { memberId: f.ownerId },
    ),
  );
  await assert.rejects(() =>
    f.prepare(
      f.ownerId,
      { kind: "invite", login: "Someone", permission: "push" },
      { memberId: randomUUID() },
    ),
  );
  assert.equal(f.calls.length, 0);
  const p = await f.prepare(
    f.ownerId,
    { kind: "invite", login: "ConfirmedLogin", permission: "pull" },
    { memberId: f.friendId },
  );
  assert.equal(p.memberId, f.friendId);
  assert.equal(p.native.input.login, "ConfirmedLogin");
  f.remove(); // Repository removal must remain possible for a former Hub member.
  await f.prepare(f.ownerId, { kind: "remove", login: "ConfirmedLogin" }, { memberId: f.friendId });
});

test("GitHub revocation/re-add invalidates a prepared write; late acknowledgements stay private", async (t) => {
  const f = await githubFixture(t),
    p = await f.prepare(f.friendId);
  f.remove();
  f.join();
  await assert.rejects(() => f.github.confirm(f.friendId, f.a, p.id));
  assert.equal(f.calls.filter((c) => c.req.op === "apply").length, 0);
  const next = await f.prepare(f.friendId);
  f.behavior(async (req) => {
    if (req.op === "apply") f.remove();
  });
  await assert.rejects(() => f.github.confirm(f.friendId, f.a, next.id));
  assert.equal(
    JSON.parse(
      f.registry.db.prepare("SELECT value FROM team_github_operations WHERE id=?").get(next.id)
        .value,
    ).state,
    "completed",
  );
  assert.throws(() => f.github.page(f.friendId, f.a));
  f.join();
  f.behavior(async () => {});
  assert.equal((await f.github.status(f.friendId, f.a, next.id)).state, "completed");
  assert.equal(f.calls.filter((c) => c.req.op === "apply").length, 1);
});

test("GitHub unknown sends survive restart and block new operation IDs; status does not replay", async (t) => {
  const f = await githubFixture(t),
    p = await f.prepare();
  f.behavior(async (req) => {
    if (req.op === "apply") {
      f.receipts.get(req.id).state = "completed";
      throw Error("lost acknowledgement");
    }
  });
  await assert.rejects(() => f.github.confirm(f.ownerId, f.a, p.id));
  assert.equal(f.github.page(f.ownerId, f.a).operations[0].state, "unknown");
  await f.restart();
  await assert.rejects(() => f.prepare());
  assert.equal((await f.github.confirm(f.ownerId, f.a, p.id)).state, "unknown");
  f.behavior(async () => {});
  assert.equal((await f.github.status(f.ownerId, f.a, p.id)).state, "completed");
  assert.equal(f.calls.filter((c) => c.req.op === "apply").length, 1);
});

test("GitHub review links freeze exact record and create one assigned ordinary Plan without native work", async (t) => {
  const f = await githubFixture(t);
  const o = await f.github.observe(f.friendId, f.a, {
    kind: "detail",
    type: "pr",
    number: 15,
    page: 1,
  });
  const linked = f.github.link(f.friendId, f.a, randomUUID(), { observationId: o.id });
  assert.equal(f.github.page(f.ownerId, f.a).items[0].record.head.sha, "a".repeat(40));
  const key = randomUUID(),
    plan = f.github.work(f.friendId, f.a, linked.id, key, linked.fingerprint);
  assert.equal(plan.assigneeId, f.friendId);
  assert(plan.content.description.includes("a".repeat(40)));
  assert.equal(plan.content.sections[0].items[0].checked, false);
  assert.equal(f.github.work(f.friendId, f.a, linked.id, key, linked.fingerprint).id, plan.id);
  assert.equal(
    f.github.work(f.friendId, f.a, linked.id, randomUUID(), linked.fingerprint).id,
    plan.id,
  );
  assert.equal(f.count(f.owner) + f.count(f.friend), 0);
});

test("GitHub source preview is explicit and scope-bound; failed reads retain the last observation", async (t) => {
  const f = await githubFixture(t),
    id = randomUUID();
  f.projects.put(f.ownerId, f.a, id, randomUUID(), {
    revision: 0,
    assigneeId: null,
    content: { kind: "note", title: "Shared finding", body: "Reviewed public finding" },
  });
  const source = { kind: "material", id };
  assert.equal(f.github.source(f.friendId, f.a, source).text, "Reviewed public finding");
  assert.throws(() => f.github.source(f.friendId, f.b, source));
  const o = await f.github.observe(f.friendId, f.a, { kind: "identity" });
  f.registry.db
    .prepare(
      "UPDATE team_github_observations SET value=json_set(value,'$.value.checkedAt',1) WHERE id=?",
    )
    .run(o.id);
  f.behavior(async () => {
    throw Error("temporary failure");
  });
  await assert.rejects(() => f.github.observe(f.friendId, f.a, { kind: "identity" }));
  assert.equal(f.github.observation(f.friendId, f.a, o.id).value.identity.login, "Friend");
  f.block(true);
  await assert.rejects(() => f.prepare());
});

test("GitHub observations are immutable across refreshes; stale linked snapshots cannot silently become a new Plan", async (t) => {
  const f = await githubFixture(t),
    query = { kind: "detail", type: "pr", number: 15, page: 1 };
  const first = await f.github.observe(f.friendId, f.a, query);
  const linked = f.github.link(f.friendId, f.a, randomUUID(), { observationId: first.id });
  const key = randomUUID(),
    plan = f.github.work(f.friendId, f.a, linked.id, key, linked.fingerprint);
  // Expire only the query cache timestamp to emulate a later independent client refresh.
  f.registry.db
    .prepare(
      "UPDATE team_github_observations SET value=json_set(value,'$.value.checkedAt',1) WHERE id=?",
    )
    .run(first.id);
  f.stamp("2026-09-13T03:00:00Z");
  const next = await f.github.observe(f.friendId, f.a, query);
  assert.notEqual(first.id, next.id);
  assert.equal(
    f.github.observation(f.friendId, f.a, first.id).value.record.updatedAt,
    "2026-09-13T01:00:00Z",
  );
  const latest = f.github.link(f.friendId, f.a, randomUUID(), { observationId: next.id });
  assert.equal(latest.id, linked.id);
  assert.throws(() => f.github.work(f.friendId, f.a, linked.id, randomUUID(), linked.fingerprint));
  assert.equal(
    f.github.work(f.friendId, f.a, linked.id, key, linked.fingerprint).id,
    plan.id,
    "exact old receipt remains retryable",
  );
  const fresh = f.github.work(f.friendId, f.a, latest.id, randomUUID(), latest.fingerprint);
  assert.notEqual(fresh.id, plan.id);
});
