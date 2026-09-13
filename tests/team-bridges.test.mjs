import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Notebook } from "../apps/hub/dist/notebook.js";
import { TeamBridgeRuns } from "../apps/hub/dist/team-bridge-runs.js";
import { TeamBridgeSources } from "../apps/hub/dist/team-bridge-sources.js";
import { TeamBridges } from "../apps/hub/dist/team-bridges.js";
import { attachTeamRelayTools } from "../apps/hub/dist/team-relay-tools.js";
import { fixture } from "./team-consultation-fixture.mjs";

async function bridgeFixture(t, { automatic = true, budget = 3 } = {}) {
  const f = await fixture(t, automatic, 10),
    rooms = new TeamBridges(f.links);
  let runs = new TeamBridgeRuns(rooms, f.service, f.personal, f.authorize);
  t.after(() => runs.close());
  const id = randomUUID();
  rooms.create(f.ownerId, f.a, id, {
    title: "Контракт состояния",
    goal: "Согласовать API движка и игры",
    criteria: "Одинаковые единицы и схема",
    budget,
  });
  const coordinate = async () => {
    await runs.prepare(f.ownerId, id, randomUUID(), rooms.raw(id).revision);
    runs.confirm(f.ownerId, id, runs.view(f.ownerId, id).id, randomUUID());
  };
  const invite = () => {
    rooms.invite(f.ownerId, id, randomUUID(), {
      revision: rooms.raw(id).revision,
      linkId: f.linkId,
    });
    rooms.answer(f.friendId, id, randomUUID(), { revision: rooms.raw(id).revision, accept: true });
  };
  const finish = (extra = {}) => {
    const turnId = f.owner.store.thread(f.owner.thread.id).activeTurnId;
    assert(turnId);
    f.owner.rpc.emit("notification", "item/completed", {
      threadId: f.owner.thread.codexThreadId,
      turnId,
      item: {
        id: randomUUID(),
        type: "agentMessage",
        phase: "final_answer",
        text: JSON.stringify({
          decision: "resolved",
          summary: "PUBLIC_COORDINATOR",
          question: "",
          linkId: "",
          work: [],
          ...extra,
        }),
      },
    });
    f.owner.finishTurn();
  };
  return {
    ...f,
    rooms,
    id,
    get runs() {
      return runs;
    },
    coordinate,
    invite,
    finish,
    restart: async () => {
      await runs.close();
      runs = new TeamBridgeRuns(rooms, f.service, f.personal, f.authorize);
    },
  };
}

test("Bridge history filters before paging; only idle owner can change goal and budget", async (t) => {
  const f = await bridgeFixture(t);
  f.invite();
  const first = randomUUID();
  f.rooms.post(f.ownerId, f.id, first, { kind: "decision", text: "OLD_DECISION" });
  for (let i = 0; i < 40; i++)
    f.rooms.post(f.friendId, f.id, randomUUID(), { kind: "finding", text: `Finding ${i}` });
  assert(!f.rooms.get(f.ownerId, f.id).entries.some((e) => e.text === "OLD_DECISION"));
  assert.equal(f.rooms.get(f.ownerId, f.id, undefined, "decision").entries[0].text, "OLD_DECISION");
  const { title, goal, criteria, revision } = f.rooms.raw(f.id),
    fields = { title, goal, criteria, revision, budget: 5 },
    key = randomUUID();
  assert.throws(() => f.rooms.edit(f.friendId, f.id, key, fields));
  f.rooms.edit(f.ownerId, f.id, key, fields);
  f.rooms.edit(f.ownerId, f.id, key, fields);
  assert.equal(f.rooms.raw(f.id).budget, 5);
  assert.throws(() => f.rooms.edit(f.ownerId, f.id, randomUUID(), fields));
  await f.coordinate();
  assert.throws(() =>
    f.rooms.edit(f.ownerId, f.id, randomUUID(), {
      ...fields,
      revision: f.rooms.raw(f.id).revision,
    }),
  );
});

