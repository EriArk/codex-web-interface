import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NativeGptJobs } from "../apps/hub/dist/gpt-native-jobs.js";
import { NativeDispatchReceipts } from "../ops/gpt-native/dispatch-receipts.mjs";
import { nativeDispatch } from "../ops/gpt-native/renderer-dispatch.mjs";
import { nativeLive } from "../ops/gpt-native/renderer-live.mjs";
import { nativeActivity } from "../ops/gpt-native/public-activity.mjs";
import { NativeReadService } from "../ops/gpt-native/service.mjs";

const conversationId = randomUUID(),
  userId = randomUUID(),
  parentId = randomUUID();
const principal = {
  accountId: "account",
  userId: "native-user",
  authenticatedUserId: "native-user",
};
const accountFingerprint = createHash("sha256")
  .update(JSON.stringify(Object.values(principal)))
  .digest("hex");
function fixture(creating = false) {
  const input = {
    operation: "dispatchText",
    key: randomUUID(),
    conversationId: creating ? null : conversationId,
    userMessageId: randomUUID(),
    text: "  exact text\n",
    model: "model",
    effort: "standard",
    parentId,
    intentPersisted: true,
    accountFingerprint,
  };
  const runtime = { crypto: webcrypto };
  const state = { send: 0, post: 0, change: false, retry: false, badBody: false };
  const values = new Map([
    ["account", principal],
    ["node", creating ? null : parentId],
    ["status", "idle"],
    ["selected", { slug: "model", thinkingEffort: "standard" }],
    ["hints", []],
  ]);
  const scope = {
    value: creating ? { routeKind: "home" } : { routeKind: "chatgpt-thread", conversationId },
    get: (token) => (token === "service" ? service : values.get(token)),
  };
  const original = () => ({});
  const registry = new Map([["app.get_summary", original]]);
  const service = {
    createCompletionStreamHandlers: (args) => {
      assert.equal(args.shouldAttemptResume(), false);
      state.emit = args.onUpdate;
      return {};
    },
    startCompletionStream(args) {
      this.createCompletionStreamHandlers({
        shouldAttemptResume: () => true,
        onUpdate: () => {
          state.forwarded = (state.forwarded ?? 0) + 1;
        },
      });
      assert.deepEqual(args.expectedIdentity, { accountId: "account", userId: "native-user" });
      if (state.change) values.set("account", { accountId: "other", userId: "other" });
      args.assertRequestCurrent();
      state.post++;
      if (state.retry) assert.throws(() => args.assertRequestCurrent(), /REPLAY_BLOCKED/);
      return {};
    },
  };
  const m = {
    dWt: "account",
    eWt: (x) => x,
    lzt: "nativeId",
    gzt: "node",
    Nzt: "status",
    NNt: "pending",
    Pzt: "staging",
    VNt: "selected",
    hzt: "origin",
    UNt: "hints",
    CUt: "service",
    M9: {
      accessInputs: { readAccountInfo: async () => ({ status: "ready", data: principal }) },
      appActions: {
        runInPrimaryWindow: async () => registry.get("app.get_summary")({}, { scope }),
      },
    },
    lDt: ({ prompt }) => ({
      message: {
        id: "generated",
        author: { role: "user" },
        content: { content_type: "text", parts: [prompt.trim()] },
      },
    }),
    mDt: async (s, args) => {
      state.submissionCurrent = args.isSubmissionCurrent;
      state.send++;
      assert.equal(args.userCompletionMessages.message.id, input.userMessageId);
      assert.equal(args.isSubmissionCurrent(), true);
      const request = {
        ...(creating ? {} : { conversation_id: conversationId }),
        parent_message_id: parentId,
        model: input.model,
        thinking_effort: input.effort,
        messages: [args.userCompletionMessages.message],
      };
      if (state.badBody) request.model = "other";
      await s.get("service").startCompletionStream({ request });
      if (creating) {
        assert.equal(args.conversationId, `local-chatgpt:${input.userMessageId}`);
        assert.equal(args.projectId, null);
        assert.equal(args.conversationOrigin, null);
        args.onServerThreadIdChange(conversationId);
        values.set("nativeId", conversationId);
      }
      args.onCompletion("completed");
      return { serverConversationId: conversationId };
    },
  };
  const read = async (r) =>
    r.operation === "inspectAccount"
      ? { accountFingerprint }
      : { currentNode: parentId, messages: [] };
  const ui = { selected: true, composerReady: true, hasDraft: false, stopAvailable: false };
  const run = (r = {}) =>
    nativeDispatch(
      { ...input, ...r },
      read,
      async () => ui,
      async () => m,
      runtime,
      async () => ({ appActionRegistry: registry }),
      nativeActivity,
    );
  return { run, input, state, scope, values, registry, original, ui, runtime, read };
}

