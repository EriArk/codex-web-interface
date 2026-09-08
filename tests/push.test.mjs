import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { loadPushKeys, PushService, pushEndpoint } from "../apps/hub/dist/push.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const keys = { publicKey: "A".repeat(87), privateKey: "B".repeat(43) };
const categories = { completed: true, attention: true, errors: true };
const subscription = (name = "device") => ({
  endpoint: "https://web.push.apple.com/" + name,
  keys: { p256dh: "C".repeat(87), auth: "D".repeat(22) },
});
async function fixture(send) {
  const sent = [];
  const f = await handoffFixture(undefined, undefined, {
    push: {
      keys,
      automatic: false,
      send: send ?? (async (sub, payload) => sent.push({ sub, payload: JSON.parse(payload) })),
    },
  });
  const request = (url, method = "GET", payload, headers = f.headers) =>
    f.app.inject({ url, method, payload, headers });
  return {
    ...f,
    sent,
    request,
    subscribe: async (name = "device", prefs = categories) => {
      const r = await request("/api/push", "POST", {
        subscription: subscription(name),
        categories: prefs,
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().id;
    },
    complete: (turn = randomUUID()) => {
      f.store.setStatus(f.thread.id, "completed");
      f.store.append(
        f.thread.id,
        "turn.completed",
        { id: turn, status: "completed", text: "PRIVATE CHAT CONTENT" },
        turn,
      );
      return turn;
    },
  };
}
const deliveries = (f) => f.store.db.prepare("SELECT * FROM push_deliveries ORDER BY rowid").all();
const notices = (f) => f.store.db.prepare("SELECT * FROM push_notices ORDER BY rowid").all();
function job(f, status = "running") {
  const id = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO gpt_jobs(id,fingerprint,nativeId,text,files,model,effort,status,answer,assets,createdAt,updatedAt,error) VALUES(?,?,?,'SECRET PROMPT','[]','m','e',?,'','[]',?,?, '')",
    )
    .run(id, id, "native-" + id, status, Date.now(), Date.now());
  return id;
}
test("push is opt-in, session-bound and rejects untrusted endpoints without exposing device secrets", async () => {
  const f = await fixture();
  try {
    f.complete();
    assert.equal(notices(f).length, 0);
    assert.equal((await f.request("/api/push", "GET", undefined, {})).statusCode, 401);
    assert.equal(
      (
        await f.request(
          "/api/push",
          "POST",
          { subscription: subscription(), categories },
          { cookie: f.headers.cookie, origin: f.headers.origin },
        )
      ).statusCode,
      403,
    );
    for (const endpoint of [
      "http://web.push.apple.com/x",
      "https://127.0.0.1/x",
      "https://web.push.apple.com.attacker.test/x",
      "https://user@web.push.apple.com/x",
      "https://web.push.apple.com:8443/x",
    ]) {
      assert.equal(pushEndpoint(endpoint), false);
      assert.equal(
        (
          await f.request("/api/push", "POST", {
            subscription: { ...subscription(), endpoint },
            categories,
          })
        ).statusCode,
        400,
      );
    }
    const id = await f.subscribe();
    const status = await f.request("/api/push?id=" + id);
    assert.equal(status.json().enabled, true);
    assert.ok(
      !status.body.includes("endpoint") &&
        !status.body.includes("privateKey") &&
        !status.body.includes("CCCC"),
    );
    const other = "other-session";
    f.store.db
      .prepare(
        "INSERT INTO sessions(tokenHash,csrf,expires) SELECT ?,csrf,expires FROM sessions LIMIT 1",
      )
      .run(other);
    f.store.db.prepare("UPDATE push_subscriptions SET owner=? WHERE id=?").run(other, id);
    assert.equal((await f.request("/api/push?id=" + id)).json().enabled, false);
    await f.request("/api/push/" + id, "DELETE");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 1);
    await f.subscribe();
    assert.notEqual(f.store.db.prepare("SELECT owner FROM push_subscriptions").get().owner, other);
    f.store.db.prepare("DELETE FROM sessions").run();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 0);
  } finally {
    await f.close();
  }
});
test("durable Codex completion deduplicates by turn, ignores deltas and opens the original chat", async () => {
  const f = await fixture();
  try {
    await f.subscribe();
    const turn = f.complete();
    f.complete(turn);
    f.store.append(f.thread.id, "assistant.delta", { id: "a", text: "SECRET DELTA" }, turn);
    assert.equal(notices(f).length, 1);
    await f.push.close();
    const recovered = new PushService(
      f.store,
      { keys, automatic: false, send: f.push.send },
      f.headers.origin,
    );
    await recovered.tick();
    await recovered.tick();
    await recovered.close();
    assert.equal(f.sent.length, 1);
    const n = f.sent[0].payload;
    assert.equal(n.body, "Работа завершена");
    assert.ok(!JSON.stringify(n).includes("SECRET") && !JSON.stringify(n).includes(f.thread.id));
    const opened = await f.request("/api/push/open/" + n.id);
    assert.equal(opened.json().threadId, f.thread.id);
    assert.equal(opened.json().projectId, "project");
    assert.equal(f.calls.length, 0, "notification must not acquire a writer");
    assert.equal((await f.request("/api/push/open/" + n.id, "GET", undefined, {})).statusCode, 401);
  } finally {
    await f.close();
  }
});
test("questions, GPT outcomes, queue uncertainty and lost active work use semantic categories", async () => {
  const f = await fixture();
  try {
    await f.subscribe();
    f.store.setStatus(f.thread.id, "waiting_approval");
    f.store.append(
      f.thread.id,
      "approval.requested",
      { id: "q", kind: "question", questions: [{ text: "SECRET" }] },
      "turn-q",
    );
    await f.push.tick();
    assert.equal(f.sent.at(-1).payload.body, "Нужен ответ на вопрос");
    f.store.append(f.thread.id, "approval.requested", { id: "a", kind: "command" }, "turn-q");
    await f.push.tick();
    assert.equal(f.sent.at(-1).payload.body, "Нужно разрешение");
    const id = job(f);
    f.store.db.prepare("UPDATE gpt_jobs SET status='completed' WHERE id=?").run(id);
    f.store.db.prepare("UPDATE gpt_jobs SET status='completed' WHERE id=?").run(id);
    await f.push.tick();
    assert.equal(f.sent.filter((s) => s.payload.title === "GPT").length, 1);
    const opened = (await f.request("/api/push/open/" + f.sent.at(-1).payload.id)).json();
    assert.equal(opened.nativeId, "native-" + id);
    f.store.db
      .prepare("INSERT INTO queue_transfers VALUES(?,?,'{}','preparing')")
      .run(f.thread.id, "queue");
    f.store.db.prepare("UPDATE queue_transfers SET state='enqueue_unknown'").run();
    await f.push.tick();
    assert.equal(f.sent.at(-1).payload.body, "Проверь состояние работы");
    f.store.setStatus(f.thread.id, "running", "active");
    f.store.setStatus(f.thread.id, "unknown");
    await f.push.tick();
    assert.equal(f.sent.length, 5);
    const errorJob = job(f);
    f.store.db.prepare("UPDATE gpt_jobs SET status='failed' WHERE id=?").run(errorJob);
    await f.push.tick();
    assert.equal(f.sent.at(-1).payload.body, "Не удалось завершить работу");
  } finally {
    await f.close();
  }
});
test("foreground leases suppress per device only after a post-event heartbeat; killed clients still receive", async () => {
  const f = await fixture();
  try {
    const id = await f.subscribe(),
      second = await f.subscribe("tablet"),
      tab = randomUUID();
    f.push.foreground(id, tab, "codex", f.thread.id, true);
    f.complete();
    // Deterministically put the event after the previous heartbeat without global fake timers.
    f.store.db.prepare("UPDATE push_notices SET createdAt=?").run(Date.now() + 1);
    await f.push.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(deliveries(f).find((d) => d.subscription === id).state, "pending");
    assert.equal(deliveries(f).find((d) => d.subscription === second).state, "sent");
    f.push.foreground(id, tab, "codex", f.thread.id, false);
    f.store.db.prepare("UPDATE push_deliveries SET nextAt=0").run();
    await f.push.tick();
    assert.equal(f.sent.length, 2);
    f.complete();
    f.store.db.prepare("UPDATE push_notices SET createdAt=createdAt-1 WHERE fanned=0").run();
    f.push.foreground(id, tab, "codex", f.thread.id, true);
    await f.push.tick();
    assert.equal(f.sent.length, 3);
    assert.equal(deliveries(f).filter((d) => d.state === "skipped").length, 1);
  } finally {
    await f.close();
  }
});
test("preferences and stale questions/removed chats are respected, test notification bypasses foreground", async () => {
  const f = await fixture();
  try {
    const id = await f.subscribe("device", { completed: false, attention: true, errors: true });
    f.complete();
    await f.push.tick();
    assert.equal(f.sent.length, 0);
    f.store.append(f.thread.id, "approval.requested", { id: "resolved", kind: "question" }, "q");
    await f.push.tick();
    assert.equal(f.sent.length, 0);
    const j = job(f);
    f.store.db.prepare("UPDATE gpt_jobs SET status='unknown' WHERE id=?").run(j);
    f.store.db.prepare("UPDATE gpt_jobs SET status='completed' WHERE id=?").run(j);
    await f.push.tick();
    assert.equal(f.sent.length, 0);
    await f.subscribe();
    f.complete();
    f.store.db
      .prepare("INSERT INTO library_entities VALUES('codex','thread',?,?)")
      .run(f.thread.id, JSON.stringify({ deleted: true }));
    await f.push.tick();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.request("/api/push/open/" + notices(f).at(-1).id)).statusCode, 404);
    f.push.foreground(id, randomUUID(), "codex", f.thread.id, true);
    const result = await f.request("/api/push/test", "POST", { id });
    assert.equal(result.statusCode, 200);
    await f.push.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].payload.body, "Уведомления работают");
  } finally {
    await f.close();
  }
});
test("delivery errors never replay uncertain pushes, remove expired devices and bound known retries", async () => {
  let failure = { statusCode: 503 },
    count = 0;
  const f = await fixture(async () => {
    count++;
    throw failure;
  });
  try {
    await f.subscribe();
    f.complete();
    await f.push.tick();
    assert.equal(deliveries(f)[0].state, "pending");
    for (let i = 0; i < 4; i++) {
      f.store.db.prepare("UPDATE push_deliveries SET nextAt=0").run();
      await f.push.tick();
    }
    assert.equal(count, 3);
    assert.equal(deliveries(f)[0].state, "unknown");
    failure = new Error("timeout after provider accepted bytes");
    f.complete();
    await f.push.tick();
    await f.push.tick();
    assert.equal(count, 4);
    failure = { statusCode: 410 };
    f.complete();
    await f.push.tick();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 0);
  } finally {
    await f.close();
  }
});
test("a session revoked during delivery cannot send remaining device notifications", async () => {
  let count = 0,
    f;
  f = await fixture(async () => {
    count++;
    f.store.db.prepare("DELETE FROM sessions").run();
  });
  try {
    await f.subscribe();
    await f.subscribe("second");
    f.complete();
    await f.push.tick();
    assert.equal(count, 1);
    assert.equal(deliveries(f).length, 0);
  } finally {
    await f.close();
  }
});
test("push keys survive restart with private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "push-keys-"));
  try {
    const path = join(dir, "push-keys.json"),
      first = loadPushKeys(path);
    assert.deepEqual(loadPushKeys(path), first);
    assert.equal(first.publicKey.length, 87);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("service worker shows only generic notices and opens an authenticated same-origin target", async () => {
  const events = {},
    shown = [],
    messages = [],
    opened = [];
  let focused = 0;
  const self = {
    addEventListener: (name, fn) => (events[name] = fn),
    location: { origin: "https://app.test" },
    registration: { showNotification: async (title, options) => shown.push({ title, ...options }) },
    clients: {
      matchAll: async () => [
        {
          url: "https://evil.test/",
          focus: () => {
            throw Error("external client");
          },
        },
        {
          url: "https://app.test/",
          focus: async () => focused++,
          postMessage: (m) => messages.push(m),
        },
      ],
      openWindow: async (url) => opened.push(url),
    },
  };
  vm.runInNewContext(await readFile(new URL("../apps/web/public/sw.js", import.meta.url), "utf8"), {
    self,
    URL,
    console,
  });
  const id = "a".repeat(32);
  let pending;
  events.push({
    data: {
      json: () => ({ id, title: "GPT", body: "Работа завершена", url: "https://evil.test" }),
    },
    waitUntil: (p) => (pending = p),
  });
  await pending;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].data.id, id);
  events.push({
    data: { json: () => ({ id, title: "GPT", body: "SECRET PROMPT" }) },
    waitUntil: (p) => (pending = p),
  });
  await pending;
  assert.equal(shown.length, 1);
  events.notificationclick({
    notification: { data: { id }, close: () => {} },
    waitUntil: (p) => (pending = p),
  });
  await pending;
  assert.equal(focused, 1);
  assert.equal(messages[0].id, id);
  assert.equal(opened.length, 0);
  self.clients.matchAll = async () => [];
  events.notificationclick({
    notification: { data: { id }, close: () => {} },
    waitUntil: (p) => (pending = p),
  });
  await pending;
  assert.equal(opened[0], "/#notification=" + id);
});