test("Bridge invitations share only selected room; coordinator quota and native source stay with project owner", async (t) => {
  const f = await bridgeFixture(t);
  assert.throws(() => f.rooms.get(f.friendId, f.id));
  f.rooms.invite(f.ownerId, f.id, randomUUID(), { revision: 1, linkId: f.linkId });
  const invitation = f.rooms.invitations(f.friendId)[0];
  assert.equal(invitation.title, "Контракт состояния");
  assert(!("entries" in invitation));
  f.rooms.answer(f.friendId, f.id, randomUUID(), { revision: invitation.revision, accept: true });
  assert.equal(f.rooms.get(f.friendId, f.id).canCoordinate, false);
  assert.throws(() => f.projects.detail(f.friendId, f.a));
  await assert.rejects(f.runs.prepare(f.friendId, f.id, randomUUID(), f.rooms.raw(f.id).revision));
  f.rooms.post(f.friendId, f.id, randomUUID(), { kind: "finding", text: "PUBLIC_FINDING" });
  await f.coordinate();
  await f.runs.tick();
  assert.equal(f.count(f.owner), 1);
  assert.equal(f.count(f.friend), 0);
  const call = f.owner.calls.find((c) => c.method === "turn/start");
  assert.equal(call.params.approvalPolicy, "never");
  assert.equal(call.params.sandboxPolicy.type, "readOnly");
  assert(!("preview" in f.runs.view(f.friendId, f.id)));
  f.finish();
  await f.runs.tick();
  await f.runs.tick();
  assert.equal(f.rooms.raw(f.id).state, "resolved");
  assert.equal(f.count(f.owner), 1);
  const publicRoom = JSON.stringify(f.rooms.get(f.friendId, f.id));
  assert(publicRoom.includes("PUBLIC_COORDINATOR"));
  assert(!publicRoom.includes(f.owner.thread.id));
  assert(!publicRoom.includes(f.owner.sessions.config.projects[0].workingDirectory));
});

test("Bridge budget counts coordinator plus a single linked answer, with bounded comparison and no nested relays", async (t) => {
  const f = await bridgeFixture(t);
  f.invite();
  await f.coordinate();
  await f.runs.tick();
  attachTeamRelayTools(f.ownerId, f.owner, f.links, f.service, (...args) =>
    f.runs.participating(...args),
  );
  const thread = f.owner.store.thread(f.owner.thread.id);
  const tool = await f.owner.sessions.relayTool(thread, {
    params: {
      tool: "project_relays",
      turnId: thread.activeTurnId,
      callId: "nest",
      arguments: {
        action: "request",
        linkId: f.linkId,
        kind: "consult",
        title: "Новый обход",
        question: "Неограниченный обмен",
      },
    },
  });
  assert.equal(tool.success, false);
  f.finish({ decision: "continue", question: "Какие единицы?", linkId: f.linkId });
  await f.runs.tick();
  await f.runs.tick();
  await f.service.tick();
  assert.equal(f.count(f.friend), 1);
  f.complete(f.friend, "continue", "Метры", "Согласовать?");
  await f.service.tick();
  await f.service.tick();
  assert.equal(
    f.count(f.owner),
    1,
    "one-hop Bridge consult cannot create a separate source evaluation",
  );
  await f.runs.tick();
  await f.runs.tick();
  assert.equal(f.count(f.owner), 2);
  f.finish();
  await f.runs.tick();
  assert.equal(f.runs.view(f.ownerId, f.id).consumed, 3);
  assert.equal(f.rooms.raw(f.id).state, "resolved");
});

test("Bridge budget exhaustion does not consult or restart under a new root; work is an explicit target-assigned Plan", async (t) => {
  const f = await bridgeFixture(t, { budget: 1 });
  f.invite();
  await f.coordinate();
  await f.runs.tick();
  f.finish({
    decision: "continue",
    question: "Нужна ли миграция?",
    linkId: f.linkId,
    work: [{ projectId: f.b, text: "Явно согласовать изменение поля" }],
  });
  await f.runs.tick();
  await f.runs.tick();
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  assert.equal(f.runs.view(f.ownerId, f.id).state, "needs_owner");
  const entry = f.rooms.get(f.friendId, f.id).entries.find((e) => e.kind === "work");
  assert(entry);
  assert.throws(() => f.rooms.workPlan(f.ownerId, f.id, entry.id, randomUUID()));
  const key = randomUUID(),
    p = f.rooms.workPlan(f.friendId, f.id, entry.id, key);
  assert.deepEqual(f.rooms.workPlan(f.friendId, f.id, entry.id, key), p);
  assert.equal(f.projects.get(f.friendId, f.b, p.id).assigneeId, f.friendId);
  assert.equal(f.count(f.friend), 0, "saving a Plan never starts implementation");
});

