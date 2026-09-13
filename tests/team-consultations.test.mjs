import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamConsultations } from "../apps/hub/dist/team-consultations.js";
import { TeamLinks } from "../apps/hub/dist/team-links.js";
import { TeamProjects } from "../apps/hub/dist/team-projects.js";
import { attachTeamRelayTools } from "../apps/hub/dist/team-relay-tools.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import { settings } from "./handoff-fixture.mjs";
import { fixture } from "./team-consultation-fixture.mjs";

test("quick revoke/re-add does not resurrect consultation permission between background polls", async (t) => {
  const f = await fixture(t);
  f.projects.edit(f.ownerId, f.a, randomUUID(), {
    revision: 1,
    title: "Engine",
    visibility: "shared",
    archived: false,
  });
  const invite = f.projects.invite(f.ownerId, f.a, randomUUID(), {
    login: "friend",
    role: "collaborator",
    revision: 2,
  });
  f.projects.answerInvitation(f.friendId, invite.id, randomUUID(), true);
  const v = f.service.create(f.friendId, randomUUID(), {
    linkId: f.linkId,
    projectId: f.a,
    title: "Вопрос",
    question: "Публичный интерфейс",
    kind: "consult",
  });
  f.projects.member(f.ownerId, f.a, f.friendId, randomUUID(), {
    revision: 1,
    role: "viewer",
    remove: true,
  });
  const back = f.projects.invite(f.ownerId, f.a, randomUUID(), {
    login: "friend",
    role: "collaborator",
    revision: 2,
  });
  f.projects.answerInvitation(f.friendId, back.id, randomUUID(), true);
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  assert.equal(f.service.get(f.ownerId, f.a, v.id).state, "stopped");
  f.registry.disable(f.ownerId, f.friendId, true);
  f.registry.disable(f.ownerId, f.friendId, false);
  assert.equal(f.links.raw(f.linkId).state, "revoked");
  assert.throws(() => f.create());
});

test("two-account consultation uses target owner read-only policy; early resolution sends no extra message", async (t) => {
  const f = await fixture(t),
    v = f.create();
  await f.service.tick();
  assert.equal(f.count(f.owner), 0);
  assert.equal(f.count(f.friend), 1);
  const native = f.friend.calls.find((c) => c.method === "turn/start").params;
  assert.equal(native.approvalPolicy, "never");
  assert.equal(native.sandboxPolicy.type, "readOnly");
  assert(native.outputSchema);
  assert.throws(() => f.projects.detail(f.ownerId, f.b));
  const active = f.service.get(f.ownerId, f.a, v.id);
  assert(!JSON.stringify(active).includes(f.friend.thread.id));
  assert(!JSON.stringify(active).includes(f.friend.sessions.config.projects[0].workingDirectory));
  f.complete(f.friend);
  await f.service.tick();
  await f.service.tick();
  const done = f.service.get(f.ownerId, f.a, v.id);
  assert.equal(done.state, "resolved");
  assert.equal(done.steps[0].answer, "PUBLIC_ANSWER");
  assert.equal(f.count(f.owner), 0);
  assert.equal(f.count(f.friend), 1);
});

test("manual Link requires each owner's consent; linked project membership never spends another owner's quota", async (t) => {
  const f = await fixture(t, false),
    v = f.create();
  assert.equal(v.state, "proposed");
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  assert.throws(() =>
    f.service.action(f.ownerId, f.b, v.id, randomUUID(), {
      revision: v.revision,
      action: "approve",
    }),
  );
  f.service.action(f.friendId, f.b, v.id, randomUUID(), {
    revision: v.revision,
    action: "approve",
  });
  await f.service.tick();
  assert.equal(f.count(f.friend), 1);
  f.complete(f.friend);
  await f.service.tick();
});

test("busy queue stays on Hub; revocation before native commit prevents sending", async (t) => {
  const f = await fixture(t),
    v = f.create();
  const list = f.friend.projectWork.queue.list.bind(f.friend.projectWork.queue);
  f.friend.projectWork.queue.list = async () => ({ available: true, items: [{ id: "own-work" }] });
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  assert.equal(f.service.get(f.ownerId, f.a, v.id).state, "waiting");
  f.friend.projectWork.queue.list = list;
  const prepare = f.friend.sessions.attachments.prepare.bind(f.friend.sessions.attachments);
  f.friend.sessions.attachments.prepare = async (...args) => {
    f.links.revoke(f.friendId, f.b, f.linkId, randomUUID(), 2);
    return prepare(...args);
  };
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  assert.equal(
    f.friend.store.db.prepare("SELECT count(*) n FROM messages WHERE role='user'").get().n,
    0,
  );
});

