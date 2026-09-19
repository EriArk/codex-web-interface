import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { nativeRead } from "../ops/gpt-native/renderer-read.mjs";

const conversationId = "10000000-0000-4000-8000-000000000001";
const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const account = { accountId: "account-a", userId: "user-a", authenticatedUserId: "user-a" };
  const runtime = {
    crypto: webcrypto,
    electronBridge: { getSentryInitOptions: () => ({ appVersion: "26.915.31945" }) },
  };
  const conversation = { conversation_id: conversationId, current_node: id(1), mapping: {} };
  const calls = [];
  const service = {
    M9: {
      accessInputs: { readAccountInfo: async () => ({ status: "ready", data: { ...account } }) },
    },
    kWt: {
      safeGet: async (route, options) => {
        calls.push({ route, options });
        return conversation;
      },
    },
  };
  const load = async () => service;
  const read = (request) => nativeRead(request, load, runtime);
  const node = (n, text, extra = {}) => {
    const message = {
      id: `message-${n}`,
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      content: { content_type: "text", parts: [text] },
      status: "finished_successfully",
      ...extra,
    };
    conversation.mapping[id(n)] = { id: id(n), parent: n > 1 ? id(n - 1) : null, message };
    conversation.current_node = id(n);
  };
  const binding = async () => (await read({ operation: "inspectAccount" })).accountFingerprint;
  node(1, "visible");
  return { account, runtime, conversation, calls, service, read, node, binding };
}

test("native reader uses fresh typed service with exact principal and no title navigation", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const request = { operation: "readConversation", conversationId, accountFingerprint };
  assert.equal((await f.read(request)).messages[0].text, "visible");
  f.node(2, "new response");
  assert.equal((await f.read(request)).messages.at(-1).text, "new response");
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.route, "/conversation/{conversation_id}");
    assert.deepEqual(call.options.expectedIdentity, { accountId: "account-a", userId: "user-a" });
    assert.equal(call.options.parameters.path.conversation_id, conversationId);
    assert.equal(call.options.retry, undefined);
  }
});

test("wrong build, missing identity and invalid requests fail before a history read", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const request = { operation: "readConversation", conversationId, accountFingerprint };
  await assert.rejects(f.read({ ...request, conversationId: "../../other" }), /INVALID_REQUEST/);
  await assert.rejects(f.read({ ...request, operation: "send" }), /READ_ONLY/);
  f.runtime.electronBridge.getSentryInitOptions = () => ({ appVersion: "future" });
  await assert.rejects(f.read(request), /UNSUPPORTED_BUILD/);
  f.runtime.electronBridge.getSentryInitOptions = () => ({ appVersion: "26.915.31945" });
  f.account.userId = "";
  await assert.rejects(f.read(request), /ACCOUNT_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
});

test("account changes before and during reads discard content, never rebind automatically", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const request = { operation: "readConversation", conversationId, accountFingerprint };
  f.account.accountId = "other";
  await assert.rejects(f.read(request), /ACCOUNT_MISMATCH/);
  assert.equal(f.calls.length, 0);
  f.account.accountId = "account-a";
  f.service.kWt.safeGet = async () => {
    f.account.userId = "other";
    return f.conversation;
  };
  await assert.rejects(f.read(request), /ACCOUNT_CHANGED/);
});

test("only public current-branch messages cross the renderer boundary", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  f.node(2, "hidden analysis", { channel: "analysis" });
  f.node(3, "hidden system", { author: { role: "system" } });
  f.node(4, "hidden internal tool", { recipient: "python" });
  f.node(5, "hidden metadata", { metadata: { is_visually_hidden_from_conversation: true } });
  f.node(6, "public progress", { channel: "commentary" });
  f.node(7, "public final");
  f.node(8, "off branch");
  f.conversation.current_node = id(7);
  const result = await f.read({
    operation: "readConversation",
    conversationId,
    accountFingerprint,
  });
  assert.deepEqual(
    result.messages.map((m) => m.text),
    ["visible", "public progress", "public final"],
  );
  assert.equal(result.messages[1].channel, "commentary");
  assert.equal(JSON.stringify(result).includes("hidden"), false);
  assert.equal(result.currentNode, id(7));
});

test("twenty-message paging uses exact ancestor cursors and retains distinct messages", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  for (let n = 2; n <= 45; n++) f.node(n, "same text");
  const request = { operation: "readConversation", conversationId, accountFingerprint };
  const first = await f.read(request),
    second = await f.read({ ...request, before: first.before }),
    third = await f.read({ ...request, before: second.before });
  assert.deepEqual(
    [first.messages.length, second.messages.length, third.messages.length],
    [20, 20, 5],
  );
  assert.equal(
    new Set([...first.messages, ...second.messages, ...third.messages].map((m) => m.id)).size,
    45,
  );
  assert.equal(third.before, null);
  await assert.rejects(f.read({ ...request, before: id(99) }), /CURSOR_NOT_ON_BRANCH/);
});

test("wrong conversation, cycles, missing parents and oversized text fail closed", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const request = { operation: "readConversation", conversationId, accountFingerprint };
  f.conversation.conversation_id = id(99);
  await assert.rejects(f.read(request), /CONVERSATION_MISMATCH/);
  f.conversation.conversation_id = conversationId;
  f.conversation.mapping[id(1)].parent = id(1);
  await assert.rejects(f.read(request), /INVALID_HISTORY/);
  f.conversation.mapping[id(1)].parent = id(99);
  await assert.rejects(f.read(request), /INVALID_HISTORY/);
  f.node(1, "a".repeat(1024 * 1024 + 1));
  await assert.rejects(f.read(request), /HISTORY_TOO_LARGE/);
});

test("credentials, signed media and unknown structures are not serialized", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  f.node(2, "", {
    content: {
      content_type: "multimodal_text",
      parts: ["caption", { asset_pointer: "signed-secret", internal: "secret" }],
    },
    metadata: { attachments: [{ url: "signed-secret" }], secret: "private" },
  });
  f.conversation.secret = "private";
  f.account.email = "private";
  const result = await f.read({
    operation: "readConversation",
    conversationId,
    accountFingerprint,
  });
  assert.equal(result.messages.at(-1).text, "caption");
  assert.equal(result.messages.at(-1).hasAttachments, true);
  assert.equal(result.mediaResolved, false);
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});

test("upstream errors do not expose content, URL or credentials", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  f.service.kWt.safeGet = async () => {
    throw Error("upstream secret URL");
  };
  await assert.rejects(
    f.read({ operation: "readConversation", conversationId, accountFingerprint }),
    { message: "NATIVE_READ_UNAVAILABLE" },
  );
});
