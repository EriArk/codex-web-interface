import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NativeLabFollowup } from "../ops/gpt-native/followup.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const binding = {
    conversationId: randomUUID(),
    accountFingerprint: "a".repeat(64),
    callerThreadId: randomUUID(),
    build: "26.915.31945",
    disposable: true,
  };
  const state = { selected: true, composerReady: true, hasDraft: false, stopAvailable: false };
  const history = {
    conversationId: binding.conversationId,
    currentNode: "baseline",
    messages: [{ nodeId: "baseline", id: "old", role: "assistant", text: "old" }],
    before: null,
  };
  const reader = { inspectConversation: async () => state, readConversation: async () => history };
  let sends = 0;
  const dispatch = async () => {
    sends++;
    return { success: true };
  };
  const options = { db, reader, ...binding, dispatch };
  const writer = new NativeLabFollowup(options);
  const key = randomUUID(),
    request = { key, prompt: `Diagnostic ${key}. Say ok.` };
  return { db, options, writer, state, history, request, sends: () => sends };
}
test("same operation key sends once; different payload cannot reuse key", async (t) => {
  const f = fixture(t);
  assert.equal((await f.writer.send(f.request)).state, "acknowledged");
  await f.writer.send(f.request);
  assert.equal(f.sends(), 1);
  await assert.rejects(
    f.writer.send({ ...f.request, prompt: `${f.request.prompt} changed` }),
    /KEY_CONFLICT/,
  );
});
test("lost acknowledgement remains unknown through reopen and never auto-replays", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.writer.dispatch = async () => {
    attempts++;
    throw Error("socket closed");
  };
  assert.equal((await f.writer.send(f.request)).state, "unknown");
  const reopened = new NativeLabFollowup(f.options);
  await reopened.send(f.request);
  assert.equal(attempts, 1);
  assert.equal(f.sends(), 0);
});
test("pending operations serialize writes, including simultaneous calls", async (t) => {
  const f = fixture(t);
  await Promise.all([f.writer.send(f.request), f.writer.send(f.request)]);
  assert.equal(f.sends(), 1);
  const key = randomUUID();
  await assert.rejects(f.writer.send({ key, prompt: `Diagnostic ${key}` }), /PENDING_RECEIPT/);
});
test("preflight draft, active response and account failures never dispatch", async (t) => {
  const f = fixture(t);
  f.state.hasDraft = true;
  await assert.rejects(f.writer.send(f.request), /NOT_READY/);
  f.state.hasDraft = false;
  f.state.stopAvailable = true;
  await assert.rejects(f.writer.send(f.request), /NOT_READY/);
  f.options.reader.inspectConversation = async () => {
    throw Error("NATIVE_ACCOUNT_MISMATCH");
  };
  await assert.rejects(f.writer.send(f.request), /ACCOUNT_MISMATCH/);
  assert.equal(f.sends(), 0);
});
test("canonical exact nonce after saved baseline confirms a receipt", async (t) => {
  const f = fixture(t);
  await f.writer.send(f.request);
  f.history.messages.push({ nodeId: "new", id: "sent-user", role: "user", text: f.request.prompt });
  const result = await f.writer.reconcile(f.request.key);
  assert.equal(result.state, "confirmed");
  assert.equal(result.userMessageId, "sent-user");
  assert.equal(f.sends(), 1);
});
test("missing baseline, duplicated prompt and newer users remain unknown", async (t) => {
  const f = fixture(t);
  await f.writer.send(f.request);
  const baseline = f.history.messages[0],
    prompt = { nodeId: "new", id: "sent", role: "user", text: f.request.prompt };
  for (const messages of [
    [prompt],
    [baseline, prompt, { ...prompt, id: "duplicate" }],
    [baseline, prompt, { id: "other", role: "user", text: "other" }],
  ]) {
    f.history.messages = messages;
    assert.equal((await f.writer.reconcile(f.request.key)).state, "unknown");
  }
  assert.equal(f.sends(), 1);
});
test("ledger cannot be rebound to another account or used outside disposable lab", (t) => {
  const f = fixture(t);
  assert.throws(
    () => new NativeLabFollowup({ ...f.options, accountFingerprint: "b".repeat(64) }),
    /BINDING_MISMATCH/,
  );
  assert.throws(() => new NativeLabFollowup({ ...f.options, disposable: false }), /LAB_ONLY/);
});
test("persisted dispatch intent precedes native mutation; nonce is mandatory", async (t) => {
  const f = fixture(t);
  f.writer.dispatch = async () => {
    assert.equal(f.db.prepare("SELECT state FROM receipts").get().state, "dispatching");
    return { success: true };
  };
  await assert.rejects(f.writer.send({ ...f.request, prompt: "no unique marker" }), /INVALID_SEND/);
  await f.writer.send(f.request);
});
test("process loss after dispatch intention is treated as unknown on reopen", async (t) => {
  const f = fixture(t);
  await f.writer.send(f.request);
  f.db.prepare("UPDATE receipts SET state='dispatching'").run();
  const reopened = new NativeLabFollowup(f.options);
  assert.equal((await reopened.send(f.request)).state, "unknown");
  assert.equal(f.sends(), 1);
});