test("native live text follows decoded updates, isolates chats/accounts and never changes delivery", async () => {
  const f = fixture();
  await f.run();
  const id = randomUUID();
  const emit = (text, extra = {}, chat = conversationId) =>
    f.state.emit({
      type: "message",
      conversationId: chat,
      message: {
        id,
        author: { role: "assistant" },
        channel: "final",
        recipient: "all",
        content: { content_type: "text", parts: [text] },
        ...extra,
      },
    });
  const read = () => nativeLive(f.input, f.read, f.runtime);
  assert.equal(
    (await read()).finished,
    true,
    "native completion wakes reconciliation independently of text",
  );
  emit("First");
  assert.equal((await read()).items[0].text, "First");
  emit("First second");
  assert.equal((await read()).items[0].text, "First second");
  assert.equal((await read()).items.length, 1);
  emit("secret", { channel: "analysis" });
  emit("secret", { recipient: "tool" });
  emit("secret", { metadata: { is_visually_hidden_from_conversation: true } });
  emit("secret", { metadata: { tool_invoking_message: true } });
  emit("other", {}, randomUUID());
  assert.equal((await read()).items[0].text, "First second");
  emit("Visible \ue200cite\ue202turn0search0\ue201 tail \ue200unfinished");
  assert.equal((await read()).items[0].text, "Visible  tail ");
  emit("a".repeat(40000));
  assert.equal((await read()).items[0].text.length, 32768);
  for (let n = 0; n < 60; n++) emit("next", { id: randomUUID() });
  assert.equal((await read()).items.length, 48);
  await assert.rejects(
    nativeLive({ ...f.input, userMessageId: randomUUID() }, f.read, f.runtime),
    /SUBMISSION_MISMATCH/,
  );
  await assert.rejects(
    nativeLive(f.input, async () => ({ accountFingerprint: "other" }), f.runtime),
    /ACCOUNT_MISMATCH/,
  );
  f.values.set("account", { accountId: "other", userId: "other" });
  emit("wrong account");
  assert.equal((await read()).items.at(-1).text, "next");
  assert.equal(f.state.forwarded, 70);
  assert.equal(f.state.post, 1);
  assert.equal((await f.run({ operation: "inspectDispatch" })).state, "finished");
  f.runtime[Symbol.for("codex-web.native-live")].get(f.input.key).at -= 3600001;
  assert.deepEqual(await read(), { items: [] });
});

test("native public action stream forwards its category without exporting arguments", async () => {
  const f = fixture();
  await f.run();
  f.state.emit({
    type: "message",
    conversationId,
    message: {
      id: randomUUID(),
      author: { role: "assistant" },
      channel: "analysis",
      recipient: "api_tool.call_tool",
      content: {
        parts: [JSON.stringify({ path: "/mcp/github/search", args: { secret: "PRIVATE" } })],
      },
    },
  });
  const result = await nativeLive(f.input, f.read, f.runtime);
  assert.equal(result.items[0].activity, "search");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|args|analysis/);
  assert.equal(f.state.forwarded, 1);
  assert.equal(f.state.post, 1);
});
test("native text dispatch preserves ID and exact text, uses principal-bound native stream and blocks its retry", async () => {
  const f = fixture();
  f.state.retry = true;
  assert.equal((await f.run()).state, "finished");
  assert.equal(f.state.post, 1);
  await f.run();
  assert.equal(f.state.send, 1);
  assert.equal(f.registry.get("app.get_summary"), f.original);
});

