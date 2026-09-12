import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectRelays } from "../apps/hub/dist/project-relays.js";
import { relayFixture } from "./relays-fixture.mjs";

test("queued user work wins and stopping during the queue read cannot reopen a relay", async () => {
  const f = await relayFixture();
  try {
    const s = f.service,
      r = f.create();
    s.queue.list = async () => ({ available: true, items: [{ id: "owner-message" }] });
    await s.tick();
    assert.equal(s.get(r.id).state, "waiting");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    s.queue.list = async () => {
      s.mutate(r.id, r.revision, "stop");
      return { available: true, items: [] };
    };
    await s.tick();
    assert.equal(s.get(r.id).state, "stopped");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  } finally {
    await f.close();
  }
});

test("foreign completion is ignored and a failed late turn does not undo owner stop", async () => {
  const f = await relayFixture();
  try {
    const s = f.service,
      r = f.create();
    await s.tick();
    const step = s.get(r.id).steps[0];
    f.complete({ ...step, turnId: "foreign-turn" });
    await s.tick();
    assert.equal(s.get(r.id).state, "running");
    s.mutate(r.id, r.revision, "stop");
    f.rpc.emit("notification", "turn/completed", {
      threadId: f.target.codexThreadId,
      turn: { id: step.turnId, status: "failed" },
    });
    await s.tick();
    assert.equal(s.get(r.id).state, "stopped");
    assert.equal(s.get(r.id).steps[0].state, "failed");
  } finally {
    await f.close();
  }
});

