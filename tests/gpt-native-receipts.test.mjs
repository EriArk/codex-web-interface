import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NativeOperationReceipts } from "../ops/gpt-native/operation-receipts.mjs";
import { nativeWorkspace } from "../ops/gpt-native/renderer-workspace.mjs";
import { NativeWorkspaceReceipts } from "../ops/gpt-native/workspace-receipts.mjs";

test("native reply receipts survive lost acknowledgements without replay and require a real final", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const root = randomUUID(),
    user = randomUUID(),
    answer = randomUUID(),
    conversationId = randomUUID();
  const graph = {
    current_node: answer,
    mapping: {
      [root]: { id: root, parent: null, message: null },
      [user]: {
        id: user,
        parent: root,
        message: { id: user, author: { role: "user" }, content: { parts: ["prompt"] } },
      },
      [answer]: {
        id: answer,
        parent: user,
        message: {
          id: answer,
          author: { role: "assistant" },
          channel: "final",
          content: { parts: ["old"] },
          status: "finished_successfully",
          end_turn: true,
        },
      },
    },
  };
  const request = {
    key: randomUUID(),
    conversationId,
    messageId: answer,
    currentNode: answer,
    action: "regenerate",
    text: "",
    model: "latest",
    effort: "1",
  };
  let calls = 0,
    active = false;
  const reader = {
    readConversationGraph: async () => graph,
    selectConversation: async () => {},
    inspectConversation: async () => ({
      selected: true,
      composerReady: true,
      hasDraft: false,
      stopAvailable: active,
    }),
    selectSettings: async () => {},
    readModels: async () => ({
      versions: [
        {
          id: "latest",
          enabled: true,
          presets: [{ id: 1, available: true, model: "model", effort: "standard" }],
        },
      ],
    }),
    mutateOperation: async () => {
      calls++;
      throw Error("Lost acknowledgement");
    },
  };
  const dispatch = { db, pending: () => false };
  let receipts = new NativeOperationReceipts(dispatch);
  assert.equal((await receipts.run(request, reader)).state, "unknown");
  receipts = new NativeOperationReceipts(dispatch);
  assert.equal((await receipts.run(request, reader, true)).state, "unknown");
  active = true;
  await assert.rejects(receipts.run({ ...request, review: true }, reader, true), /NOT_READY/);
  assert.equal(calls, 1);
  const next = randomUUID();
  graph.current_node = next;
  graph.mapping[next] = {
    id: next,
    parent: user,
    message: {
      id: next,
      author: { role: "assistant" },
      channel: "final",
      content: { parts: ["new"] },
      status: "finished_successfully",
      end_turn: false,
    },
  };
  assert.equal((await receipts.run(request, reader, true)).state, "unknown");
  graph.mapping[next].message.end_turn = true;
  assert.equal((await receipts.run(request, reader, true)).state, "completed");
  assert.equal(calls, 1);
  await assert.rejects(receipts.run({ ...request, text: "changed" }, reader), /KEY_CONFLICT/);
});

test("native workspace binds requests to the account, rejects stale forms and distinguishes a rejected POST", async () => {
  const raw = {
    id: "task",
    title: "Example",
    prompt: "Reminder",
    is_enabled: true,
    schedule: "daily",
    default_timezone: "UTC",
    timing_mode: "exact_schedule",
    current_user_role: "owner",
    can_delete: true,
    notifications_enabled: true,
    email_enabled: false,
  };
  let status = 200,
    posts = 0,
    changed = false;
  const runtime = {
    crypto: webcrypto,
    document: { querySelector: () => ({}), querySelectorAll: () => [] },
  };
  const read = async () => ({ accountFingerprint: changed ? "other" : "bound" });
  const load = async () => ({
    M9: {
      accessInputs: {
        readAccountInfo: async () => ({
          status: "ready",
          data: { accountId: "account", userId: "user" },
        }),
      },
    },
    kWt: { getRequestTarget: (path) => ({ url: path, headers: {} }) },
    $rn: {
      getInstance: () => ({
        fetch: async (_url, args) => {
          assert.deepEqual(args.expectedIdentity, { accountId: "account", userId: "user" });
          assert.equal(args.retry, false);
          if (args.method === "POST") {
            args.assertRequestCurrent();
            posts++;
            assert.throws(args.assertRequestCurrent, /REPLAY_BLOCKED/);
            return new Response("{}", { status });
          }
          return new Response(JSON.stringify(raw));
        },
      }),
    },
  });
  const run = (r) => nativeWorkspace({ ...r, accountFingerprint: "bound" }, read, load, runtime);
  const before = (await run({ operation: "scheduledRead", id: "task" })).item;
  const input = { kind: "schedule", action: "pause", id: "task", revision: before.revision };
  assert.equal(
    (await run({ operation: "workspaceMutation", input: { ...input, revision: "b".repeat(64) } }))
      .dispatched,
    false,
  );
  assert.equal(posts, 0);
  status = 429;
  assert.equal((await run({ operation: "workspaceMutation", input })).dispatched, false);
  status = 503;
  await assert.rejects(run({ operation: "workspaceMutation", input }), /WORKSPACE_UNAVAILABLE/);
  assert.equal(posts, 2);
  changed = true;
  await assert.rejects(run({ operation: "scheduledRead", id: "task" }), /ACCOUNT_CHANGED/);
});

test("workspace lost acknowledgement reconciles exact schedule state and never repeats a mutation", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const dispatch = { db, pending: () => false };
  let calls = 0,
    enabled = true;
  const request = {
    key: randomUUID(),
    input: { kind: "schedule", id: "task", revision: "a".repeat(64), action: "pause" },
  };
  const reader = {
    workspace: async (r) => {
      if (r.operation === "workspaceMutation") {
        calls++;
        throw Error("Lost acknowledgement");
      }
      if (r.operation === "scheduledRead") return { item: { id: "task", enabled } };
      return { ready: true, generating: false };
    },
  };
  assert.equal((await new NativeWorkspaceReceipts(dispatch).run(request, reader)).state, "unknown");
  enabled = false;
  assert.equal(
    (await new NativeWorkspaceReceipts(dispatch).run(request, reader, true)).state,
    "completed",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    new NativeWorkspaceReceipts(dispatch).run(
      { ...request, input: { ...request.input, action: "resume" } },
      reader,
    ),
    /KEY_CONFLICT/,
  );
});
