import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import test from "node:test";
import { nativeDictation } from "../ops/gpt-native/renderer-dictation.mjs";

const hash = (x) => createHash("sha256").update(x).digest("hex");
function fixture() {
  const identity = { accountId: "account", userId: "user" },
    fp = hash(JSON.stringify(["account", "user", null])),
    bytes = Buffer.from("RIFF sample audio"),
    stageId = randomUUID(),
    sha256 = hash(bytes),
    r = { stageId, bytes: bytes.length, sha256, mime: "audio/wav", accountFingerprint: fp };
  const runtime = {
      crypto: webcrypto,
      clearTimeout() {},
      [Symbol.for("codex-web.native-upload-bytes")]: {
        stageId,
        bytes,
        offset: bytes.length,
        sha256,
        accountFingerprint: fp,
      },
    },
    calls = [];
  const mod = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: identity }) } },
    kWt: {
      getRequestTarget: (route) => {
        assert.equal(route, "/transcribe");
        return { url: route, headers: {} };
      },
    },
    $rn: {
      getInstance: () => ({
        fetch: async (url, opts) => {
          opts.assertRequestCurrent();
          assert.deepEqual(opts.expectedIdentity, { accountId: "account", userId: "user" });
          calls.push(opts);
          return new Response(JSON.stringify({ text: "Проверка голоса" }));
        },
      }),
    },
  };
  return {
    r,
    runtime,
    calls,
    identity,
    read: async () => ({ accountFingerprint: fp }),
    load: async () => mod,
  };
}
test("native dictation uses account-bound transport without a chat mutation or automatic retry", async () => {
  const f = fixture();
  assert.deepEqual(await nativeDictation(f.r, f.read, f.load, f.runtime), {
    text: "Проверка голоса",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].retry, false);
  assert.match(new TextDecoder().decode(f.calls[0].body), /name="file"; filename="dictation.wav"/);
  assert.throws(() => f.calls[0].assertRequestCurrent(), /REPLAY/);
  assert.equal(f.runtime[Symbol.for("codex-web.native-upload-bytes")], undefined);
});
test("dictation rejects account/hash/type mismatches before transcription", async () => {
  for (const mode of ["account", "hash", "mime"]) {
    const f = fixture();
    if (mode === "account") f.identity.userId = "other";
    if (mode === "hash") f.runtime[Symbol.for("codex-web.native-upload-bytes")].bytes[0] = 0;
    if (mode === "mime") f.r.mime = "text/plain";
    await assert.rejects(
      nativeDictation(f.r, f.read, f.load, f.runtime),
      /ACCOUNT_CHANGED|UPLOAD_CHANGED|INVALID_AUDIO/,
    );
    assert.equal(f.calls.length, 0);
  }
});