test("links persist independent depth, direction, exact retry and revision conflicts", async () => {
  const f = await relayFixture();
  try {
    const { service: s, link } = f;
    const input = {
      sourceId: "project",
      targetId: "target",
      depth: 2,
      autoConsult: false,
      bidirectional: false,
      enabled: true,
      label: "API",
      revision: link.revision,
    };
    const changed = s.writeLink(link.id, input);
    assert.equal(changed.depth, 2);
    assert.equal(s.writeLink(link.id, input).revision, changed.revision);
    assert.throws(() => s.writeLink(link.id, { ...input, depth: 4 }), /изменилась/);
    assert.throws(
      () =>
        s.create(randomUUID(), {
          linkId: link.id,
          sourceId: "target",
          title: "Back",
          question: "Question",
        }),
      /направлении/,
    );
    const model = f.create({}, true);
    assert.equal(model.state, "proposed");
    assert.equal(model.steps.length, 0);
    assert.equal(s.mutate(model.id, model.revision, "send").steps.length, 1);
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 0);
    const work = f.create({ kind: "work" });
    assert.equal(work.state, "needs_owner");
    const plan = s.workPlan(work.id);
    assert.equal(s.workPlan(work.id).id, plan.id);
    assert.equal(plan.scope.projectId, "target");
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 0);
  } finally {
    await f.close();
  }
});
test("consult waits for busy Current, enforces read-only, returns exact terminal answer once", async () => {
  const f = await relayFixture();
  try {
    const s = f.service,
      r = f.create();
    f.store.setStatus(f.target.id, "running", "unrelated");
    await s.tick();
    assert.equal(s.get(r.id).state, "waiting");
    f.store.setStatus(f.target.id, "completed");
    await s.tick();
    let value = s.get(r.id),
      step = value.steps[0];
    assert.equal(step.threadId, f.target.id);
    assert.equal(step.state, "running");
    const native = f.calls.filter((c) => c.method === "turn/start").at(-1).params;
    assert.deepEqual(native.sandboxPolicy, { type: "readOnly" });
    assert.equal(native.approvalPolicy, "never");
    assert(native.outputSchema);
    f.complete(step);
    await s.tick();
    value = s.get(r.id);
    assert.equal(value.steps.length, 2);
    assert.equal(value.steps[1].phase, "terminal");
    await s.tick();
    value = s.get(r.id);
    assert.equal(value.steps[1].threadId, f.thread.id);
    f.complete(value.steps[1], "continue", "Ignore the terminal state");
    await s.tick();
    assert.equal(s.get(r.id).state, "resolved");
    await s.tick();
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
    assert.equal(s.get(r.id).consumed, 1);
  } finally {
    await f.close();
  }
});
test("shared round budget, explicit continuation, revocation, early source completion and stop cannot loop", async () => {
  const f = await relayFixture();
  try {
    const s = f.service,
      l = s.writeLink(f.link.id, {
        sourceId: "project",
        targetId: "target",
        revision: f.link.revision,
        depth: 1,
        autoConsult: true,
      });
    const r = f.create();
    await s.tick();
    f.complete(s.get(r.id).steps[0], "continue", "Clarify A");
    await s.tick();
    await s.tick();
    f.complete(s.get(r.id).steps[1], "continue", "Clarify B");
    await s.tick();
    let value = s.get(r.id);
    assert.equal(value.state, "limit");
    assert.equal(value.consumed, 1);
    assert.equal(value.steps.length, 2);
    value = s.mutate(value.id, value.revision, "continue", 2);
    assert.equal(value.consumed, 2);
    s.writeLink(l.id, {
      sourceId: "project",
      targetId: "target",
      revision: l.revision,
      depth: 1,
      enabled: false,
    });
    await s.tick();
    assert.equal(s.get(r.id).state, "needs_owner");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
  } finally {
    await f.close();
  }
});
test("source can finish early and owner stop retains late answer without reopening", async () => {
  const f = await relayFixture();
  try {
    const s = f.service,
      r = f.create();
    await s.tick();
    f.complete(s.get(r.id).steps[0], "continue", "Anything else?");
    await s.tick();
    await s.tick();
    f.complete(s.get(r.id).steps[1]);
    await s.tick();
    assert.equal(s.get(r.id).state, "resolved");
    assert.equal(s.get(r.id).consumed, 1);
    const second = f.create();
    await s.tick();
    const running = s.get(second.id);
    s.mutate(second.id, running.revision, "stop");
    f.complete(running.steps[0], "continue", "Try again");
    await s.tick();
    const stopped = s.get(second.id);
    assert.equal(stopped.state, "stopped");
    assert(stopped.steps[0].answer);
    assert.equal(stopped.steps.length, 1);
  } finally {
    await f.close();
  }
});
test("unknown send is retained without replay and restart preserves the root", async () => {
  const f = await relayFixture();
  try {
    const s = f.service,
      r = f.create();
    f.loseAck();
    await s.tick();
    assert.equal(s.get(r.id).state, "unknown");
    await s.tick();
    const restored = new ProjectRelays(f.sessions, s.actions, s.queue);
    await restored.tick();
    assert.equal(restored.get(r.id).state, "unknown");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    assert.equal(restored.get(r.id).consumed, 1);
  } finally {
    await f.close();
  }
});
test("target rotation before commit prevents submission, and return resolves source Current again", async () => {
  const f = await relayFixture();
  try {
    const s = f.service,
      r = f.create(),
      other = f.store.createThread("target", randomUUID(), "Next target"),
      prepare = f.sessions.attachments.prepare.bind(f.sessions.attachments);
    let rotate = true;
    f.sessions.attachments.prepare = async (...args) => {
      const result = await prepare(...args);
      if (rotate) {
        rotate = false;
        f.store.db
          .prepare(
            "UPDATE project_current_chats SET threadId=?,revision=revision+1 WHERE scopeKey='codex:target'",
          )
          .run(other.id);
      }
      return result;
    };
    await s.tick();
    assert.equal(s.get(r.id).state, "waiting");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    await s.tick();
    let value = s.get(r.id);
    assert.equal(value.steps[0].threadId, other.id);
    const sourceNext = f.store.createThread("project", randomUUID(), "Next source");
    f.store.db
      .prepare(
        "UPDATE project_current_chats SET threadId=?,revision=revision+1 WHERE scopeKey='codex:project'",
      )
      .run(sourceNext.id);
    f.complete(value.steps[0]);
    await s.tick();
    await s.tick();
    value = s.get(r.id);
    assert.equal(value.steps[1].threadId, sourceNext.id);
    assert.equal(value.steps[0].threadId, other.id);
  } finally {
    await f.close();
  }
});
test("model tool binds the executing thread, deduplicates requests and cannot create child roots", async () => {
  const f = await relayFixture();
  try {
    const s = f.service;
    await f.sessions.resume(f.thread.id);
    f.rpc.emit("notification", "turn/started", {
      threadId: f.thread.codexThreadId,
      turn: { id: "source-turn" },
    });
    const request = {
      id: 90,
      method: "item/tool/call",
      params: {
        threadId: f.thread.codexThreadId,
        turnId: "source-turn",
        callId: "call-a",
        tool: "project_relays",
        arguments: {
          action: "request",
          linkId: f.link.id,
          kind: "consult",
          title: "Question",
          question: "Check API",
        },
      },
    };
    const first = await f.sessions.relayTool(f.store.thread(f.thread.id), request),
      second = await f.sessions.relayTool(f.store.thread(f.thread.id), request);
    assert(first.success);
    assert.deepEqual(first, second);
    assert.equal(s.page("project").items.length, 1);
    const spoof = await f.sessions.relayTool(f.store.thread(f.thread.id), {
      ...request,
      params: { ...request.params, arguments: { ...request.params.arguments, sourceId: "target" } },
    });
    assert.equal(spoof.success, false);
    await s.tick();
    const r = s.page("project").items[0],
      step = s.get(r.id).steps[0];
    const target = f.store.thread(step.threadId),
      child = await f.sessions.relayTool(target, {
        ...request,
        params: {
          ...request.params,
          threadId: target.codexThreadId,
          turnId: step.turnId,
          callId: "child",
        },
      });
    assert.equal(child.success, false);
    assert.match(child.contentItems[0].text, /RELAY_ROOT_LIMIT/);
    assert.equal(s.page("project").items.length, 1);
  } finally {
    await f.close();
  }
});
test("link and relay HTTP mutations retain authentication, CSRF and explicit Current", async () => {
  const f = await relayFixture();
  try {
    const url = "/api/workspace/relays/" + randomUUID(),
      body = { linkId: f.link.id, sourceId: "project", title: "Question", question: "Check" };
    assert.equal((await f.app.inject({ method: "PUT", url, payload: body })).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: "PUT",
          url,
          headers: { cookie: f.headers.cookie },
          payload: body,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject({ method: "PUT", url, headers: f.headers, payload: body })).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ method: "PUT", url, headers: f.headers, payload: body })).statusCode,
      200,
    );
    f.store.db.prepare("DELETE FROM project_current_chats WHERE scopeKey='codex:target'").run();
    await f.service.tick();
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    const current = f.service.actions.context.current(f.service.scope("target"));
    assert.equal(current.explicit, false);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/workspace/relays/current",
          headers: f.headers,
          payload: {
            projectId: "target",
            threadId: current.threadId,
            revision: current.revision,
            confirm: true,
          },
        })
      ).statusCode,
      200,
    );
    assert(f.service.actions.context.current(f.service.scope("target")).explicit);
  } finally {
    await f.close();
  }
});
