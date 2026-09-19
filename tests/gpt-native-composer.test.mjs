import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { nativeComposer } from "../ops/gpt-native/renderer-composer.mjs";

const key = "10000000-0000-4000-8000-000000000001",
  accountFingerprint = "a".repeat(64);
function fixture() {
  let account = accountFingerprint,
    homeActions = 0,
    sends = 0,
    uploads = 0,
    mode = "Chat",
    stopping = false;
  const summary = {
    schemaVersion: 1,
    window: { route: { kind: "home", pathname: "/" }, thread: null },
  };
  const attributes = (attrs) => ({
    getClientRects: () => [1],
    closest: () => null,
    getAttribute: (k) => attrs[k] ?? null,
  });
  const files = [];
  const body = { querySelectorAll: () => files };
  const editor = {
    ...attributes({}),
    textContent: "",
    closest: (s) => (s === "[data-composer-body]" ? body : null),
    focus: () => {},
  };
  const send = { ...attributes({}), disabled: false, click: () => sends++ };
  const chat = { ...attributes({ "aria-pressed": "true" }), textContent: "Chat" };
  const input = {
    disabled: false,
    files: [],
    dispatchEvent: () => {
      uploads++;
      for (const f of input.files) files.push(attributes({ "aria-label": `Remove ${f.name}` }));
    },
  };
  const runtime = {
    crypto: webcrypto,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    File: class {
      constructor(_bytes, name, { type }) {
        this.name = name;
        this.type = type;
      }
    },
    DataTransfer: class {
      constructor() {
        this.files = [];
        this.items = { add: (f) => this.files.push(f) };
      }
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      execCommand: (_command, _ui, text) => {
        editor.textContent = text;
        return true;
      },
      querySelectorAll: (s) =>
        ({
          '[role="textbox"][contenteditable="true"]': [editor],
          'button[aria-label="Stop"]': stopping ? [send] : [],
          'button[aria-label="Send"]': [send],
          "button[aria-pressed]": mode === "Chat" ? [chat] : [],
          'input[type="file"][aria-label="Attach files"]': [input],
        })[s] ?? [],
    },
  };
  const history = { conversationId: key, messages: [], before: null };
  const read = async (r) =>
    r.operation === "readConversation" ? history : { accountFingerprint: account };
  const load = async () => ({
    M9: {
      appActions: {
        runInPrimaryWindow: async ({ action }) => {
          if (action.type === "windows.show_home") homeActions++;
          return summary;
        },
      },
    },
  });
  const run = (overrides) =>
    nativeComposer(
      { operation: "prepareNewChat", disposable: true, key, accountFingerprint, ...overrides },
      read,
      load,
      runtime,
    );
  const text = `Diagnostic ${key} reply OK`;
  const file = {
    name: "fixture.txt",
    type: "text/plain",
    base64: Buffer.from("fixture").toString("base64"),
    sha256: createHash("sha256").update("fixture").digest("hex"),
  };
  return {
    run,
    text,
    file,
    editor,
    send,
    files,
    runtime,
    summary,
    history,
    input,
    changeAccount: () => {
      account = "b".repeat(64);
    },
    setMode: (m) => {
      mode = m;
    },
    stop: () => {
      stopping = true;
    },
    counts: () => ({ homeActions, sends, uploads }),
  };
}
test("native creation requires disposable scope and an empty Chat composer", async () => {
  const f = fixture();
  await assert.rejects(f.run({ disposable: false }), /LAB_ONLY/);
  f.editor.textContent = "owner draft";
  await assert.rejects(f.run(), /DRAFT_PRESENT/);
  assert.equal(f.counts().homeActions, 0);
  f.editor.textContent = "";
  f.files.push({ getAttribute: () => "Remove file.txt" });
  await assert.rejects(f.run(), /DRAFT_PRESENT/);
  assert.equal(f.counts().homeActions, 0);
  f.files.length = 0;
  f.setMode("Work");
  await assert.rejects(f.run(), /CHAT_MODE_REQUIRED/);
  assert.equal(f.counts().sends, 0);
});
test("draft lease binds exact key, account and native DOM; no silent takeover", async () => {
  const f = fixture();
  await f.run();
  await assert.rejects(f.run(), /DRAFT_LEASE_EXISTS/);
  await assert.rejects(
    f.run({ operation: "inspectDraft", key: key.replace(/1$/, "2") }),
    /DRAFT_LEASE_MISSING/,
  );
  f.changeAccount();
  await assert.rejects(f.run({ operation: "stageText", text: f.text }), /ACCOUNT_CHANGED/);
  assert.equal(f.editor.textContent, "");
});
test("native insertion, hashed attachments and dispatch are explicit and single-click", async () => {
  const f = fixture();
  await f.run();
  await f.run({ operation: "stageText", text: f.text });
  const staged = await f.run({ operation: "stageFiles", files: [f.file] });
  assert.equal(staged.ready, false);
  const state = await f.run({ operation: "inspectDraft" });
  assert.equal(state.filesMatch, true);
  assert.equal(state.fileCount, 1);
  const request = {
    operation: "submitDraft",
    text: f.text,
    files: [{ name: f.file.name, sha256: f.file.sha256 }],
  };
  await assert.rejects(f.run(request), /DISPATCH_INTENT_REQUIRED/);
  assert.equal(f.counts().sends, 0);
  const submitted = await f.run({ ...request, intentPersisted: true });
  assert.equal(submitted.confirmed, false);
  assert.equal(f.counts().sends, 1);
  await assert.rejects(f.run({ ...request, intentPersisted: true }), /ALREADY_DISPATCHED/);
  assert.equal(f.counts().sends, 1);
});
test("bad attachment hashes, names, MIME and duplicate names never upload", async () => {
  const f = fixture();
  await f.run();
  for (const files of [
    [{ ...f.file, sha256: "0".repeat(64) }],
    [{ ...f.file, name: "../secret.txt" }],
    [{ ...f.file, type: "image/png" }],
    [f.file, f.file],
  ]) {
    await assert.rejects(
      f.run({ operation: "stageFiles", files }),
      /FILE_HASH_MISMATCH|INVALID_FILES/,
    );
  }
  assert.equal(f.counts().uploads, 0);
});
test("oversized data is bounded before uploading and attachment staging cannot repeat", async () => {
  const f = fixture();
  await f.run();
  await assert.rejects(
    f.run({ operation: "stageFiles", files: [{ ...f.file, base64: "a".repeat(1400001) }] }),
    /INVALID_FILES/,
  );
  await f.run({ operation: "stageFiles", files: [f.file] });
  await assert.rejects(f.run({ operation: "stageFiles", files: [f.file] }), /INVALID_FILES/);
  assert.equal(f.counts().uploads, 1);
});
test("manual draft changes, active response and disabled send block submission", async () => {
  const f = fixture();
  await f.run();
  await f.run({ operation: "stageText", text: f.text });
  const request = { operation: "submitDraft", text: f.text, files: [], intentPersisted: true };
  f.editor.textContent += "manual";
  await assert.rejects(f.run(request), /DRAFT_CHANGED/);
  f.editor.textContent = f.text;
  f.send.disabled = true;
  await assert.rejects(f.run(request), /SEND_UNAVAILABLE/);
  f.send.disabled = false;
  f.stop();
  await assert.rejects(f.run(request), /DRAFT_CHANGED/);
  assert.equal(f.counts().sends, 0);
});
test("created chat exposes only an unconfirmed exact native candidate for canonical reconciliation", async () => {
  const f = fixture();
  await f.run();
  await f.run({ operation: "stageText", text: f.text });
  await f.run({ operation: "submitDraft", text: f.text, files: [], intentPersisted: true });
  await assert.rejects(f.run({ operation: "inspectCreatedChat" }), /CREATION_UNCONFIRMED/);
  f.summary.window = {
    route: { kind: "chatgpt-thread", threadId: key, pathname: `/c/${key}` },
    thread: { kind: "chatgpt", id: key, title: "private" },
  };
  const candidate = await f.run({ operation: "inspectCreatedChat" });
  assert.equal(candidate.conversationId, key);
  assert.equal(candidate.confirmed, false);
  assert.doesNotMatch(JSON.stringify(candidate), /private|title/);
  f.summary.window.route.threadId = `local-chatgpt:${key}`;
  f.summary.window.thread.id = `local-chatgpt:${key}`;
  const local = await f.run({ operation: "inspectCreatedChat" });
  assert.equal(local.conversationId, key);
  assert.equal(local.clientConversationId, `local-chatgpt:${key}`);
  f.summary.window.route.pathname = "/c/not-an-id";
  await assert.rejects(f.run({ operation: "inspectCreatedChat" }), /CREATION_UNCONFIRMED/);
});
test("a disappeared renderer lease or concurrent control never causes a send", async () => {
  const f = fixture();
  await assert.rejects(f.run({ operation: "submitDraft" }), /DRAFT_LEASE_MISSING/);
  f.runtime[Symbol.for("codex-web.native-composer")] = true;
  await assert.rejects(f.run(), /COMPOSER_BUSY/);
  assert.equal(f.counts().sends, 0);
});
test("creation confirmation requires one exact canonical prompt and attachment presence", async () => {
  const f = fixture();
  await f.run();
  await f.run({ operation: "stageText", text: f.text });
  await f.run({ operation: "submitDraft", text: f.text, files: [], intentPersisted: true });
  f.summary.window = {
    route: { kind: "chatgpt-thread", threadId: key, pathname: `/c/${key}` },
    thread: { kind: "chatgpt", id: key },
  };
  await assert.rejects(f.run({ operation: "confirmCreatedChat" }), /CREATION_UNCONFIRMED/);
  f.history.messages = [{ id: "user", role: "user", text: f.text, hasAttachments: false }];
  assert.equal((await f.run({ operation: "confirmCreatedChat" })).userMessageId, "user");
  f.history.messages[0].hasAttachments = true;
  await assert.rejects(f.run({ operation: "confirmCreatedChat" }), /CREATION_UNCONFIRMED/);
  f.history.messages[0].hasAttachments = false;
  f.history.messages.push({ ...f.history.messages[0], id: "another" });
  await assert.rejects(f.run({ operation: "confirmCreatedChat" }), /CREATION_UNCONFIRMED/);
  assert.equal(f.counts().sends, 1);
});
