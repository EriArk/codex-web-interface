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
      return {};
    },
    startCompletionStream(args) {
      this.createCompletionStreamHandlers({ shouldAttemptResume: () => true });
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
    );
  return { run, input, state, scope, values, registry, original, ui };
}
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
  await assert.rejects(wrongHome.run(), /CONTEXT_CHANGED/);
});
test("prepare is read-only; drafts, route, model, principal and branch changes fail before sending", async () => {
  for (const change of [
    (f) => (f.ui.hasDraft = true),
    (f) => (f.scope.value.conversationId = randomUUID()),
    (f) => f.values.set("selected", { slug: "other" }),
    (f) => f.values.set("account", {}),
    (f) => f.values.set("node", randomUUID()),
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
