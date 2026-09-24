import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CodexSchedules, observeScheduleReceipt } from "../apps/hub/dist/codex-schedules.js";
import { nextScheduleTime, scheduleInstant } from "../apps/hub/dist/schedule-time.js";
import { HubError } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const target = {
  key: "binding",
  projectId: "p",
  name: "P",
  role: "work",
  stamp: "account-machine-checkout",
  revision: 1,
};
const input = {
  text: "Check the build",
  rule: { date: "2026-09-25", time: "10:00", timezone: "UTC", weekdays: [] },
};
const instant = Date.parse("2026-09-25T10:00Z");
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  let now = instant - 60000,
    busy = false,
    denied = false,
    lost = false,
    destination = { threadId: "first", nativeId: "native-first", revision: 1 };
  const sends = [];
  const delivery = {
    resolve() {
      if (denied) throw new HubError(403, "FORBIDDEN", "Revoked");
      return destination;
    },
    async send(_target, run, text, commit) {
      if (busy) throw new HubError(409, "PROJECT_BUSY", "Busy");
      commit(delivery.resolve());
      sends.push({ ...run, text, ...destination });
      if (lost) throw Error("ack lost");
      return { turnId: "turn-" + run.id };
    },
  };
  const service = new CodexSchedules(db, delivery, () => now);
  t.after(async () => {
    await service.close();
    db.close();
  });
  return {
    db,
    service,
    delivery,
    sends,
    advance(v = instant) {
      now = v;
    },
    busy(v) {
      busy = v;
    },
    denied(v) {
      denied = v;
    },
    lost(v) {
      lost = v;
    },
    rotate() {
      destination = { threadId: "second", nativeId: "native-second", revision: 2 };
    },
  };
}
test("one time is durable, exact-key idempotent, fires once after restart before due", async (t) => {
  const f = fixture(t),
    id = randomUUID();
  f.service.create(id, target, input);
  assert.equal(f.service.create(id, target, input).id, id);
  assert.throws(() => f.service.create(id, target, { ...input, text: "Other" }));
  await f.service.tick();
  assert.equal(f.sends.length, 0);
  const restarted = new CodexSchedules(f.db, f.delivery, () => instant);
  await restarted.tick();
  await restarted.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(restarted.list(target).items[0].last.state, "sent");
  await restarted.close();
});
test("recurrence keeps wall time, distinct receipts and bounds downtime catch-up", async (t) => {
  const f = fixture(t);
  f.service.create(randomUUID(), target, {
    ...input,
    rule: { ...input.rule, weekdays: [0, 1, 2, 3, 4, 5, 6] },
  });
  f.advance();
  await f.service.tick();
  f.advance(instant + 5 * 86400000);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.sends.length, 2);
  assert.notEqual(f.sends[0].id, f.sends[1].id);
  assert.equal(f.service.list(target).items[0].nextAt, instant + 6 * 86400000);
});
test("busy preserves order and resolves current destination after rotation", async (t) => {
  const f = fixture(t);
  f.service.create(randomUUID(), target, input);
  f.service.create(randomUUID(), target, { ...input, text: "Second" });
  f.busy(true);
  f.advance();
  await f.service.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(
    f.service.list(target).items.find((x) => x.text === input.text).last.state,
    "waiting",
  );
  f.rotate();
  f.busy(false);
  await f.service.tick();
  await f.service.tick();
  assert.deepEqual(
    f.sends.map((x) => x.text),
    [input.text, "Second"],
  );
  assert.ok(f.sends.every((x) => x.threadId === "second"));
});
test("lost acknowledgement stays unknown across restart, only exact native evidence reconciles", async (t) => {
  const f = fixture(t);
  f.service.create(randomUUID(), target, input);
  f.advance();
  f.lost(true);
  await f.service.tick();
  const run = f.service.list(target).items[0].last;
  assert.equal(run.state, "unknown");
  const restarted = new CodexSchedules(f.db, f.delivery, () => instant + 1000);
  await restarted.tick();
  assert.equal(f.sends.length, 1);
  observeScheduleReceipt(f.db, run.id, "unrelated-native", "bad-turn");
  await restarted.tick();
  assert.equal(restarted.list(target).items[0].last.state, "unknown");
  observeScheduleReceipt(f.db, run.id, run.nativeId, "exact-turn");
  await restarted.tick();
  assert.equal(restarted.list(target).items[0].last.turnId, "exact-turn");
  assert.equal(f.sends.length, 1);
  await restarted.close();
});
test("crash at durable dispatch boundary is not replayed", async (t) => {
  const f = fixture(t),
    s = f.service.create(randomUUID(), target, input),
    run = { id: randomUUID(), dueAt: instant, state: "running", nativeId: "native-first" };
  const saved = JSON.parse(
    f.db.prepare("SELECT value FROM codex_schedules WHERE id=?").get(s.id).value,
  );
  f.db
    .prepare("UPDATE codex_schedules SET value=? WHERE id=?")
    .run(JSON.stringify({ ...saved, last: run }), s.id);
  f.db
    .prepare("INSERT INTO codex_schedule_runs VALUES(?,?,?,?)")
    .run(run.id, s.id, instant, JSON.stringify(run));
  const restarted = new CodexSchedules(f.db, f.delivery, () => instant);
  await restarted.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(restarted.list(target).items[0].last.state, "unknown");
  await restarted.close();
});
test("revoked authorization pauses recurrence; unrelated binding cannot edit", async (t) => {
  const f = fixture(t),
    s = f.service.create(randomUUID(), target, {
      ...input,
      rule: { ...input.rule, weekdays: [5] },
    });
  assert.throws(() => f.service.change(s.id, { ...target, key: "other" }, 1, "cancel"));
  f.denied(true);
  f.advance();
  await f.service.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.service.list(target).items[0].state, "paused");
});
test("edit and cancellation during preparation win before exact send boundary", async (t) => {
  const f = fixture(t),
    s = f.service.create(randomUUID(), target, input);
  let release, entered;
  const gate = new Promise((r) => {
      release = r;
    }),
    started = new Promise((r) => {
      entered = r;
    });
  f.delivery.send = async (_t, _r, _text, commit) => {
    entered();
    await gate;
    commit(f.delivery.resolve());
    f.sends.push("sent");
    return { turnId: "turn" };
  };
  f.advance();
  const tick = f.service.tick();
  await started;
  f.service.change(s.id, target, 1, "cancel");
  release();
  await tick;
  assert.equal(f.sends.length, 0);
  assert.equal(f.service.list(target).items[0].last.state, "cancelled");
  assert.throws(() => f.service.change(s.id, target, 1, "resume"));
});
test("a later due row edited during another send is not overwritten by a stale batch", async (t) => {
  const f = fixture(t),
    other = { ...target, key: "binding2" },
    first = f.service.create(randomUUID(), target, input),
    second = f.service.create(randomUUID(), other, input);
  const original = f.delivery.send;
  f.delivery.send = async (...args) => {
    f.service.change(second.id, other, 1, "cancel");
    return original(...args);
  };
  f.advance();
  await f.service.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.service.list(other).items.find((s) => s.id === second.id).state, "cancelled");
  assert.equal(f.service.list(target).items.find((s) => s.id === first.id).last.state, "sent");
});
test("timezone gaps, folds, leap dates and local daily recurrence", () => {
  assert.equal(scheduleInstant("2026-03-08", "02:30", "America/New_York"), null);
  assert.equal(
    scheduleInstant("2026-11-01", "01:30", "America/New_York"),
    Date.parse("2026-11-01T05:30Z"),
  );
  assert.throws(() => scheduleInstant("2026-02-30", "10:00", "UTC"));
  assert.throws(() => scheduleInstant("2026-01-01", "10:00", "bad/zone"));
  assert.throws(() =>
    nextScheduleTime(
      { date: "2026-03-08", time: "02:30", timezone: "America/New_York", weekdays: [] },
      0,
    ),
  );
  assert.equal(
    nextScheduleTime(
      {
        date: "2026-03-07",
        time: "10:00",
        timezone: "America/New_York",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
      Date.parse("2026-03-07T15:00Z"),
    ),
    Date.parse("2026-03-08T14:00Z"),
  );
});

test("shutdown during preparation retains waiting occurrence for restart", async (t) => {
  const f = fixture(t),
    s = f.service.create(randomUUID(), target, input);
  let release, entered;
  const gate = new Promise((r) => {
      release = r;
    }),
    started = new Promise((r) => {
      entered = r;
    });
  const original = f.delivery.send;
  f.delivery.send = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  f.advance();
  const tick = f.service.tick();
  await started;
  const closing = f.service.close();
  release();
  await tick;
  await closing;
  assert.equal(f.sends.length, 0);
  assert.equal(f.service.list(target).items[0].last.state, "waiting");
  f.delivery.send = original;
  const restarted = new CodexSchedules(f.db, f.delivery, () => instant);
  await restarted.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(restarted.list(target).items[0].id, s.id);
  await restarted.close();
});

test("failed recurring occurrence retains its rule and next independent occurrence", async (t) => {
  const f = fixture(t);
  f.service.create(randomUUID(), target, {
    ...input,
    rule: { ...input.rule, weekdays: [0, 1, 2, 3, 4, 5, 6] },
  });
  const original = f.delivery.send;
  f.delivery.send = async () => {
    throw new HubError(503, "CODEX_UNAVAILABLE", "Offline");
  };
  f.advance();
  await f.service.tick();
  assert.equal(f.service.list(target).items[0].last.state, "failed");
  assert.equal(f.service.list(target).items[0].nextAt, instant + 86400000);
  f.delivery.send = original;
  f.advance(instant + 86400000);
  await f.service.tick();
  assert.equal(f.sends.length, 1);
});

const future = () => {
  const d = new Date(Date.now() + 120000).toISOString();
  return {
    text: "Scheduled exact message",
    rule: { date: d.slice(0, 10), time: d.slice(11, 16), timezone: "UTC", weekdays: [] },
    targetRevision: 0,
  };
};
test("real route follows confirmed Current Chat rotation and uses native send UUID", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const path = `/api/projects/project/schedules/work/${f.thread.id}`,
    payload = future(),
    key = randomUUID();
  const request = () =>
    f.app.inject({
      method: "POST",
      url: path,
      headers: { ...f.headers, "idempotency-key": key },
      payload,
    });
  const created = await request();
  assert.equal(created.statusCode, 200, created.body);
  assert.equal((await request()).statusCode, 200);
  const next = f.store.createThread("project", randomUUID(), "Rotated");
  f.store.db.prepare("UPDATE threads SET origin='desktop' WHERE id=?").run(next.id);
  f.projectWork.context.rotate(
    { client: "codex", projectId: "project", name: "P" },
    f.thread.id,
    next.id,
  );
  f.codexSchedules.now = () => created.json().nextAt;
  await f.codexSchedules.tick();
  const sent = f.calls.filter((c) => c.method === "turn/start");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.threadId, next.codexThreadId);
  const list = await f.app.inject({
    url: `/api/projects/project/schedules/work/${next.id}`,
    headers: f.headers,
  });
  assert.equal(list.json().items[0].last.id, sent[0].params.clientUserMessageId);
  assert.equal(list.json().items[0].last.state, "sent");
});
test("persistent Intake scheduled send stays read-only and excludes hidden worker targets", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const request = f.rpc.request.bind(f.rpc);
  f.rpc.request = (method, p) =>
    method === "thread/start"
      ? Promise.resolve({ thread: { id: randomUUID() } })
      : request(method, p);
  await f.intake.send("project", randomUUID(), { text: "Initial", sources: [], revision: 0 });
  const intake = f.intake.get("project"),
    thread = f.store.thread(intake.threadId);
  f.rpc.emit("notification", "turn/completed", {
    threadId: thread.codexThreadId,
    turn: { id: thread.activeTurnId, status: "completed" },
  });
  const path = `/api/projects/project/schedules/intake/${thread.id}`;
  const created = await f.app.inject({
    method: "POST",
    url: path,
    headers: { ...f.headers, "idempotency-key": randomUUID() },
    payload: { ...future(), targetRevision: intake.revision },
  });
  assert.equal(created.statusCode, 200, created.body);
  f.codexSchedules.now = () => created.json().nextAt;
  await f.codexSchedules.tick();
  const calls = f.calls.filter((c) => c.method === "turn/start");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.threadId, thread.codexThreadId);
  assert.deepEqual(calls[1].params.sandboxPolicy, { type: "readOnly" });
  const list = await f.app.inject({ url: path, headers: f.headers });
  assert.equal(list.json().items[0].last.state, "sent");
  const hidden = await f.app.inject({
    url: `/api/projects/project/schedules/work/${thread.id}`,
    headers: f.headers,
  });
  assert.equal(hidden.statusCode, 409);
});

