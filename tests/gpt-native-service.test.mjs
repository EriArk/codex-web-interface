import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeGptReadClient } from "../apps/hub/dist/gpt-native.js";
import { gptSandboxFiles } from "../apps/hub/dist/gpt-sandbox-files.js";
import { listenNative, NativeReadService } from "../ops/gpt-native/service.mjs";

const userId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000001";
const accountFingerprint = "a".repeat(64);
const text = "[result](sandbox:/mnt/data/proof.txt)";
const file = gptSandboxFiles(text, conversationId, "message").files[0];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "native-service-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [],
    state = { gate: Promise.resolve(), revoked: false, tamper: false };
  const reader = {
    readConversation: async (input) => {
      calls.push(input);
      await state.gate;
      return {
        conversationId,
        currentNode: "node",
        before: null,
        mediaResolved: false,
        messages: [
          {
            nodeId: "node",
            id: "message",
            role: "assistant",
            channel: "commentary",
            text,
            hasAttachments: false,
            createdAt: 1700000000,
            model: null,
            effort: null,
            complete: true,
          },
        ],
      };
    },
    readArtifact: async () => ({
      artifact: {
        id: file.id,
        conversationId,
        messageId: "message",
        path: "/mnt/data/proof.txt",
        name: file.name,
        mime: file.mime,
        image: false,
      },
      bytes: 5,
      sha256: createHash("sha256").update("proof").digest("hex"),
      base64: Buffer.from(state.tamper ? "wrong" : "proof").toString("base64"),
    }),
  };
  const config = { reader, userId, accountFingerprint, statePath: join(root, "manual.json") };
  const service = new NativeReadService(config);
  const socketPath = join(root, "adapter.sock");
  const server = await listenNative(service, socketPath);
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const client = new NativeGptReadClient({ socketPath, userId }, () => {
    if (state.revoked) throw Error("REVOKED");
  });
  return { root, config, service, client, state, calls, socketPath };
}

test("private native service exposes typed read projection and checksum-verified Hub files", async (t) => {
  const f = await fixture(t),
    page = await f.client.history(conversationId);
  assert.equal(page.items[0].phase, "commentary");
  assert.equal(page.items[0].files[0].id, file.id);
  assert.match(page.items[0].text, /\/api\/gpt\/native\/downloads\//);
  assert.equal(page.nextBefore, null);
  assert.equal(f.calls[0].accountFingerprint, accountFingerprint);
  const result = await f.client.download(conversationId, "message", file.id);
  assert.equal(result.bytes.toString(), "proof");
  f.state.tamper = true;
  await assert.rejects(f.client.download(conversationId, "message", file.id), /ARTIFACT_CHECKSUM/);
  assert.equal((await f.client.status()).writesEnabled, false);
});

test("native service denies other owners, arbitrary methods, credentials and account rebinding", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { userId: randomUUID(), operation: "readConversation", conversationId },
    { userId, operation: "send", text: "do not send" },
    { userId, operation: "constructor" },
    { userId, operation: "readConversation", conversationId, accountFingerprint: "b".repeat(64) },
    { userId, operation: "readArtifact", url: "https://evil.example" },
  ])
    await assert.rejects(f.service.request(input), /NATIVE_(WRONG_OWNER|INVALID_REQUEST)/);
  assert.equal(f.calls.length, 0);
  const stranger = new NativeGptReadClient(
    { socketPath: f.socketPath, userId: randomUUID() },
    () => {},
  );
  await assert.rejects(stranger.history(conversationId), /WRONG_OWNER/);
});

test("active reads exclude manual takeover; multiple manual leases persist across process restart", async (t) => {
  const f = await fixture(t);
  let finish;
  f.state.gate = new Promise((resolve) => {
    finish = resolve;
  });
  const reading = f.service.request({ userId, operation: "readConversation", conversationId });
  const first = randomUUID(),
    second = randomUUID();
  await assert.rejects(f.client.manual("beginManual", first), /BUSY/);
  finish();
  await reading;
  await f.client.manual("beginManual", first);
  await f.client.manual("beginManual", second);
  await f.client.manual("beginManual", first); // Idempotent acknowledgement recovery.
  await assert.rejects(f.client.history(conversationId), /MANUAL_RECOVERY/);
  const restored = new NativeReadService(f.config);
  assert.equal((await restored.request({ userId, operation: "status" })).manual, true);
  await restored.request({ userId, operation: "endManual", leaseId: first });
  await assert.rejects(
    restored.request({ userId, operation: "readConversation", conversationId }),
    /MANUAL_RECOVERY/,
  );
  await restored.request({ userId, operation: "endManual", leaseId: second });
  assert.equal((await restored.request({ userId, operation: "status" })).manual, false);
});

test("explicit recovery clears abandoned leases; account bindings and unsafe sockets never fall back", async (t) => {
  const f = await fixture(t);
  await f.client.manual("beginManual", randomUUID());
  await f.client.manual("resumeManual");
  assert.equal((await f.client.status()).manual, false);
  assert.throws(
    () => new NativeReadService({ ...f.config, userId: randomUUID() }),
    /INVALID_RECOVERY_STATE/,
  );
  await chmod(f.socketPath, 0o666);
  await assert.rejects(f.client.history(conversationId), /UNSAFE_SOCKET/);
});

test("revocation during a native read discards its response", async (t) => {
  const f = await fixture(t);
  f.config.reader.readConversation = async () => {
    f.state.revoked = true;
    return {};
  };
  await assert.rejects(f.client.history(conversationId), /REVOKED/);
});
