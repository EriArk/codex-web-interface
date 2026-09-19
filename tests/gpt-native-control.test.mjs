import assert from "node:assert/strict";
import test from "node:test";
import { nativeControl } from "../ops/gpt-native/renderer-control.mjs";

function fixture() {
  const request = {
    operation: "inspectConversation",
    conversationId: "chat",
    accountFingerprint: "bound",
    userMessageId: "user",
  };
  const state = {
    schemaVersion: 1,
    window: {
      route: { kind: "chatgpt-thread", threadId: "chat" },
      thread: { kind: "chatgpt", id: "chat" },
    },
  };
  const history = { messages: [{ role: "user", id: "user" }] };
  const actions = [];
  let clicks = 0;
  const editor = { getClientRects: () => [1], textContent: "" },
    stop = { getClientRects: () => [1], click: () => clicks++ };
  const elements = {
    '[role="textbox"][contenteditable="true"]': [editor],
    'button[aria-label="Stop"]': [stop],
    'button[aria-label="Send"]': [],
  };
  const runtime = { document: { querySelectorAll: (s) => elements[s] ?? [] } };
  const read = async (r) =>
    r.operation === "inspectAccount" ? { accountFingerprint: "bound" } : history;
  const load = async () => ({
    M9: {
      appActions: {
        runInPrimaryWindow: async ({ action }) => {
          actions.push(action);
          return state;
        },
      },
    },
  });
  return {
    request,
    state,
    history,
    actions,
    editor,
    elements,
    stop,
    read,
    load,
    runtime,
    clicks: () => clicks,
    run: (overrides) => nativeControl({ ...request, ...overrides }, read, load, runtime),
  };
}
test("native state projects only current chat and controls, not sidebar content", async () => {
  const f = fixture();
  f.state.window.sidebar = { secret: "private" };
  const result = await f.run({});
  assert.equal(result.selected, true);
  assert.equal(result.stopAvailable, true);
  assert.doesNotMatch(JSON.stringify(result), /private|sidebar/);
  assert.equal(f.clicks(), 0);
});
test("selection uses native exact-ID navigation and preserves nonempty native drafts", async () => {
  const f = fixture();
  await f.run({ operation: "selectConversation" });
  assert.deepEqual(f.actions[0], {
    type: "windows.show_thread",
    windowId: "current",
    kind: "chatgpt",
    threadId: "chat",
  });
  f.actions.length = 0;
  f.editor.textContent = "unsent";
  await assert.rejects(f.run({ operation: "selectConversation" }), /DRAFT_PRESENT/);
  assert.equal(f.actions.length, 0);
});
test("stop requires both matching route and thread identities", async () => {
  const f = fixture();
  f.state.window.route.threadId = "different";
  await assert.rejects(f.run({ operation: "stopResponse" }), /SELECTED_CHAT_MISMATCH/);
  f.state.window.route.threadId = "chat";
  f.state.window.thread.id = "different";
  await assert.rejects(f.run({ operation: "stopResponse" }), /SELECTED_CHAT_MISMATCH/);
  assert.equal(f.clicks(), 0);
});
test("stop is bound to latest exact user message and does not claim completion", async () => {
  const f = fixture();
  const result = await f.run({ operation: "stopResponse" });
  assert.equal(f.clicks(), 1);
  assert.equal(result.stopIssued, true);
  assert.equal(result.confirmed, false);
  f.history.messages.push({ role: "user", id: "newer" });
  await assert.rejects(f.run({ operation: "stopResponse" }), /TURN_MISMATCH/);
  assert.equal(f.clicks(), 1);
});
test("account and turn changes during asynchronous checks block stop", async () => {
  const f = fixture();
  await assert.rejects(
    nativeControl(
      { ...f.request, operation: "stopResponse" },
      async (r) => (r.operation === "inspectAccount" ? { accountFingerprint: "other" } : f.history),
      f.load,
      f.runtime,
    ),
    /ACCOUNT_MISMATCH/,
  );
  await assert.rejects(
    nativeControl(
      { ...f.request, operation: "stopResponse" },
      async (r) =>
        r.operation === "inspectAccount"
          ? { accountFingerprint: "bound" }
          : { messages: [{ role: "user", id: "newer" }] },
      f.load,
      f.runtime,
    ),
    /TURN_MISMATCH/,
  );
  assert.equal(f.clicks(), 0);
});
test("hidden, disabled, absent and ambiguous Stop controls cannot be clicked", async () => {
  const f = fixture();
  for (const controls of [
    [],
    [f.stop, f.stop],
    [{ ...f.stop, disabled: true }],
    [{ ...f.stop, getClientRects: () => [] }],
  ]) {
    f.elements['button[aria-label="Stop"]'] = controls;
    await assert.rejects(f.run({ operation: "stopResponse" }), /STOP_UNAVAILABLE/);
  }
  assert.equal(f.clicks(), 0);
});
test("state polling never fetches canonical history", async () => {
  const f = fixture();
  let calls = 0;
  await nativeControl(
    f.request,
    async (r) => {
      assert.equal(r.operation, "inspectAccount");
      calls++;
      return { accountFingerprint: "bound" };
    },
    f.load,
    f.runtime,
  );
  assert.equal(calls, 2);
});
test("a route change during the final history check blocks Stop", async () => {
  const f = fixture();
  await assert.rejects(
    nativeControl(
      { ...f.request, operation: "stopResponse" },
      async (r) => {
        if (r.operation === "inspectAccount") return { accountFingerprint: "bound" };
        f.state.window.route.threadId = "new-chat";
        return f.history;
      },
      f.load,
      f.runtime,
    ),
    /SELECTED_CHAT_MISMATCH/,
  );
  assert.equal(f.clicks(), 0);
});
