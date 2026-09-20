import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

const until = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out");
};
function setup(t) {
  const f = nativeWorkspaceFixture(),
    root = mkdtempSync(join(tmpdir(), "native-provider-")),
    store = new Store(":memory:");
  const config = configSchema.parse({
    hub: { publicBaseUrl: "https://native.test", databasePath: ":memory:", resultsPath: root },
    auth: {},
    machines: [],
    projects: [],
  });
  const services = [],
    open = () => {
      const s = new GptService(config, store, () => {}, f.workspace);
      services.push(s);
      return s;
    };
  t.after(async () => {
    for (const s of services) await s.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...f, store, config, open };
}
test("legacy unknown chat deletion resumes in background without blocking another send", async (t) => {
  const f = setup(t),
    first = f.open();
  await first.close();
  const id = randomUUID(),
    key = randomUUID();
  f.workspace.conversations.add(id);
  f.store.db
    .prepare("INSERT INTO gpt_native_library VALUES(?,'thread',?,?,'unknown')")
    .run(key, id, JSON.stringify({ action: "delete", confirm: true }));
  let checks = 0;
  f.client.libraryMutation = async (input, checkOnly) => {
    assert.equal(checkOnly, true, "retain the original deletion receipt, never replay it");
    assert.equal(input.key, key);
    assert.equal(input.id, id);
    checks++;
    return { state: "unknown", name: "", projectId: null };
  };
  const service = f.open();
  assert.equal(service.library.get("thread", id).deleted, true);
  assert.equal(service.nativeBlocked(), false);
  assert.equal((await service.connection()).canSend, true);
  assert.ok((await service.models()).models.length);
  await service.deletions.tick(
    () => {},
    () => true,
  );
  assert.equal(checks, 1);
  await service.close();
  const restarted = f.open();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM gpt_deletions").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT receipt FROM gpt_deletions").get().receipt, key);
  assert.equal(restarted.nativeBlocked(), false);
  assert.throws(() => restarted.enqueue(randomUUID(), { ...f.input, nativeId: id }), /удалён/);
  restarted.enqueue(randomUUID(), f.input);
  await until(() => f.state.sends === 1);
});

test("native model catalog stays readable during an unrelated unresolved mutation", async (t) => {
  const f = setup(t),
    service = f.open();
  f.store.db
    .prepare("INSERT INTO gpt_native_library VALUES(?,'thread',?,?,'unknown')")
    .run(randomUUID(), randomUUID(), JSON.stringify({ action: "rename", name: "Renamed" }));
  const status = await service.connection();
  assert.equal(status.canSend, false);
  assert.equal(status.state, "degraded");
  assert.notEqual(status.message, "GPT на связи.");
  assert.ok((await service.models()).models.length, "cold tablet can fetch native choices");
  assert.equal(f.state.sends, 0);
});

test("shared authenticated GPT routes use native catalog, pins, history and per-model presets", async (t) => {
  const native = nativeWorkspaceFixture(),
    f = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => f.close());
  const get = async (path) => {
    const r = await f.app.inject({ url: "/api/gpt/" + path, headers: f.headers });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  assert.equal((await get("models")).effortsByModel.fast[0].id, "0");
  assert.equal((await get("conversations")).items[0].pinned, true);
  assert.equal((await get("projects")).items[0].name, "Native project");
  const unauthenticated = await f.app.inject({ url: "/api/gpt/models" });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(native.state.sends, 0);
});
test("live receipt file links reveal the canonical result and reject another chat's receipt", async (t) => {
  const native = nativeWorkspaceFixture();
  const read = native.workspace.client.conversationGraph;
  native.workspace.client.conversationGraph = async (...args) => {
    const graph = await read(...args);
    graph.mapping[graph.current_node].message.content.parts = [
      "[Report](sandbox:/mnt/data/report.txt)",
    ];
    return graph;
  };
  const f = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => f.close());
  const jobId = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO gpt_jobs VALUES(?,'owner',?,'prompt','[]','latest','1','completed','','[]',1,1,'',NULL,0)",
    )
    .run(jobId, native.conversationId);
  const graph = await read(native.conversationId);
  f.store.db
    .prepare("INSERT INTO gpt_native_receipts(jobId,payload,messages) VALUES(?,'{}',?)")
    .run(jobId, JSON.stringify([{ id: graph.current_node, role: "assistant" }]));
  const reveal = (messageId, source = "sandbox:/mnt/data/report.txt") =>
    f.app.inject({
      method: "POST",
      url: `/api/gpt/conversations/${native.conversationId}/results/reveal`,
      headers: f.headers,
      payload: { source, messageId },
    });
  const canonical = await reveal(graph.current_node),
    live = await reveal(jobId);
  assert.equal(canonical.statusCode, 200, canonical.body);
  assert.equal(live.statusCode, 200, live.body);
  assert.equal(live.json().id, canonical.json().id);
  assert.equal((await reveal(jobId, "sandbox:/mnt/data/other.txt")).statusCode, 404);
  f.store.db.prepare("UPDATE gpt_jobs SET nativeId=? WHERE id=?").run(randomUUID(), jobId);
  assert.equal((await reveal(jobId)).statusCode, 404);
  assert.equal(native.state.sends, 0);
});