test("busy bindings cannot starve another project's due occurrence", async (t) => {
  const f = fixture(t),
    original = f.delivery.send;
  for (let n = 0; n < 21; n++)
    f.service.create(
      randomUUID(),
      { ...target, key: "binding-" + String(n).padStart(2, "0") },
      input,
    );
  f.delivery.send = async (selected, ...args) => {
    if (selected.key !== "binding-20") throw new HubError(409, "PROJECT_BUSY", "Busy");
    return original(selected, ...args);
  };
  f.advance();
  await f.service.tick();
  f.advance(instant + 1);
  await f.service.tick();
  assert.equal(f.sends.length, 1);
});

test("real native queue retains precedence over a scheduled message", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const path = `/api/projects/project/schedules/work/${f.thread.id}`;
  const created = await f.app.inject({
    method: "POST",
    url: path,
    headers: { ...f.headers, "idempotency-key": randomUUID() },
    payload: future(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const original = f.rpc.request.bind(f.rpc);
  let queued = true;
  f.rpc.request = (method, params) =>
    method === "thread/queue/list"
      ? Promise.resolve({
          data: queued
            ? [
                {
                  id: "queued",
                  clientUserMessageId: randomUUID(),
                  input: [{ type: "text", text: "earlier" }],
                },
              ]
            : [],
        })
      : original(method, params);
  f.codexSchedules.now = () => created.json().nextAt;
  await f.codexSchedules.tick();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  queued = false;
  await f.codexSchedules.tick();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("execution authority revoked during attachment preparation stops native submission", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const path = `/api/projects/project/schedules/work/${f.thread.id}`;
  const created = await f.app.inject({
    method: "POST",
    url: path,
    headers: { ...f.headers, "idempotency-key": randomUUID() },
    payload: future(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const prepare = f.sessions.attachments.prepare.bind(f.sessions.attachments);
  f.sessions.attachments.prepare = async (...args) => {
    const prepared = await prepare(...args);
    f.sessions.authorizeExecution = () => {
      throw new HubError(403, "REVOKED", "Revoked");
    };
    return prepared;
  };
  f.codexSchedules.now = () => created.json().nextAt;
  await f.codexSchedules.tick();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  const saved = JSON.parse(f.store.db.prepare("SELECT value FROM codex_schedules").get().value);
  assert.equal(saved.last.state, "failed");
  assert.equal(saved.state, "paused");
});

test("deleted current target is not replaced by a similarly named chat", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const path = `/api/projects/project/schedules/work/${f.thread.id}`;
  const created = await f.app.inject({
    method: "POST",
    url: path,
    headers: { ...f.headers, "idempotency-key": randomUUID() },
    payload: future(),
  });
  assert.equal(created.statusCode, 200, created.body);
  f.store.createThread("project", randomUUID(), f.thread.title);
  f.store.db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(f.thread.id);
  f.codexSchedules.now = () => created.json().nextAt;
  await f.codexSchedules.tick();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  const saved = JSON.parse(f.store.db.prepare("SELECT value FROM codex_schedules").get().value);
  assert.equal(saved.state, "paused");
});

test("unknown-send notification opens exact schedule window with a valid notice ID", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const path = `/api/projects/project/schedules/work/${f.thread.id}`;
  const created = await f.app.inject({
    method: "POST",
    url: path,
    headers: { ...f.headers, "idempotency-key": randomUUID() },
    payload: future(),
  });
  assert.equal(created.statusCode, 200, created.body);
  f.loseAck();
  f.codexSchedules.now = () => created.json().nextAt;
  await f.codexSchedules.tick();
  const notice = f.store.db.prepare("SELECT id FROM push_notices WHERE kind='schedule'").get();
  assert.match(notice.id, /^[a-f0-9]{32}$/);
  const opened = await f.app.inject({ url: "/api/push/open/" + notice.id, headers: f.headers });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.deepEqual(opened.json().schedule, {
    projectId: "project",
    threadId: f.thread.id,
    chatRole: "work",
  });
});
