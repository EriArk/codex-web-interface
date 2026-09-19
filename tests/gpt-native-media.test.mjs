import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import test from "node:test";
import { nativeMedia } from "../ops/gpt-native/renderer-media.mjs";

const id = randomUUID(),
  messageId = randomUUID(),
  accountFingerprint = "a".repeat(64),
  fileId = "file-example";
function fixture() {
  const payload = new Uint8Array(2 * 1024 * 1024 + 31).map((_, i) => i % 251),
    runtime = { crypto: webcrypto, btoa: (s) => Buffer.from(s, "binary").toString("base64") };
  const state = { fingerprint: accountFingerprint, fetches: 0, cancelled: false };
  const read = async (r) =>
    r.operation === "inspectAccount"
      ? { accountFingerprint: state.fingerprint }
      : {
          conversation_id: id,
          current_node: messageId,
          mapping: {
            [messageId]: {
              id: messageId,
              parent: null,
              message: {
                id: messageId,
                metadata: {
                  attachments: [{ id: fileId, name: "large.zip", mime_type: "application/zip" }],
                },
                content: { parts: [] },
              },
            },
          },
        };
  const m = {
    M9: {
      accessInputs: {
        readAccountInfo: async () => ({ status: "ready", data: { accountId: "a", userId: "u" } }),
      },
    },
    kWt: { safeGet: async () => ({ download_url: "https://files.oaiusercontent.com/example" }) },
  };
  runtime.fetch = async (url, options) => {
    state.fetches++;
    assert.equal(options.credentials, "omit");
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(payload);
          c.close();
        },
        cancel() {
          state.cancelled = true;
        },
      }),
      { headers: { "content-length": String(payload.length), "content-type": "application/zip" } },
    );
  };
  const transferId = randomUUID(),
    input = { accountFingerprint, transferId, conversationId: id, messageId, fileId };
  const call = (operation, more = {}) =>
    nativeMedia(
      { ...input, operation, ...more },
      read,
      () => {},
      async () => m,
      runtime,
    );
  return { call, payload, state };
}
test("native media streams beyond one MiB using exact message identity and bounded checksummed chunks", async () => {
  const f = fixture(),
    opened = await f.call("openMedia");
  assert.equal(opened.bytes, f.payload.length);
  let offset = 0;
  const chunks = [];
  for (;;) {
    const p = await f.call("readMedia", { offset });
    const b = Buffer.from(p.base64, "base64");
    assert(b.length <= 262144);
    offset += b.length;
    assert.equal(offset, p.offset);
    assert.equal(
      p.sha256,
      Buffer.from(await webcrypto.subtle.digest("SHA-256", b)).toString("hex"),
    );
    chunks.push(b);
    if (p.done) break;
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(f.payload));
  assert.equal(f.state.fetches, 1);
  await assert.rejects(f.call("readMedia", { offset }), /TRANSFER_MISSING/);
});
test("native media rejects unrelated files and offsets, cancels transfers, and never follows account replacement", async () => {
  const f = fixture();
  await assert.rejects(f.call("openMedia", { fileId: "file-unrelated" }), /ARTIFACT_NOT_ON_BRANCH/);
  assert.equal(f.state.fetches, 0);
  await f.call("openMedia");
  await assert.rejects(f.call("readMedia", { offset: 10 }), /TRANSFER_OFFSET/);
  f.state.fingerprint = "b".repeat(64);
  await assert.rejects(f.call("readMedia", { offset: 0 }), /ACCOUNT_CHANGED/);
  f.state.fingerprint = accountFingerprint;
  await f.call("closeMedia");
  await assert.rejects(f.call("readMedia", { offset: 0 }), /TRANSFER_MISSING/);
});