test("native queue retains public progress across lost ack and restart without replay", async (t) => {
  const f = setup(t),
    first = f.open(),
    key = randomUUID();
  f.state.loseAck = true;
  first.enqueue(key, f.input);
  await until(() => first.job(key).status === "running" && first.job(key).progress?.length);
  assert.equal(first.job(key).answer, "");
  assert.equal(first.job(key).progress[0].text, "Проверяю вложение");
  await until(() =>
    first.historyCache.peek(f.conversationId).some((m) => m.text === "Проверяю вложение"),
  );
  assert.equal(first.enqueue(key, f.input).id, key);
  assert.equal(f.state.sends, 1);
  await first.close();
  const second = f.open();
  assert.equal(second.job(key).status, "unknown");
  f.state.finished = true;
  await second.pump();
  assert.equal(second.job(key).status, "completed");
  assert.match(second.job(key).answer, /nativeworkspaceok/);
  assert.doesNotMatch(second.job(key).answer, /Проверяю вложение/);
  await until(() =>
    second.historyCache.peek(f.conversationId).some((m) => m.text === "nativeworkspaceok"),
  );
  assert.equal(f.state.sends, 1);
  assert.equal(
    f.store.db.prepare("SELECT provider FROM gpt_job_providers WHERE jobId=?").get(key).provider,
    "native",
  );
});
test("switching providers never dispatches a queued browser message through native", async (t) => {
  const f = setup(t),
    key = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO gpt_jobs VALUES(?,'old',?,'saved','[]','latest','1','queued','','[]',1,1,'',NULL,0)",
    )
    .run(key, f.conversationId);
  const service = f.open();
  await service.pump();
  assert.equal(service.job(key).status, "queued");
  assert.equal(f.state.sends, 0);
  assert.equal(
    f.store.db.prepare("SELECT provider FROM gpt_job_providers WHERE jobId=?").get(key).provider,
    "browser",
  );
  assert.throws(
    () => service.enqueue(randomUUID(), { ...f.input, nativeId: randomUUID() }),
    /ещё не подключено/,
  );
});

test("native reply actions are admitted, and missing canonical source fails without sending", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  f.client.workspace = async () => ({ ready: true, generating: false });
  service.operations.start(key, {
    nativeId: f.conversationId,
    messageId: randomUUID(),
    currentNode: randomUUID(),
    action: "regenerate",
    text: "",
    model: "latest",
    effort: "1",
  });
  await service.operations.close();
  assert.equal(service.operations.get(key).state, "failed");
  assert.equal(service.operations.get(key).provider, "native");
  assert.equal(f.state.sends, 0);
  assert.equal(service.operations.blocked(), false);
});

