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
  let parameters;
  service.kWt.getRequestTarget = (route, options) => {
    parameters = options.parameters;
    return { url: route, headers: {} };
  };
  service.$rn = {
    getInstance: () => ({
      fetch: async (route, options) => {
        assert.equal(options.retry, false);
        const value = await service.kWt.safeGet(route, {
          parameters,
          expectedIdentity: options.expectedIdentity,
          signal: options.signal,
        });
        return new Response(JSON.stringify(value));
      },
    }),
  };
  const load = async () => service;
  const read = (request, cached = false) => {
    if (!cached) runtime[Symbol.for("codex-web.native-history")]?.clear();
    return nativeRead(request, load, runtime);
  };
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

test("stopped native turns finish without exposing hidden terminal content", async () => {
  for (const terminal of [
    { status: "finished_partial_completion" },
    { metadata: { finish_details: { type: "interrupted" } } },
    { metadata: { is_error: true } },
  ]) {
    const f = fixture(),
      accountFingerprint = await f.binding();
    f.node(2, "prompt", { id: id(90), author: { role: "user" } });
    f.node(3, "public update", { channel: "commentary", end_turn: false });
    f.node(4, "private content", { channel: "analysis", end_turn: false, ...terminal });
    const result = await f.read({
      operation: "readSubmission",
      conversationId,
      accountFingerprint,
      userMessageId: id(90),
      parentId: id(1),
      text: "prompt",
    });
    assert.equal(result.state, "cancelled");
    assert.deepEqual(
      result.messages.map((m) => m.text),
      ["public update"],
    );
  }
});

test("a subsequent turn preserves old delivery without borrowing its answer", async () => {
  const f = fixture(), accountFingerprint = await f.binding();
  f.node(2, "old prompt", { id: id(90), author: { role: "user" } });
  f.node(3, "old update", { channel: "commentary", end_turn: false });
  f.node(4, "new prompt", { author: { role: "user" } });
  f.node(5, "new answer", { end_turn: true });
  const result = await f.read({ operation: "readSubmission", conversationId,
    accountFingerprint, userMessageId: id(90), parentId: id(1), text: "old prompt" });
  assert.equal(result.state, "cancelled");
  assert.deepEqual(result.messages.map(m => m.text), ["old update"]);
});

test("submission readback requires exact ID, parent, unchanged text and a public final end-turn", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  f.node(2, "same prompt", { id: id(90), author: { role: "user" } });
  f.node(3, "public commentary", { channel: "commentary", end_turn: false });
  const request = {
    operation: "readSubmission",
    conversationId,
    accountFingerprint,
    userMessageId: id(90),
    parentId: id(1),
    text: "same prompt",
  };
  assert.equal((await f.read(request)).state, "running");
  f.node(4, "hidden", { channel: "analysis", end_turn: true });
  assert.deepEqual(
    (await f.read(request)).messages.map((x) => x.text),
    ["public commentary"],
  );
  f.node(5, "answer", { end_turn: true });
  assert.equal((await f.read(request)).state, "completed");
  assert.equal((await f.read({ ...request, userMessageId: id(91) })).state, "unknown");
  await assert.rejects(f.read({ ...request, parentId: id(5) }), /SUBMISSION_MISMATCH/);
  await assert.rejects(f.read({ ...request, text: "different" }), /SUBMISSION_MISMATCH/);
  f.node(6, "same prompt", { author: { role: "user" } });
  assert.equal((await f.read(request)).state, "completed");
});

test("receipt replies resolve public sources without exposing markers or changing submitted text", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const marker = "\ue200cite\ue202turn0search3\ue202turn0search4\ue201";
  f.node(2, "prompt " + marker, { id: id(90), author: { role: "user" } });
  f.node(3, "Answer " + marker, {
    end_turn: true,
    metadata: {
      content_references: [
        {
          type: "grouped_webpages",
          matched_text: marker,
          items: [
            { url: "https://example.com/source", attribution: "Source" },
            { url: "javascript:alert(1)", title: "Unsafe" },
          ],
        },
      ],
    },
  });
  const result = await f.read({
    operation: "readSubmission",
    conversationId,
    accountFingerprint,
    userMessageId: id(90),
    parentId: id(1),
    text: "prompt " + marker,
  });
  assert.equal(result.state, "completed");
  assert.equal(result.messages[0].text, 'Answer [Source](<https://example.com/source> "Источник")');
  assert.equal(f.calls.length, 1, "source formatting does not request history again");
});

test("long-running receipts remain confirmed beyond a twenty-message page", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  f.node(2, "long task", { id: id(90), author: { role: "user" } });
  for (let n = 3; n <= 42; n++)
    f.node(n, `progress-${n}`, { channel: "commentary", end_turn: false });
  const request = {
    operation: "readSubmission",
    conversationId,
    accountFingerprint,
    userMessageId: id(90),
    parentId: id(1),
    text: "long task",
  };
  const running = await f.read(request);
  assert.equal(running.state, "running");
  assert.equal(running.messages.length, 20);
  f.node(43, "done", { end_turn: true });
  assert.equal((await f.read(request)).state, "completed");
  await assert.rejects(f.read({ ...request, text: "different" }), /SUBMISSION_MISMATCH/);
  f.node(44, "next task", { author: { role: "user" } });
  assert.equal((await f.read(request)).state, "completed");
});

