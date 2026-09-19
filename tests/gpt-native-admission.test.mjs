import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredNativeGpt } from "../apps/hub/dist/gpt-native-config.js";
import { NativeDispatchReceipts } from "../ops/gpt-native/dispatch-receipts.mjs";
import { NativeProjectReceipts } from "../ops/gpt-native/project-receipts.mjs";

const accountFingerprint = "a".repeat(64);
test("host native binding is lazy, fail-closed and does not prevent Codex startup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "native-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userId = randomUUID(),
    config = { nativeGpt: { userId, accountFingerprint, socketPath: join(root, "adapter.sock") } };
  const w = configuredNativeGpt(config, () => {});
  assert.equal(w.conversations.has(randomUUID()), true);
  assert.equal(w.conversations.has("arbitrary"), false);
  await assert.rejects(w.client.status());
  writeFileSync(
    join(root, "binding.json"),
    JSON.stringify({ userId: randomUUID(), accountFingerprint, build: "26.915.31945" }),
    { mode: 0o600 },
  );
  await assert.rejects(w.client.status(), /BINDING_MISMATCH/);
  assert.equal(
    configuredNativeGpt({}, () => {}),
    undefined,
  );
});
test("owner admission keeps bound account and idempotent receipts instead of disposable ID lists", (t) => {
  const root = mkdtempSync(join(tmpdir(), "native-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    path: join(root, "db"),
    userId: randomUUID(),
    accountFingerprint,
    conversationIds: [],
    ownerMode: true,
  };
  const d = new NativeDispatchReceipts(options);
  t.after(() => d.close());
  const r = {
    key: randomUUID(),
    conversationId: randomUUID(),
    userMessageId: randomUUID(),
    text: "User message",
    versionId: "latest",
    presetId: 1,
  };
  d.validate(r);
  d.validate({ ...r, conversationId: null });
  assert.throws(() => d.validate({ ...r, conversationId: "invalid" }));
  assert.throws(() => new NativeDispatchReceipts({ ...options, userId: randomUUID() }), /BINDING/);
  const p = new NativeProjectReceipts(d);
  p.admit({ key: randomUUID(), projectId: "g-p-example" });
  assert.throws(() => p.admit({ key: randomUUID(), projectId: "other" }));
});