test("both workspaces use native dictation without the retired browser connector", async (t) => {
  const native = nativeWorkspaceFixture();
  let calls = 0;
  native.workspace.transcribe = async (bytes, signal, mime) => {
    calls++;
    assert.equal(mime, "audio/wav");
    assert.equal(bytes.toString(), "audio");
    signal.throwIfAborted();
    return "Проверка";
  };
  const f = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => f.close());
  assert.equal(
    (await f.app.inject({ url: "/api/dictation/status", headers: f.headers })).json().available,
    true,
  );
  const id = randomUUID();
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/api/dictation/${id}?mime=audio/wav`,
        headers: { ...f.headers, "content-type": "application/octet-stream" },
        payload: Buffer.from("audio"),
      })
    ).statusCode,
    202,
  );
  await until(() => calls === 1);
  const result = await f.app.inject({ url: `/api/dictation/${id}`, headers: f.headers });
  assert.equal(result.json().text, "Проверка");
  assert.equal(native.state.sends, 0);
});
test("cancelling native preparation prevents dispatch after its delayed completion", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  let release;
  f.state.preparing = new Promise((resolve) => {
    release = resolve;
  });
  service.enqueue(key, f.input);
  await until(() => service.job(key).status === "preparing");
  await service.cancel(key);
  release();
  await service.close();
  assert.equal(service.job(key).status, "cancelled");
  assert.equal(f.state.sends, 0);
});
test("native stop is bound to the job and only becomes cancelled after confirmation", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  service.enqueue(key, f.input);
  await until(() => service.job(key).status === "running" && service.job(key).progress?.length);
  await service.cancel(key);
  await service.pump();
  assert.equal(service.job(key).status, "cancelled");
  assert.equal(f.state.sends, 1);
});
test("attachment-only native send preserves an empty prompt without inventing user text", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  const file = await service.put("note.txt", Buffer.from("Attachment only"));
  service.enqueue(key, { ...f.input, text: "", files: [file.id] });
  await until(() => service.job(key).status === "running");
  assert.equal(f.state.input.text, "");
  assert.equal(f.state.input.attachments.length, 1);
  assert.equal(f.state.uploads, 1);
});

test("native chats generate independently while messages in one chat retain their order", async (t) => {
  const f = setup(t),
    other = nativeWorkspaceFixture();
  f.workspace.conversations.add(other.conversationId);
  for (const method of ["prepareDispatch", "dispatchText"]) {
    const original = f.client[method];
    f.client[method] = (r) =>
      r.conversationId === other.conversationId ? other.client[method](r) : original(r);
  }
  const original = f.client.reconcileDispatch;
  let firstReads = 0;
  f.client.reconcileDispatch = (key, id) => {
    if (id === other.conversationId) return other.client.reconcileDispatch(key, id);
    firstReads++;
    return original(key, id);
  };
  const service = f.open(),
    first = randomUUID(),
    second = randomUUID(),
    queued = randomUUID();
  service.enqueue(first, f.input);
  await until(() => service.job(first).status === "running" && f.state.sends === 1);
  await service.pump();
  const beforeSecond = firstReads;
  service.enqueue(second, other.input);
  await until(() => service.job(second).status === "running" && other.state.sends === 1);
  assert.equal(
    firstReads,
    beforeSecond,
    "an independent send does not wait for the other chat's history",
  );
  assert.equal(service.job(first).status, "running");
  service.enqueue(queued, { ...f.input, text: "Next message in first chat" });
  await service.pump();
  assert.equal(service.job(queued).status, "queued");
  assert.equal(f.state.sends, 1);
  await until(() => !service.working);
  f.state.finished = true;
  await service.pump();
  await until(() => f.state.sends === 2);
  assert.equal(service.job(second).status, "running");
});
test("routine native delivery reconciliation is silent; prolonged uncertainty remains actionable", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  const original = f.client.reconcileDispatch;
  f.client.reconcileDispatch = async () => ({
    state: "unknown",
    messages: [],
    userMessageId: f.state.input.userMessageId,
  });
  service.enqueue(key, f.input);
  await until(() => service.job(key).status === "unknown");
  await service.pump();
  assert.equal(service.job(key).error, "");
  f.store.db
    .prepare("UPDATE gpt_native_receipts SET uncertainSince=? WHERE jobId=?")
    .run(Date.now() - 60000, key);
  await service.pump();
  assert.match(service.job(key).error, /доставку/);
  assert.equal(f.state.sends, 1);
  f.client.reconcileDispatch = original;
  await service.pump();
  assert.equal(service.job(key).error, "");
  assert.equal(service.job(key).status, "running");
});

test("a history outage keeps confirmed work running and cached messages readable", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  service.enqueue(key, f.input);
  await until(() => service.job(key).status === "running");
  await until(() => !service.working);
  await service.historyCache.page(f.conversationId, {}, 0);
  f.client.reconcileDispatch = async () => {
    throw Error("NATIVE_RATE_LIMITED");
  };
  f.client.conversationGraph = async () => {
    throw Error("NATIVE_RATE_LIMITED");
  };
  await service.pump();
  assert.equal(service.job(key).status, "running");
  assert.equal(service.job(key).error, "");
  const page = await service.historyCache.page(f.conversationId, {}, 0);
  assert.equal(page.stale, true);
  assert(page.items.length > 0);
  assert.equal(f.state.sends, 1);
  f.client.conversationGraph = async () => {
    throw Error("NATIVE_ACCOUNT_CHANGED");
  };
  await assert.rejects(
    service.historyCache.page(f.conversationId, {}, 0),
    /NATIVE_ACCOUNT_CHANGED/,
  );
});