test("canonical attachment identity survives JSON key order, rejecting substituted files and image pointers", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const native = {
    id: "file-image",
    name: "image.png",
    mimeType: "image/png",
    size: 100,
    width: 32,
    height: 16,
    source: "local",
  };
  const content = {
    parts: [
      {
        width: 32,
        height: 16,
        size_bytes: 100,
        content_type: "image_asset_pointer",
        asset_pointer: "file-service://file-image",
      },
      "prompt",
    ],
    content_type: "multimodal_text",
  };
  f.node(2, "prompt", {
    id: id(90),
    author: { role: "user" },
    content,
    metadata: {
      attachments: [{ id: native.id, name: native.name, mime_type: native.mimeType, size: 100 }],
    },
  });
  f.node(3, "answer", { end_turn: true });
  const input = {
    operation: "readSubmission",
    conversationId,
    accountFingerprint,
    userMessageId: id(90),
    parentId: id(1),
    text: "prompt",
    attachments: [{ id: id(99), sha256: "a".repeat(64), native }],
  };
  assert.equal((await f.read(input)).state, "completed");
  content.parts[0].asset_pointer = "file-service://different";
  await assert.rejects(f.read(input), /SUBMISSION_MISMATCH/);
  content.parts[0].asset_pointer = "file-service://file-image";
  f.conversation.mapping[id(2)].message.metadata.attachments[0].id = "different";
  await assert.rejects(f.read(input), /SUBMISSION_MISMATCH/);
});

test("new Chat proof rejects previous user history and project/Work association", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  f.node(2, "prompt", { id: id(90), author: { role: "user" } });
  f.node(3, "answer", { end_turn: true });
  const input = {
    operation: "readSubmission",
    conversationId,
    accountFingerprint,
    userMessageId: id(90),
    parentId: id(1),
    text: "prompt",
    newChat: true,
  };
  assert.equal((await f.read(input)).state, "completed");
  f.conversation.gizmo_id = "g-project";
  await assert.rejects(f.read(input), /SUBMISSION_MISMATCH/);
  delete f.conversation.gizmo_id;
  f.conversation.conversation_origin = "tpp";
  await assert.rejects(f.read(input), /SUBMISSION_MISMATCH/);
  delete f.conversation.conversation_origin;
  f.node(1, "earlier", { author: { role: "user" } });
  f.conversation.current_node = id(3);
  await assert.rejects(f.read(input), /SUBMISSION_MISMATCH/);
});

test("bounded native catalog binds principal, preserves page order and strips unrecognized data", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding(),
    now = new Date().toISOString();
  const items = Array.from({ length: 20 }, (_, n) => ({
    id: id(n),
    title: `Chat ${n}`,
    create_time: now,
    update_time: now,
    secret: "private",
  }));
  f.service.kWt.safeGet = async (route, options) => {
    assert.equal(route, "/conversations");
    assert.deepEqual(options.expectedIdentity, { accountId: "account-a", userId: "user-a" });
    assert.equal(options.parameters.query.limit, 20);
    assert.equal(options.parameters.query.offset, 20);
    return { items, secret: "private" };
  };
  const page = await f.read({ operation: "readCatalog", offset: 20, accountFingerprint });
  assert.equal(page.nextOffset, 40);
  assert.deepEqual(
    page.items.map((x) => x.id),
    items.map((x) => x.id),
  );
  assert.doesNotMatch(JSON.stringify(page), /private|secret/);
  items[1].id = items[0].id;
  await assert.rejects(
    f.read({ operation: "readCatalog", offset: 20, accountFingerprint }),
    /INVALID_CATALOG/,
  );
  await assert.rejects(
    f.read({ operation: "readCatalog", offset: -1, accountFingerprint }),
    /INVALID_REQUEST/,
  );
});

test("creation lookup after renderer loss checks exact first user identity, never title or same prompt", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding(),
    createdAfter = Date.now(),
    now = new Date(createdAfter).toISOString();
  f.node(2, "same prompt", { id: id(90), author: { role: "user" } });
  f.node(3, "answer", { end_turn: true });
  const items = [
    { id: conversationId, title: "unrelated title", create_time: now, update_time: now },
  ];
  let reads = 0;
  f.service.kWt.safeGet = async (route, options) => {
    assert.deepEqual(options.expectedIdentity, { accountId: "account-a", userId: "user-a" });
    if (route === "/conversations") return { items };
    reads++;
    return f.conversation;
  };
  const input = {
    operation: "findCreation",
    accountFingerprint,
    createdAfter,
    userMessageId: id(90),
    parentId: id(1),
    text: "same prompt",
  };
  assert.deepEqual(await f.read(input), { conversationId });
  assert.deepEqual(await f.read({ ...input, userMessageId: id(91) }), { conversationId: null });
  await assert.rejects(f.read({ ...input, text: "changed" }), /SUBMISSION_MISMATCH/);
  const previous = reads;
  for (let n = 1; n < 6; n++) items.push({ ...items[0], id: id(100 + n) });
  assert.deepEqual(await f.read(input), { conversationId: null });
  assert.equal(reads, previous);
  items.splice(1);
  f.service.kWt.safeGet = async () => {
    f.account.userId = "other";
    return { items };
  };
  await assert.rejects(f.read(input), /ACCOUNT_CHANGED/);
});

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

