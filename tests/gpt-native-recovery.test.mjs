import assert from "node:assert/strict";
import test from "node:test";
import { nativeRecoveryBinding } from "../ops/gpt/native-recovery.mjs";

const owner = "00000000-0000-4000-8000-000000000001";
const member = "00000000-0000-4000-8000-000000000002";
const config = { userId: owner, password: "testpass" };
test("member recovery retains only its own provisioned native endpoint", () => {
  const binding = {
    legacy: false,
    native: true,
    userId: member,
    host: "codex-web-gpt-" + member,
    password: "personal",
    gatewayPort: 9010,
  };
  assert.equal(nativeRecoveryBinding(binding, "native", config), binding);
  assert.equal(nativeRecoveryBinding(binding, null, config), binding);
  assert.equal(nativeRecoveryBinding(binding, "other", config), null);
});
test("native recovery keeps browser selection unchanged and requires exact provisioned owner", () => {
  const binding = { legacy: true, userId: owner };
  assert.equal(nativeRecoveryBinding(binding, null, config), binding);
  assert.deepEqual(nativeRecoveryBinding(binding, "native", config), {
    ...binding,
    native: true,
    host: "codex-web-gpt-native-lab",
    password: "testpass",
  });
  for (const denied of [
    null,
    { legacy: true, userId: member },
    { legacy: false, userId: owner },
    { legacy: true },
  ])
    assert.equal(nativeRecoveryBinding(denied, "native", config), null);
  for (const bad of [
    {},
    { ...config, password: "" },
    { ...config, userId: "owner" },
    { ...config, password: "testpass-more" },
  ])
    assert.equal(nativeRecoveryBinding(binding, "native", bad), null);
  for (const runtime of ["other", "native&host=localhost", "http://localhost"])
    assert.equal(nativeRecoveryBinding(binding, runtime, config), null);
});