test("manual consent, stop and revocation prevent late return and automatic coordinator continuation", async (t) => {
  const f = await bridgeFixture(t, { automatic: false });
  f.invite();
  await f.coordinate();
  await f.runs.tick();
  f.finish({ decision: "continue", question: "Формат?", linkId: f.linkId });
  await f.runs.tick();
  await f.runs.tick();
  await f.service.tick();
  assert.equal(f.count(f.friend), 0);
  const c = f.service.page(f.friendId, f.b).items[0];
  f.service.action(f.friendId, f.b, c.id, randomUUID(), {
    revision: c.revision,
    action: "approve",
  });
  await f.service.tick();
  assert.equal(f.count(f.friend), 1);
  f.rooms.action(f.friendId, f.id, randomUUID(), {
    revision: f.rooms.raw(f.id).revision,
    action: "stop",
  });
  f.complete(f.friend, "resolved", "LATE_PRIVATE_REPLY");
  await f.service.tick();
  await f.runs.tick();
  assert(!JSON.stringify(f.rooms.get(f.ownerId, f.id)).includes("LATE_PRIVATE_REPLY"));
  assert.equal(f.count(f.owner), 1);
  f.links.revoke(f.ownerId, f.a, f.linkId, randomUUID(), 2);
  assert.throws(() => f.rooms.get(f.friendId, f.id));
  assert.equal(f.rooms.raw(f.id).state, "stopped");
});

test("dispatch rechecks ownership/current checkout and does not replay unknown sends after restart", async (t) => {
  const f = await bridgeFixture(t);
  await f.coordinate();
  const prepare = f.owner.sessions.attachments.prepare.bind(f.owner.sessions.attachments);
  f.owner.sessions.attachments.prepare = async (...args) => {
    f.rooms.action(f.ownerId, f.id, randomUUID(), {
      revision: f.rooms.raw(f.id).revision,
      action: "stop",
    });
    return prepare(...args);
  };
  await f.runs.tick();
  assert.equal(f.count(f.owner), 0);
  f.owner.sessions.attachments.prepare = prepare;
  f.rooms.action(f.ownerId, f.id, randomUUID(), {
    revision: f.rooms.raw(f.id).revision,
    action: "reopen",
  });
  await f.coordinate();
  const start = f.owner.sessions.startTurn.bind(f.owner.sessions);
  f.owner.sessions.startTurn = async (...args) => {
    await start(...args);
    throw Error("ack lost");
  };
  await f.runs.tick();
  assert.equal(f.count(f.owner), 1);
  assert.equal(f.runs.view(f.ownerId, f.id).state, "unknown");
  await f.restart();
  await f.runs.tick();
  assert.equal(f.count(f.owner), 1);
  f.finish();
  await f.runs.tick();
  assert.equal(f.runs.view(f.ownerId, f.id).state, "resolved");
});

test("changed preview cannot submit; multiple rooms are isolated and old attribution survives access removal", async (t) => {
  const f = await bridgeFixture(t);
  f.invite();
  const run = await f.runs.prepare(f.ownerId, f.id, randomUUID(), f.rooms.raw(f.id).revision);
  f.rooms.post(f.friendId, f.id, randomUUID(), { kind: "question", text: "Новые условия" });
  assert.throws(() => f.runs.confirm(f.ownerId, f.id, run.id, randomUUID()));
  f.rooms.action(f.ownerId, f.id, randomUUID(), {
    revision: f.rooms.raw(f.id).revision,
    action: "stop",
  });
  const another = randomUUID();
  f.rooms.create(f.ownerId, f.a, another, {
    title: "Другая цель",
    goal: "Не смешивать",
    criteria: "Нет данных чужого Bridge",
    budget: 2,
  });
  assert.throws(() => f.rooms.get(f.friendId, another));
  assert(!JSON.stringify(f.rooms.get(f.ownerId, another)).includes("Новые условия"));
  f.links.revoke(f.ownerId, f.a, f.linkId, randomUUID(), 2);
  assert.throws(() =>
    f.rooms.post(f.friendId, f.id, randomUUID(), { kind: "finding", text: "Поздно" }),
  );
  assert(
    f.rooms
      .get(f.ownerId, f.id)
      .entries.some((e) => e.userName === "Друг" && e.text === "Новые условия"),
  );
});

