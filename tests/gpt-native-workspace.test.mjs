import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import test from "node:test";
import { nativeRead } from "../ops/gpt-native/renderer-read.mjs";
import { nativeUploadStage } from "../ops/gpt-native/renderer-upload-stage.mjs";

const runtime = {
  crypto: webcrypto,
  electronBridge: { getSentryInitOptions: () => ({ appVersion: "26.915.31945" }) },
};
function fixture() {
  const account = { accountId: "a", userId: "u" },
    calls = [];
  let raw = {};
  const m = {
    M9: {
      accessInputs: { readAccountInfo: async () => ({ status: "ready", data: { ...account } }) },
    },
    kWt: {
      safeGet: async (route, options) => {
        calls.push({ route, options });
        return raw;
      },
    },
  };
  const read = (r) => nativeRead(r, async () => m, runtime);
  return {
    read,
    account,
    calls,
    set: (value) => {
      raw = value;
    },
    binding: async () => (await read({ operation: "inspectAccount" })).accountFingerprint,
  };
}
test("native project pages keep exact scope, cursor and native principal", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding(),
    id = "g-p-example";
  f.set({
    items: [
      {
        gizmo: {
          gizmo: {
            id,
            display: { name: "Project", emoji: "book", theme: "blue" },
            instructions: "rules",
            current_user_permission: { can_write: true },
          },
        },
        conversations: {
          items: [{ id: randomUUID(), title: "Chat", update_time: "2026-09-19T00:00:00Z" }],
        },
      },
    ],
    cursor: "next",
  });
  const page = await f.read({ operation: "readProjects", accountFingerprint, cursor: "previous" });
  assert.equal(page.items[0].id, id);
  assert.equal(page.items[0].conversations[0].projectId, id);
  assert.equal(page.cursor, "next");
  assert.equal(f.calls[0].options.parameters.query.cursor, "previous");
  assert.deepEqual(f.calls[0].options.expectedIdentity, { accountId: "a", userId: "u" });
  f.set({ gizmo: { id: "g-p-other", display: { name: "Other" } } });
  await assert.rejects(
    f.read({ operation: "readProject", projectId: id, accountFingerprint }),
    /PROJECT_MISMATCH/,
  );
  f.account.accountId = "different";
  await assert.rejects(
    f.read({ operation: "readProjects", accountFingerprint }),
    /ACCOUNT_MISMATCH/,
  );
});
test("native pins expose only normalized public fields and archive reads retain their filter", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding(),
    id = randomUUID();
  f.set({
    items: [
      {
        item_type: "conversation",
        item: { id, title: "Pinned", update_time: "2026-09-19T00:00:00Z", private: "SECRET" },
      },
    ],
  });
  const pins = await f.read({ operation: "readPins", accountFingerprint });
  assert.equal(pins.items[0].id, id);
  assert.doesNotMatch(JSON.stringify(pins), /SECRET/);
  assert.equal(f.calls.at(-1).route, "/pins");
  f.set({ items: [] });
  await f.read({ operation: "readCatalog", accountFingerprint, offset: 20, archived: true });
  assert.equal(f.calls.at(-1).options.parameters.query.is_archived, true);
});
test("public graph preserves alternate branches and image results without hidden content or arbitrary metadata", async () => {
  const f = fixture(),
    accountFingerprint = await f.binding(),
    conversationId = randomUUID();
  const message = (id, role, channel, text, metadata = {}) => ({
    id,
    author: { role },
    channel,
    content: { content_type: "text", parts: [text] },
    metadata,
    status: "finished_successfully",
  });
  f.set({
    conversation_id: conversationId,
    current_node: "final",
    mapping: {
      root: { id: "root", parent: null, children: ["secret"], message: null },
      secret: {
        id: "secret",
        parent: "root",
        children: ["final", "alternate"],
        message: message("secret", "assistant", "analysis", "PRIVATE", { diagnostic: "PRIVATE" }),
      },
      final: {
        id: "final",
        parent: "secret",
        children: [],
        message: message("final", "assistant", "final", "Visible", {
          secret: "PRIVATE",
          content_references: [
            {
              type: "url",
              matched_text: "\ue200url\ue201",
              item: { url: "https://example.com/", title: "Example", secret: "PRIVATE" },
            },
          ],
        }),
      },
      alternate: {
        id: "alternate",
        parent: "secret",
        children: [],
        message: message("alternate", "assistant", "final", "Alternative"),
      },
    },
  });
  const graph = await f.read({
    operation: "readConversationGraph",
    conversationId,
    accountFingerprint,
  });
  assert.equal(graph.mapping.secret.message, null);
  assert.equal(graph.mapping.alternate.message.content.parts[0], "Alternative");
  assert.equal(graph.mapping.final.parent, "secret");
  assert.ok(!JSON.stringify(graph).includes("PRIVATE"));
  assert.equal(
    graph.mapping.final.message.metadata.content_references[0].item.url,
    "https://example.com/",
  );
});
test("data-only upload staging rejects order, identity and overflow; cleared buffers cannot be resumed", () => {
  const r = { atob, setTimeout: () => 1, clearTimeout: () => {} },
    stageId = randomUUID(),
    accountFingerprint = "a".repeat(64),
    sha256 = "b".repeat(64);
  nativeUploadStage({ operation: "beginUpload", stageId, accountFingerprint, sha256, bytes: 5 }, r);
  assert.throws(
    () =>
      nativeUploadStage(
        { operation: "beginUpload", stageId: randomUUID(), accountFingerprint, sha256, bytes: 5 },
        r,
      ),
    /BUSY/,
  );
  const part = {
    operation: "appendUpload",
    stageId,
    accountFingerprint,
    offset: 0,
    base64: Buffer.from("abc").toString("base64"),
  };
  assert.throws(
    () => nativeUploadStage({ ...part, accountFingerprint: "c".repeat(64) }, r),
    /INVALID/,
  );
  assert.equal(nativeUploadStage(part, r).offset, 3);
  assert.throws(() => nativeUploadStage(part, r), /INVALID/);
  assert.throws(() => nativeUploadStage({ ...part, offset: 3 }, r), /INVALID/);
  nativeUploadStage({ operation: "clearUpload", stageId }, r);
  assert.throws(() => nativeUploadStage({ ...part, offset: 3 }, r), /INVALID/);
});
