import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ConversationBindings } from "../apps/hub/dist/conversation-bindings.js";

const spec = (scopeId, overrides = {}) => ({
  provider: "gpt",
  scope: "project",
  scopeId,
  role: "companion",
  lifecycle: "persistent",
  visibility: "normal",
  execution: null,
  ...overrides,
});
function fixture(t, owner = "user-a") {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return { db, registry: new ConversationBindings(db, owner) };
}
test("exact scope and provider identity survive reopen; another owner cannot adopt the private registry", (t) => {
  const { db, registry } = fixture(t);
  const a = registry.ensure(spec("a"));
  const b = registry.replace(spec("a"), 0, "native-a");
  assert.equal(b.revision, 1);
  assert.equal(new ConversationBindings(db, "user-a").get(spec("a")).nativeId, "native-a");
  assert.throws(() => new ConversationBindings(db, "user-b"), /OWNER_MISMATCH/);
  assert.equal(registry.get(spec("a", { scope: "brainstorm" })), null);
  assert.notEqual(
    registry.ensure(
      spec("a", {
        provider: "codex",
        role: "intake",
        visibility: "utility",
        execution: { machineId: "pc", workingDirectory: "C:/a" },
      }),
    ).id,
    a.id,
  );
  assert.throws(() => registry.replace(spec("a"), 0, "stale"), /Привязка/);
  assert.equal(registry.get(spec("a")).nativeId, "native-a");
});
test("durable memory cannot cross project, role or room even after explicit unlink", (t) => {
  const { db, registry } = fixture(t);
  registry.ensure(spec("a"));
  registry.replace(spec("a"), 0, "chat-a");
  registry.replace(spec("a"), 1, null);
  for (const target of [
    spec("b"),
    spec("a", { role: "intake" }),
    spec("a", { scope: "brainstorm" }),
  ])
    assert.throws(() => registry.replace(target, 0, "chat-a"), {
      code: "CONVERSATION_ALREADY_BOUND",
    });
  assert.equal(registry.replace(spec("a"), 2, "chat-a").revision, 3);
  const history = db
    .prepare(
      "SELECT value FROM ai_conversation_binding_history WHERE bindingId=? ORDER BY revision",
    )
    .all(registry.get(spec("a")).id)
    .map((r) => JSON.parse(r.value));
  assert.deepEqual(
    history.map((r) => r.nativeId),
    [null, "chat-a", null, "chat-a"],
  );
  const other = fixture(t, "user-b");
  assert.equal(other.registry.replace(spec("b"), 0, "chat-a").ownerUserId, "user-b");
});
test("migration preserves duplicate legacy provenance and blocks ambiguous dispatch without choosing a winner", (t) => {
  const { registry } = fixture(t);
  const a = registry.ensure(spec("a"), { nativeId: "old-shared", jobId: "job-a", revision: 9 });
  const b = registry.ensure(spec("b"), { nativeId: "old-shared", jobId: null, revision: 4 });
  assert.equal(a.revision, 9);
  assert.throws(() => registry.assertExclusive(a), { code: "CONVERSATION_ALREADY_BOUND" });
  assert.throws(() => registry.assertExclusive(b), { code: "CONVERSATION_ALREADY_BOUND" });
  const fixed = registry.replace(spec("a"), 9, "separate-chat");
  registry.assertExclusive(fixed);
  assert.equal(
    registry.ensure(spec("a"), { nativeId: "old-shared", jobId: "job-a", revision: 9 }).nativeId,
    "separate-chat",
  );
});
test("late native creation receipts never overwrite an explicit replacement or another bound native identity", (t) => {
  const { registry } = fixture(t);
  registry.ensure(spec("a"));
  registry.recover(spec("a"), 0, null, "job-a");
  registry.recover(spec("a"), 0, "created-a", "job-a");
  assert.throws(() => registry.recover(spec("a"), 0, "wrong-native", "job-a"), {
    code: "CONVERSATION_ALREADY_BOUND",
  });
  registry.replace(spec("a"), 0, "replacement");
  assert.equal(registry.recover(spec("a"), 0, "created-a", "job-a").nativeId, "replacement");
});

test("changing an execution checkout needs an explicit revision and leaves its predecessor in history", (t) => {
  const { db, registry } = fixture(t);
  const original = spec("a", {
    provider: "codex",
    role: "intake",
    visibility: "utility",
    execution: { machineId: "pc-a", workingDirectory: "C:/a" },
  });
  registry.replace(original, 0, "thread-a");
  const moved = { ...original, execution: { machineId: "pc-b", workingDirectory: "D:/a" } };
  assert.throws(() => registry.ensure(moved), { code: "CONVERSATION_BINDING_CHANGED" });
  const revised = registry.replace(moved, 1, "thread-b");
  assert.equal(revised.revision, 2);
  assert.deepEqual(registry.get(moved).execution, moved.execution);
  assert.deepEqual(
    JSON.parse(
      db
        .prepare(
          "SELECT value FROM ai_conversation_binding_history WHERE bindingId=? AND revision=1",
        )
        .get(revised.id).value,
    ).execution,
    original.execution,
  );
});
