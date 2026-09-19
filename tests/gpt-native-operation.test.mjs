import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { nativeOperation } from "../ops/gpt-native/renderer-operation.mjs";

function fixture(action) {
  const conversationId = randomUUID(),
    root = randomUUID(),
    user = randomUUID(),
    assistant = randomUUID(),
    generated = randomUUID();
  const principal = { accountId: "account", userId: "user" },
    state = { posts: 0, replace: false, corrupt: false };
  const graph = {
    current_node: assistant,
    mapping: {
      [user]: {
        id: user,
        parent: root,
        message: {
          id: user,
          author: { role: "user" },
          content: { content_type: "text", parts: ["original"] },
          metadata: { attachments: [{ id: "file-original" }] },
        },
      },
      [assistant]: {
        id: assistant,
        parent: user,
        message: {
          id: assistant,
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["answer"] },
        },
      },
    },
  };
  const input = {
    action,
    conversationId,
    messageId: action === "edit" ? user : assistant,
    currentNode: assistant,
    targetMessageId: assistant,
    promptId: user,
    userMessageId: generated,
    text: action === "regenerate" ? "" : "changed",
    nativeModel: "model",
    nativeEffort: "standard",
    accountFingerprint: "a".repeat(64),
    intentPersisted: true,
  };
  const service = {
    createCompletionStreamHandlers: (x) => x,
    startCompletionStream(args) {
      assert.deepEqual(args.expectedIdentity, principal);
      if (state.replace) account = { accountId: "other", userId: "other" };
      args.assertRequestCurrent();
      state.posts++;
      assert.throws(() => args.assertRequestCurrent(), /REPLAY_BLOCKED/);
      return {};
    },
  };
  let account = principal;
  const scope = {
    get: (x) =>
      x === "service"
        ? service
        : x === "account"
          ? account
          : x === "node"
            ? graph.current_node
            : x === "selected"
              ? { slug: "model", thinkingEffort: "standard" }
              : [],
  };
  const registry = new Map([["app.get_summary", () => ({})]]);
  const m = {
    eWt: (x) => x,
    VNt: "selected",
    gzt: "node",
    dWt: "account",
    CUt: "service",
    UNt: "hints",
    M9: {
      accessInputs: { readAccountInfo: async () => ({ data: principal }) },
      appActions: {
        runInPrimaryWindow: async () => registry.get("app.get_summary")({}, { scope }),
      },
    },
    lDt: ({ prompt }) => ({
      message: { author: { role: "user" }, content: { content_type: "text", parts: [prompt] } },
    }),
    czt: async () => ({ clientThreadId: "local" }),
  };
  const dispatch = (s, messages) =>
    s
      .get("service")
      .startCompletionStream({
        request: {
          model: state.corrupt ? "other" : "model",
          thinking_effort: "standard",
          parent_message_id: action === "edit" ? root : action === "fork" ? assistant : user,
          action: action === "regenerate" ? "variant" : "next",
          messages,
          ...(action === "fork"
            ? {
                branching_from_conversation_id: conversationId,
                branching_from_message_id: assistant,
              }
            : { conversation_id: conversationId }),
        },
      });
  m.mDt = async (s, args) => {
    if (action === "edit")
      assert.equal(args.userCompletionMessages.message.metadata.attachments[0].id, "file-original");
    dispatch(s, [args.userCompletionMessages.message]);
    return { serverConversationId: action === "fork" ? randomUUID() : conversationId };
  };
  m.z$ = async (s) => dispatch(s, []);
  const read = async (r) =>
    r.operation === "inspectAccount" ? { accountFingerprint: input.accountFingerprint } : graph;
  const run = () =>
    nativeOperation(
      input,
      read,
      async () => ({ selected: true, composerReady: true, hasDraft: false, stopAvailable: false }),
      async () => m,
      {},
      async () => ({ appActionRegistry: registry }),
    );
  return { run, state, input, graph };
}
test("native edit, regenerate and fork use exact source/model, preserve files and submit at most once", async () => {
  for (const action of ["edit", "regenerate", "fork"]) {
    const f = fixture(action),
      result = await f.run();
    assert.equal(result.dispatched, true);
    assert.equal(f.state.posts, 1);
    assert(result.nativeId);
  }
});
test("native reply actions reject account, model and branch changes before a POST", async () => {
  for (const key of ["replace", "corrupt"]) {
    const f = fixture("edit");
    f.state[key] = true;
    await assert.rejects(f.run(), /ACCOUNT_CHANGED|OPERATION_CHANGED/);
    assert.equal(f.state.posts, 0);
  }
  const f = fixture("fork");
  f.graph.current_node = randomUUID();
  await assert.rejects(f.run(), /BRANCH_CHANGED/);
  assert.equal(f.state.posts, 0);
});