test("exact-message lookup can resolve older artifacts without exporting other history or hidden content", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  for (let n = 2; n <= 45; n++) f.node(n, `text-${n}`);
  const request = {
    operation: "readConversation",
    conversationId,
    accountFingerprint,
    messageId: "message-1",
  };
  const result = await f.read(request);
  assert.deepEqual(
    result.messages.map((m) => m.text),
    ["visible"],
  );
  assert.equal(result.before, null);
  f.conversation.mapping[id(1)].message.channel = "analysis";
  assert.deepEqual((await f.read(request)).messages, []);
  await assert.rejects(f.read({ ...request, messageId: "missing" }), /MESSAGE_NOT_ON_BRANCH/);
  await assert.rejects(f.read({ ...request, before: id(20) }), /INVALID_REQUEST/);
  f.node(46, "off branch");
  f.conversation.current_node = id(45);
  await assert.rejects(f.read({ ...request, messageId: "message-46" }), /MESSAGE_NOT_ON_BRANCH/);
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

test("model catalog keeps native preset IDs and account-bound request, strips other fields", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const catalog = {
    versions: [
      {
        id: "latest",
        display_text_for_intelligence: "Latest",
        enabled: true,
        secret: "private",
        intelligence_presets: [
          {
            id: 6,
            title: "Extra High",
            model_slug: "thinking",
            thinking_effort: "max",
            preset_type: "available",
            secret: "private",
          },
        ],
      },
    ],
    internal_groups: ["private"],
  };
  f.service.kWt.safeGet = async (route, options) => {
    assert.equal(route, "/models");
    assert.deepEqual(options.expectedIdentity, { accountId: "account-a", userId: "user-a" });
    return catalog;
  };
  const result = await f.read({ operation: "readModels", accountFingerprint });
  assert.deepEqual(result.versions[0].presets, [
    { id: 6, label: "Extra High", model: "thinking", effort: "max", available: true },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|internal_groups/);
  catalog.versions.push({ ...catalog.versions[0] });
  await assert.rejects(f.read({ operation: "readModels", accountFingerprint }), /INVALID_MODELS/);
});
test("catalog rejects account changes and unknown availability rather than guessing", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  const catalog = {
    versions: [
      {
        id: "latest",
        display_text_for_intelligence: "Latest",
        enabled: true,
        intelligence_presets: [
          { id: 0, title: "Instant", model_slug: "instant", preset_type: "upgrade" },
        ],
      },
    ],
  };
  f.service.kWt.safeGet = async () => catalog;
  await assert.rejects(f.read({ operation: "readModels", accountFingerprint }), /INVALID_MODELS/);
  f.service.kWt.safeGet = async () => {
    f.account.userId = "another";
    return catalog;
  };
  await assert.rejects(f.read({ operation: "readModels", accountFingerprint }), /ACCOUNT_CHANGED/);
});
test("history projects only explicit canonical model/effort strings", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding();
  f.node(2, "answer", {
    metadata: { model_slug: "thinking", thinking_effort: "standard", secret: "private" },
  });
  const result = await f.read({
    operation: "readConversation",
    conversationId,
    accountFingerprint,
  });
  assert.equal(result.messages.at(-1).model, "thinking");
  assert.equal(result.messages.at(-1).effort, "standard");
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  f.node(3, "answer", {
    metadata: { model_slug: { secret: "private" }, thinking_effort: "x".repeat(129) },
  });
  const invalid = await f.read({
    operation: "readConversation",
    conversationId,
    accountFingerprint,
  });
  assert.equal(invalid.messages.at(-1).model, null);
  assert.equal(invalid.messages.at(-1).effort, null);
});

test("native history shares canonical snapshots and backs off all readers after 429", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding(),
    request = { operation: "readConversationGraph", conversationId, accountFingerprint };
  await f.read(request, true);
  await f.read({ ...request, operation: "readConversation" }, true);
  assert.equal(f.calls.length, 1);
  f.runtime[Symbol.for("codex-web.native-history")].clear();
  let attempts = 0;
  f.service.kWt.safeGet = async () => {
    attempts++;
    throw { status: 429, responseStatus: 429 };
  };
  await assert.rejects(f.read(request, true), /RATE_LIMITED/);
  await assert.rejects(f.read({ ...request, operation: "readConversation" }, true), /RATE_LIMITED/);
  assert.equal(attempts, 1);
});
