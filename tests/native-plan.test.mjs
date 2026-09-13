import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { nativePlanPrompt } from "../apps/hub/dist/native-plan.js";
import { nativePlanFixture } from "./native-plan-fixture.mjs";

test("native completed Plan uses exact desktop follow-up and default mode once, without consuming pending files", async (t) => {
  const f = await nativePlanFixture();
  t.after(() => f.close());
  const plan = await f.plan();
  const ready = (await f.call()).data.action;
  assert.equal(ready.state, "ready");
  assert.equal(ready.messageId, plan.id);
  const file = await f.sessions.attachments.put(
    f.thread.id,
    "draft.txt",
    Buffer.from("private draft"),
  );
  const before = f.calls.filter((c) => c.method === "turn/start").length;
  const results = await Promise.all([
    f.call("POST", { revision: ready.revision }),
    f.call("POST", { revision: ready.revision }),
  ]);
  assert(
    results.every((r) => r.status === 200),
    JSON.stringify(results),
  );
  assert.equal((await f.call()).data.action.state, "submitted");
  const starts = f.calls.filter((c) => c.method === "turn/start");
  assert.equal(starts.length, before + 1);
  assert.deepEqual(starts.at(-1).params.input, [
    { type: "text", text: nativePlanPrompt(plan.text) },
  ]);
  assert.equal(starts.at(-1).params.collaborationMode.mode, "default");
  assert.equal(starts.at(-1).params.effort, "high");
  assert.equal(starts.at(-1).params.threadId, f.thread.codexThreadId);
  assert.equal(f.sessions.attachments.pending(f.thread.id)[0].id, file.id);
  await f.call("POST", { revision: ready.revision });
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, starts.length);
});

test("Work, failed, interrupted and unknown turns never offer native plan implementation", async (t) => {
  for (const [mode, status] of [
    ["default", "completed"],
    ["plan", "failed"],
    ["plan", "interrupted"],
    ["plan", "unknown"],
  ]) {
    const f = await nativePlanFixture();
    try {
      await f.plan(mode, status);
      assert.equal((await f.call()).data.action, null);
    } finally {
      await f.close();
    }
  }
});

test("native plan rejects stale settings/current chat, changed canonical plan and queued work before any submission", async (t) => {
  const f = await nativePlanFixture();
  t.after(() => f.close());
  await f.plan();
  const ready = (await f.call()).data.action;
  const settings = f.store.threadSettings(f.thread.id);
  f.store.setThreadSettings(f.thread.id, { ...settings, effort: "low" });
  assert.equal((await f.call("POST", { revision: ready.revision })).status, 409);
  f.store.setThreadSettings(f.thread.id, settings);
  f.queue([{ id: randomUUID() }]);
  assert.equal(
    (await f.call("POST", { revision: ready.revision })).data.error.code,
    "NATIVE_PLAN_QUEUE_BUSY",
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM commands WHERE scope LIKE 'native-plan:%'").get().n,
    0,
  );
  f.queue([]);
  const text = f.native().items.at(-1).text;
  f.native().items.at(-1).text = "A changed native plan";
  assert.equal(
    (await f.call("POST", { revision: ready.revision })).data.error.code,
    "NATIVE_PLAN_CHANGED",
  );
  f.native().items.at(-1).text = text;
  f.afterRead(() =>
    f.store.db
      .prepare("INSERT INTO project_current_chats VALUES(?,?,?,?,?)")
      .run(
        "codex:project",
        JSON.stringify({ client: "codex", projectId: "project" }),
        "missing-chat",
        1,
        Date.now(),
      ),
  );
  assert.equal((await f.call("POST", { revision: ready.revision })).status, 409);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(f.store.threadSettings(f.thread.id).mode, "plan");
});

test("lost native acknowledgement reconciles by exact client ID and exact prompt, never replays", async (t) => {
  const f = await nativePlanFixture();
  t.after(() => f.close());
  await f.plan();
  const ready = (await f.call()).data.action;
  f.loseAck();
  assert.equal((await f.call("POST", { revision: ready.revision })).status, 500);
  assert.equal((await f.call()).data.action.state, "unknown");
  await f.call("POST", { revision: ready.revision });
  const message = f.native().items[0],
    content = message.content;
  message.content = [{ type: "text", text: "different message" }];
  assert.equal((await f.call("POST", {}, "/check")).data.action.state, "unknown");
  message.content = content;
  assert.equal((await f.call("POST", {}, "/check")).data.action.state, "submitted");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
  assert.equal(
    f.desktopCalls.filter((c) => c === "ForceRelease").length,
    1,
    "only explicit fixture setup releases desktop",
  );
});

test("plan action cannot cross a thread ID and does not take native ownership for metadata reads", async (t) => {
  const f = await nativePlanFixture();
  t.after(() => f.close());
  await f.plan();
  const other = f.store.createThread("project", randomUUID(), "Other chat");
  const count = f.calls.length;
  const read = await f.app.inject({
    url: `/api/threads/${other.id}/native-plan`,
    headers: f.headers,
  });
  assert.equal(read.json().action, null);
  assert.equal(f.calls.length, count);
});