test("selected private finding retains an owner-only immutable source; copied IDs and another room cannot expose it", async (t) => {
  const f = await bridgeFixture(t);
  f.invite();
  const sources = new TeamBridgeSources(f.rooms, f.personal),
    notebook = new Notebook(f.owner.sessions),
    scope = { client: "codex", projectId: "project", name: "Owner" },
    noteId = randomUUID();
  notebook.save(noteId, {
    scope,
    title: "Личный вывод",
    body: "SELECTED_SUMMARY",
    revision: 0,
    links: [],
  });
  const key = randomUUID(),
    input = { scope, kind: "note", id: noteId },
    preview = await sources.prepare(f.ownerId, f.id, key, input);
  const entryId = randomUUID();
  f.rooms.post(f.ownerId, f.id, entryId, {
    kind: "finding",
    text: preview.text,
    sourceId: preview.id,
  });
  notebook.save(noteId, {
    scope,
    title: "Позже изменено",
    body: "NEW_PRIVATE_TEXT",
    revision: 1,
    links: [],
  });
  assert.deepEqual(await sources.prepare(f.ownerId, f.id, key, input), preview);
  const own = sources.entry(f.ownerId, f.id, entryId);
  assert.equal(own.snapshot.content.body, "SELECTED_SUMMARY");
  assert.throws(() => sources.entry(f.friendId, f.id, entryId));
  assert.throws(() =>
    f.rooms.post(f.friendId, f.id, randomUUID(), { kind: "finding", text: "Try", sourceId: key }),
  );
  const shared = f.rooms.get(f.friendId, f.id);
  assert.equal(shared.entries[0].source, "private");
  assert(!JSON.stringify(shared).includes(noteId));
  assert(!JSON.stringify(shared).includes(key));
  assert(!JSON.stringify(shared).includes("NEW_PRIVATE_TEXT"));
  await assert.rejects(sources.prepare(f.friendId, f.id, randomUUID(), input));
});

test("ownership transfer requires idle coordination and explicit adoption by the new project owner", async (t) => {
  const f = await bridgeFixture(t);
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
  await f.coordinate();
  assert.throws(() =>
    f.projects.invite(f.ownerId, f.a, randomUUID(), {
      login: "friend",
      role: "owner",
      revision: 2,
    }),
  );
  f.rooms.action(f.ownerId, f.id, randomUUID(), {
    revision: f.rooms.raw(f.id).revision,
    action: "stop",
  });
  const transfer = f.projects.invite(f.ownerId, f.a, randomUUID(), {
    login: "friend",
    role: "owner",
    revision: 2,
  });
  f.projects.answerInvitation(f.friendId, transfer.id, randomUUID(), true);
  const detail = f.rooms.get(f.friendId, f.id);
  assert.equal(detail.canCoordinate, false);
  assert.equal(detail.canAdopt, true);
  await assert.rejects(f.runs.prepare(f.friendId, f.id, randomUUID(), detail.bridge.revision));
  f.rooms.action(f.friendId, f.id, randomUUID(), {
    revision: detail.bridge.revision,
    action: "adopt",
  });
  assert.equal(f.rooms.get(f.friendId, f.id).canCoordinate, true);
  assert.equal(f.rooms.get(f.ownerId, f.id).canCoordinate, false);
  assert.equal(f.count(f.owner), 0);
  assert.equal(f.count(f.friend), 0);
});

test("Link revocation after coordinator dispatch rejects late consultation without leaving a waiting loop", async (t) => {
  const f = await bridgeFixture(t);
  f.invite();
  await f.coordinate();
  await f.runs.tick();
  f.finish({ decision: "continue", question: "Формат?", linkId: f.linkId });
  await f.runs.tick();
  f.links.revoke(f.ownerId, f.a, f.linkId, randomUUID(), 2);
  await f.runs.tick();
  await f.service.tick();
  assert.equal(f.runs.view(f.ownerId, f.id).state, "needs_owner");
  assert.equal(f.count(f.friend), 0);
});