test("revocation and stop suppress late private answers without interrupting or replaying a native turn", async (t) => {
  const f = await fixture(t),
    v = f.create();
  await f.service.tick();
  f.links.revoke(f.friendId, f.b, f.linkId, randomUUID(), 2);
  f.complete(f.friend, "resolved", "LATE_PRIVATE_SECRET");
  await f.service.tick();
  const value = f.service.get(f.ownerId, f.a, v.id);
  assert.equal(value.state, "stopped");
  assert.equal(value.steps[0].answer, undefined);
  assert(!JSON.stringify(value).includes("LATE_PRIVATE_SECRET"));
  assert.equal(f.friend.calls.filter((c) => c.method === "turn/interrupt").length, 0);
  assert(
    f.friend.store.db
      .prepare("SELECT 1 FROM messages WHERE text LIKE '%LATE_PRIVATE_SECRET%'")
      .get(),
  );
});

test("depth is bounded across both accounts; model cannot reset the originating turn's budget", async (t) => {
  const f = await fixture(t, true, 1),
    origin = { threadId: randomUUID(), turnId: "origin-turn" },
    v = f.create({}, origin);
  assert.throws(
    () => f.create({}, origin),
    (e) => e.code === "TEAM_CONSULT_ROOT_LIMIT",
  );
  await f.service.tick();
  f.complete(f.friend, "continue", "Ответ", "Уточни требования");
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.count(f.owner), 1);
  f.complete(f.owner, "continue", "Нужны детали", "Ещё один вопрос");
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.service.get(f.ownerId, f.a, v.id).state, "limit");
  assert.equal(f.count(f.friend), 1);
  await f.restart();
  assert.throws(
    () => f.create({}, origin),
    (e) => e.code === "TEAM_CONSULT_ROOT_LIMIT",
  );
});

test("lost native acknowledgement stays unknown across restart; disabled identity has no fallback", async (t) => {
  const f = await fixture(t),
    v = f.create();
  f.friend.loseAck();
  await f.service.tick();
  assert.equal(f.service.get(f.ownerId, f.a, v.id).state, "unknown");
  await f.restart();
  await f.service.tick();
  assert.equal(f.count(f.friend), 1);
  f.registry.db.prepare("UPDATE team_users SET state='disabled' WHERE id=?").run(f.friendId);
  await f.service.tick();
  assert.equal(f.count(f.owner), 0);
  assert.equal(f.count(f.friend), 1);
  assert.equal(f.service.get(f.ownerId, f.a, v.id).state, "unknown");
});

test("work proposals only save a target-assigned Plan; maintenance freezes consultations", async (t) => {
  const f = await fixture(t),
    v = f.create({ kind: "work" });
  assert.throws(() => f.service.workPlan(f.ownerId, f.a, v.id, randomUUID()));
  const key = randomUUID(),
    plan = f.service.workPlan(f.friendId, f.b, v.id, key);
  assert.equal(plan.assigneeId, f.friendId);
  assert.equal(plan.kind, "plan");
  assert.equal(f.service.workPlan(f.friendId, f.b, v.id, key).id, plan.id);
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  f.create();
  f.block(true);
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  f.block(false);
  await f.service.tick();
  assert.equal(f.count(f.friend), 1);
  f.complete(f.friend);
  await f.service.tick();
});

test("native tools list accepted related projects only and block recursive consultations", async (t) => {
  const f = await fixture(t),
    v = f.create();
  attachTeamRelayTools(f.friendId, f.friend, f.links, f.service);
  await f.service.tick();
  const thread = f.friend.store.thread(f.friend.thread.id),
    request = (args) =>
      f.friend.sessions.relayTool(thread, {
        params: {
          tool: "project_relays",
          turnId: thread.activeTurnId,
          callId: randomUUID(),
          arguments: args,
        },
      });
  const listed = await request({ action: "list" });
  const entries = JSON.parse(listed.contentItems[0].text);
  assert.equal(entries.find((x) => x.id === f.linkId).project, "Engine");
  assert(!JSON.stringify(entries).includes(f.owner.thread.id));
  const refused = await request({
    action: "request",
    linkId: f.linkId,
    kind: "consult",
    title: "Новый",
    question: "Сбросить глубину",
  });
  assert.equal(refused.success, false);
  assert.match(refused.contentItems[0].text, /TEAM_CONSULT_ROOT_LIMIT/);
  f.complete(f.friend);
  await f.service.tick();
  assert.equal(f.service.get(f.ownerId, f.a, v.id).state, "resolved");
});