test("ordinary new Chat binds caller-owned local/user/parent IDs and resolves only a server candidate", async () => {
  const f = fixture(true);
  f.state.retry = true;
  assert.equal((await f.run()).conversationId, conversationId);
  assert.deepEqual(await f.run({ operation: "resolveCreation" }), { conversationId });
  assert.equal(f.state.post, 1);
  await f.run();
  assert.equal(f.state.send, 1);
  const replaced = fixture(true);
  replaced.values.set("nativeId", conversationId);
  await assert.rejects(replaced.run(), /CONTEXT_CHANGED/);
  assert.equal(replaced.state.send, 0);
  const wrongHome = fixture(true);
  wrongHome.scope.value.routeKind = "chatgpt-thread";
  await assert.rejects(wrongHome.run(), /SELECTED_CHAT_MISMATCH/);
});
test("wrong routes and principals fail before sending; preparation never submits", async () => {
  for (const change of [
    (f) => (f.scope.value.conversationId = randomUUID()),
    (f) => f.values.set("account", {}),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(f.run(), /NATIVE_/);
    assert.equal(f.state.send, 0);
    assert.equal(f.registry.get("app.get_summary"), f.original);
  }
  const f = fixture();
  assert.equal((await f.run({ operation: "prepareDispatch" })).parentId, parentId);
  assert.equal(f.state.send, 0);
  await assert.rejects(f.run({ intentPersisted: false }), /BRANCH_CHANGED/);
});
test("account replacement at final dispatch and native payload substitution never issue a POST", async () => {
  for (const field of ["change", "badBody"]) {
    const f = fixture();
    f.state[field] = true;
    assert.equal((await f.run()).state, "unknown");
    assert.equal(f.state.post, 0);
    await f.run();
    assert.equal(f.state.send, 1);
  }
});
function receipts(t) {
  const root = mkdtempSync(join(tmpdir(), "native-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    path: join(root, "receipts.sqlite"),
    userId,
    accountFingerprint,
    conversationIds: [conversationId],
  };
  return { root, options, open: () => new NativeDispatchReceipts(options) };
}

test("live reads use saved receipt identity, bypass busy writer and remain owner/manual scoped", async (t) => {
  const f = receipts(t),
    ledger = f.open();
  t.after(() => ledger.close());
  const input = { ...fixture().input, versionId: "latest", presetId: 1 };
  delete input.operation;
  let reads = 0;
  const reader = {
    dispatchText: async () => {},
    readLive: async (r) => {
      reads++;
      assert.equal(r.userMessageId, input.userMessageId);
      assert.equal(r.accountFingerprint, accountFingerprint);
      return { items: [] };
    },
  };
  await ledger.dispatch(input, reader);
  const service = new NativeReadService({
    reader,
    userId,
    accountFingerprint,
    statePath: join(f.root, "manual.json"),
    canary: ledger,
  });
  service.busy = true;
  const request = { userId, operation: "readLive", key: input.key, conversationId };
  assert.deepEqual(await service.request(request), { items: [] });
  assert.equal(reads, 1);
  assert.equal(ledger.pending(), true); // Display neither completes nor confirms the send.
  await assert.rejects(service.request({ ...request, userId: randomUUID() }), /WRONG_OWNER/);
  await assert.rejects(
    service.request({ ...request, conversationId: randomUUID() }),
    /INVALID_CANARY/,
  );
  service.leases.add(randomUUID());
  await assert.rejects(service.request(request), /MANUAL_RECOVERY/);
  assert.equal(reads, 1);
});
test("native Stop keeps receipt pending until exact-turn canonical read and idle composer agree", async (t) => {
  const f = receipts(t),
    ledger = f.open();
  t.after(() => ledger.close());
  const input = { ...fixture().input, versionId: "latest", presetId: 1 };
  delete input.operation;
  let stopped = 0,
    idle = false,
    newer = false;
  const reader = {
    dispatchText: async () => {},
    readSubmission: async () => ({ state: newer ? "unknown" : "running", messages: [] }),
    selectConversation: async (r) => {
      assert.equal(r.conversationId, input.conversationId);
    },
    stopResponse: async (r) => {
      assert.equal(r.userMessageId, input.userMessageId);
      stopped++;
    },
    inspectConversation: async () => ({
      selected: true,
      composerReady: true,
      stopAvailable: !idle,
      hasDraft: false,
    }),
  };
  await ledger.dispatch(input, reader);
  await ledger.stop(input, reader);
  assert.equal(ledger.pending(), true);
  await ledger.stop(input, reader);
  assert.equal(stopped, 1);
  idle = true;
  newer = true;
  assert.equal((await ledger.reconcile(input, reader)).state, "unknown");
  assert.equal(ledger.pending(), true);
  newer = false;
  assert.equal((await ledger.reconcile(input, reader)).state, "cancelled");
  assert.equal(ledger.pending(), false);
});
test("native dispatch intention survives disconnect and restart without replay; changed keys/payloads and manual takeover are blocked", async (t) => {
  const f = receipts(t);
  let ledger = f.open();
  let sends = 0;
  const input = { ...fixture().input, versionId: "latest", presetId: 1 };
  delete input.operation;
  const reader = {
    dispatchText: async () => {
      sends++;
      throw Error("lost acknowledgement");
    },
    readSubmission: async () => ({ state: "completed", messages: [] }),
  };
  assert.equal((await ledger.dispatch(input, reader)).state, "unknown");
  ledger.close();
  ledger = f.open();
  t.after(() => ledger.close());
  await ledger.dispatch(input, reader);
  assert.equal(sends, 1);
  await assert.rejects(ledger.dispatch({ ...input, text: "changed" }, reader), /KEY_CONFLICT/);
  await assert.rejects(
    ledger.dispatch({ ...input, key: randomUUID() }, reader),
    /PENDING_DISPATCH/,
  );
  const service = new NativeReadService({
    reader,
    userId,
    accountFingerprint,
    statePath: join(f.root, "manual.json"),
    canary: ledger,
  });
  await assert.rejects(
    service.request({ operation: "beginManual", userId, leaseId: randomUUID() }),
    /PENDING_DISPATCH/,
  );
  await ledger.reconcile(input, reader);
  assert.equal(ledger.pending(), false);
  assert.equal(
    (await service.request({ operation: "beginManual", userId, leaseId: randomUUID() })).manual,
    true,
  );
});

test("reviewing an old confirmed receipt checks the exact idle chat and persists its release", async (t) => {
  const f = receipts(t),
    ledger = f.open();
  t.after(() => ledger.close());
  const input = { ...fixture().input, versionId: "latest", presetId: 1 };
  delete input.operation;
  let state = "running",
    active = true,
    sends = 0;
  const reader = {
    dispatchText: async () => {
      sends++;
    },
    readSubmission: async () => ({ state, messages: [] }),
    selectConversation: async (r) => assert.equal(r.conversationId, input.conversationId),
    inspectConversation: async () => ({
      selected: true,
      composerReady: true,
      hasDraft: false,
      stopAvailable: active,
    }),
  };
  await ledger.dispatch(input, reader);
  await ledger.reconcile(input, reader);
  state = "unknown";
  await assert.rejects(ledger.review(input, reader), /NOT_READY/);
  assert.equal(ledger.pending(), true);
  active = false;
  assert.equal((await ledger.review(input, reader)).reviewed, true);
  assert.equal(ledger.pending(), false);
  assert.equal(sends, 1);
});
test("read-only service never admits canary operations without explicit host configuration", async (t) => {
  const f = receipts(t),
    service = new NativeReadService({
      reader: {},
      userId,
      accountFingerprint,
      statePath: join(f.root, "manual.json"),
    });
  await assert.rejects(service.request({ userId, operation: "dispatchText" }), /INVALID_REQUEST/);
});
function queue(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE gpt_jobs(id TEXT PRIMARY KEY,fingerprint TEXT,nativeId TEXT,text TEXT,files TEXT,model TEXT,effort TEXT,status TEXT,answer TEXT,assets TEXT,createdAt INTEGER,updatedAt INTEGER,error TEXT,requestId TEXT,submitted INTEGER)",
  );
  const id = randomUUID();
  db.prepare(
    "INSERT INTO gpt_jobs VALUES(?,'hash',?,'prompt','[]','latest','1','queued','','[]',1,1,'',NULL,0)",
  ).run(id, conversationId);
  const state = {
    sends: 0,
    readState: "running",
    fail: false,
    revoked: false,
    public: [{ id: "commentary", text: "Public progress", role: "assistant" }],
  };
  let sent;
  const client = {
    prepareDispatch: async (r) => ({
      parentId,
      model: "model",
      effort: null,
      versionId: r.versionId,
      presetId: r.presetId,
    }),
    dispatchText: async (r) => {
      state.sends++;
      sent = r;
      assert.equal(db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(id).status, "running");
      assert.equal(db.prepare("SELECT count(*) n FROM gpt_native_receipts").get().n, 1);
      throw Error("connection lost");
    },
    reconcileDispatch: async () => {
      if (state.fail) throw Error("offline");
      return { userMessageId: sent.userMessageId, state: state.readState, messages: state.public };
    },
  };
  const open = () =>
    new NativeGptJobs(
      { db },
      client,
      () => {
        if (state.revoked) throw Error("revoked");
      },
      new Set([conversationId]),
    );
  return { db, id, state, open, client };
}
test("existing Hub queue commits intent before dispatch and reconciles after restart, preserving partial public output", async (t) => {
  const f = queue(t);
  let worker = f.open();
  assert.equal((await worker.run(f.id)).status, "running");
  assert.equal(f.state.sends, 1);
  f.state.fail = true;
  await assert.rejects(worker.reconcile(f.id), /offline/);
  assert.equal(f.db.prepare("SELECT answer FROM gpt_jobs").get().answer, "Public progress");
  worker = f.open();
  f.state.fail = false;
  f.state.readState = "completed";
  f.state.public.push({ id: "final", role: "assistant", text: "Final answer" });
  assert.equal((await worker.run(f.id)).status, "completed");
  assert.equal(f.state.sends, 1);
  assert.equal(
    f.db.prepare("SELECT answer FROM gpt_jobs").get().answer,
    "Public progress\n\nFinal answer",
  );
});
test("Hub worker refuses files, unknown other jobs and revoked owners without dispatch", async (t) => {
  const f = queue(t),
    worker = f.open();
  f.db.prepare("UPDATE gpt_jobs SET files='[1]'").run();
  await assert.rejects(worker.run(f.id), /ATTACHMENTS/);
  f.db.prepare("UPDATE gpt_jobs SET files='[]'").run();
  f.state.revoked = true;
  await assert.rejects(worker.run(f.id), /revoked/);
  assert.equal(f.state.sends, 0);
});

test("new-chat native receipt is opt-in, survives unknown candidate and never recreates after restart", async (t) => {
  const f = receipts(t),
    key = randomUUID();
  f.options.creationKeys = [key];
  let ledger = f.open();
  const input = { ...fixture(true).input, key, versionId: "latest", presetId: 1 };
  delete input.operation;
  let sends = 0,
    candidate = null;
  const reader = {
    dispatchText: async () => {
      sends++;
      throw Error("lost");
    },
    resolveCreation: async () => ({ conversationId: candidate }),
    findCreation: async () => ({ conversationId: null }),
    readSubmission: async (r) => {
      assert.equal(r.newChat, true);
      assert.equal(r.conversationId, conversationId);
      return { state: "completed", messages: [] };
    },
  };
  await assert.rejects(ledger.dispatch({ ...input, key: randomUUID() }, reader), /INVALID_CANARY/);
  await ledger.dispatch(input, reader);
  ledger.close();
  ledger = f.open();
  t.after(() => ledger.close());
  assert.equal((await ledger.reconcile(input, reader)).conversationId, null);
  await ledger.dispatch(input, reader);
  assert.equal(sends, 1);
  assert.equal(ledger.pending(), true);
  candidate = conversationId;
  assert.equal((await ledger.reconcile(input, reader)).conversationId, conversationId);
  candidate = null;
  assert.equal((await ledger.reconcile(input, reader)).state, "completed");
  assert.equal(ledger.pending(), false);
  assert.equal(sends, 1);
});

test("native creation recovers missing renderer identity using a bounded canonical lookup", async (t) => {
  const f = receipts(t),
    key = randomUUID();
  f.options.creationKeys = [key];
  let ledger = f.open();
  const input = { ...fixture(true).input, key, versionId: "latest", presetId: 1 };
  delete input.operation;
  let sends = 0,
    lookups = 0;
  const reader = {
    dispatchText: async () => {
      sends++;
      throw Error("lost");
    },
    resolveCreation: async () => ({ conversationId: null }),
    findCreation: async (r) => {
      lookups++;
      assert.ok(r.createdAfter > 0);
      assert.equal(r.userMessageId, input.userMessageId);
      return { conversationId };
    },
    readSubmission: async () => ({ state: "completed", messages: [] }),
  };
  await ledger.dispatch(input, reader);
  ledger.close();
  ledger = f.open();
  t.after(() => ledger.close());
  assert.equal((await ledger.reconcile(input, reader)).conversationId, conversationId);
  await ledger.dispatch(input, reader);
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
});

test("new Hub job adopts only canonically confirmed identity and cannot replay or substitute it", async (t) => {
  const f = queue(t);
  f.db.prepare("UPDATE gpt_jobs SET nativeId=NULL").run();
  let input,
    confirmed = null,
    sends = 0;
  f.client.dispatchText = async (r) => {
    input = r;
    sends++;
    assert.equal(r.conversationId, null);
    throw Error("lost");
  };
  f.client.reconcileDispatch = async () => ({
    state: confirmed ? "completed" : "unknown",
    conversationId: confirmed,
    userMessageId: input.userMessageId,
    messages: [],
  });
  const open = () =>
    new NativeGptJobs({ db: f.db }, f.client, () => {}, new Set([conversationId]), new Set([f.id]));
  let worker = open();
  assert.equal((await worker.run(f.id)).status, "unknown");
  assert.equal(f.db.prepare("SELECT nativeId FROM gpt_jobs").get().nativeId, null);
  confirmed = conversationId;
  worker = open();
  assert.equal((await worker.run(f.id)).status, "completed");
  assert.equal(f.db.prepare("SELECT nativeId FROM gpt_jobs").get().nativeId, conversationId);
  assert.equal(sends, 1);
  confirmed = randomUUID();
  await assert.rejects(worker.reconcile(f.id), /SUBMISSION_MISMATCH/);
  assert.equal(f.db.prepare("SELECT nativeId FROM gpt_jobs").get().nativeId, conversationId);
  assert.equal(sends, 1);
});
test("project association is part of the durable Hub dispatch and cannot change during preparation", async (t) => {
  const f = queue(t);
  f.db.exec("CREATE TABLE gpt_project_jobs(jobId TEXT PRIMARY KEY,projectId TEXT)");
  f.db.prepare("INSERT INTO gpt_project_jobs VALUES(?,?)").run(f.id, "g-p-original");
  const prepare = f.client.prepareDispatch;
  f.client.prepareDispatch = async (input) => {
    assert.equal(input.projectId, "g-p-original");
    f.db.prepare("UPDATE gpt_project_jobs SET projectId=?").run("g-p-other");
    return prepare(input);
  };
  await assert.rejects(f.open().run(f.id), /PROJECT_CHANGED/);
  assert.equal(f.state.sends, 0);
});

test("explicit native request is independent of stale picker, hydration and background fetch state", async () => {
  const f = fixture();
  f.values.set("selected", { slug: "previous-model", thinkingEffort: null });
  f.values.set("node", null);
  f.ui.composerReady = false;
  f.values.set("pending", true);
  f.values.set("staging", true);
  assert.equal((await f.run({ operation: "prepareDispatch" })).parentId, parentId);
  assert.equal(f.state.post, 0);
  assert.equal((await f.run()).state, "finished");
  assert.equal(f.state.post, 1);
  const busy = fixture();
  busy.values.set("status", "streaming");
  await assert.rejects(busy.run(), /CONVERSATION_BUSY/);
  assert.equal(busy.state.post, 0);
});

test("preparation navigates once and resolves the requested preset without operating the model picker", async (t) => {
  const f = receipts(t),
    ledger = f.open();
  t.after(() => ledger.close());
  const input = { ...fixture().input, versionId: "latest", presetId: 0 };
  delete input.operation;
  let navigations = 0,
    catalogs = 0;
  const result = await ledger.prepare(input, {
    selectConversation: async () => {
      navigations++;
      return { selected: true, composerReady: false, hasDraft: false, stopAvailable: false };
    },
    inspectConversation: async () => {
      throw Error("Redundant inspection");
    },
    selectSettings: async () => {
      throw Error("Visual picker must not gate sends");
    },
    readModels: async () => {
      catalogs++;
      return {
        versions: [
          {
            id: "latest",
            enabled: true,
            presets: [{ id: 0, available: true, model: "instant", effort: null }],
          },
        ],
      };
    },
    prepareDispatch: async (r) => {
      assert.equal(r.model, "instant");
      assert.equal(r.effort, null);
      return { parentId, model: r.model, effort: r.effort };
    },
  });
  assert.equal(result.presetId, 0);
  assert.equal(navigations, 1);
  assert.equal(catalogs, 1);
  assert.equal(ledger.pending(), false);
});

test("accepted native send survives navigation but still refuses another account", async () => {
  const f = fixture();
  await f.run();
  f.scope.value = { routeKind: "home" };
  assert.equal(f.state.submissionCurrent(), true);
  f.values.set("account", { accountId: "other", userId: "other" });
  assert.equal(f.state.submissionCurrent(), false);
  assert.equal(f.state.post, 1);
});

test("temporary native read failures preserve confirmed delivery and public output", async (t) => {
  const f = queue(t),
    worker = f.open();
  await worker.run(f.id);
  const reconcile = f.client.reconcileDispatch;
  for (const code of [
    "NATIVE_HISTORY_HEADERS_TIMEOUT",
    "NATIVE_HISTORY_BODY_TIMEOUT",
    "NATIVE_BUSY",
    "NATIVE_QUEUE_FULL",
    "NATIVE_MANUAL_RECOVERY",
    "NATIVE_DISCONNECTED",
    "NATIVE_UNAVAILABLE",
    "NATIVE_WINDOW_AMBIGUOUS",
    "NATIVE_RATE_LIMITED",
  ]) {
    f.client.reconcileDispatch = async () => {
      throw Error(code);
    };
    await assert.rejects(worker.reconcile(f.id), { message: code });
    const row = f.db.prepare("SELECT status,answer FROM gpt_jobs").get();
    assert.equal(row.status, "running");
    assert.equal(row.answer, "Public progress");
    assert.equal(
      f.db.prepare("SELECT uncertainSince FROM gpt_native_receipts").get().uncertainSince,
      null,
    );
  }
  f.client.reconcileDispatch = reconcile;
  f.state.readState = "completed";
  assert.equal((await worker.reconcile(f.id)).status, "completed");
  assert.equal(f.state.sends, 1);
});
