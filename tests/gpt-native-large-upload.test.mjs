import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeStoredUpload } from "../ops/gpt-native/renderer-upload-session.mjs";
import { NativeStoredUploads, transferStoredUpload } from "../ops/gpt-native/stored-uploads.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
test("native disk staging accepts >25 MiB, resumes exact offsets and verifies checksum without renderer-sized payload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-large-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const piece = Buffer.alloc(1024 ** 2, 39),
    digest = createHash("sha256");
  for (let i = 0; i < 26; i++) digest.update(piece);
  const r = {
    key: randomUUID(),
    conversationId: randomUUID(),
    accountFingerprint: "1".repeat(64),
    file: {
      id: randomUUID(),
      name: "large.zip",
      mime: "application/zip",
      bytes: 26 * 1024 ** 2,
      sha256: digest.digest("hex"),
    },
  };
  let store = new NativeStoredUploads(root);
  for (let offset = 0; offset < r.file.bytes; offset += piece.length) {
    assert.equal(
      (await store.append({ ...r, offset, base64: piece.toString("base64") })).offset,
      offset + piece.length,
    );
    if (!offset) {
      store = new NativeStoredUploads(root);
      assert.equal(
        (await store.append({ ...r, offset: 0, base64: piece.toString("base64") })).offset,
        piece.length,
      );
    }
  }
  const path = await store.verified(r);
  assert.equal((await readFile(path)).length, r.file.bytes);
  await assert.rejects(store.verified({ ...r, conversationId: randomUUID() }), /UPLOAD_CHANGED/);
  await assert.rejects(
    store.verified({ ...r, accountFingerprint: "2".repeat(64) }),
    /UPLOAD_CHANGED/,
  );
  await writeFile(path, Buffer.alloc(r.file.bytes));
  await assert.rejects(store.verified(r), /UPLOAD_CHANGED/);
  await store.clear(r);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});
test("native stored upload binds authenticated create/process and keeps signed capability out of result", async () => {
  const principal = { accountId: "a", userId: "u", authenticatedUserId: "u" },
    fingerprint = hash(JSON.stringify(Object.values(principal))),
    calls = [];
  const m = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: principal }) } },
    kWt: {
      postResponse: async (path, o) => {
        assert.deepEqual(o.expectedIdentity, { accountId: "a", userId: "u" });
        assert.equal(o.retry, false);
        o.assertRequestCurrent();
        assert.throws(o.assertRequestCurrent, /REPLAY/);
        calls.push(path);
        return path === "/files"
          ? Response.json({
              file_id: "file-large",
              upload_url: "https://store.oaiusercontent.com/blob?sig=secret",
            })
          : new Response('{"event":"file.processing.file_ready"}\n');
      },
    },
  };
  const r = {
    accountFingerprint: fingerprint,
    file: { name: "large.pdf", mime: "application/pdf", bytes: 512 * 1024 ** 2 },
  };
  const read = async () => ({ accountFingerprint: fingerprint }),
    load = async () => m,
    runtime = { crypto: webcrypto };
  const prepared = await nativeStoredUpload(
    { ...r, operation: "prepareStoredUpload" },
    read,
    load,
    runtime,
  );
  assert.equal(prepared.nativeId, "file-large");
  const result = await nativeStoredUpload(
    { ...r, operation: "finishStoredUpload", nativeId: prepared.nativeId },
    read,
    load,
    runtime,
  );
  assert.equal(result.size, r.file.bytes);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(calls.length, 2);
  await assert.rejects(
    nativeStoredUpload(
      { ...r, file: { ...r.file, bytes: r.file.bytes + 1 }, operation: "prepareStoredUpload" },
      read,
      load,
      runtime,
    ),
    /INVALID_UPLOAD/,
  );
});
test("supervisor refuses untrusted storage before opening a file or network request", async () => {
  const reader = { prepareStoredUpload: async () => ({ url: "https://evil.example/file?sig=x" }) };
  await assert.rejects(
    transferStoredUpload(reader, { file: { bytes: 1 } }, "/no-such-file"),
    /UNSUPPORTED_UPLOAD_TARGET/,
  );
});
