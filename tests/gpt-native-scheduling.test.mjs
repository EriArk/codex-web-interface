import assert from "node:assert/strict";
import test from "node:test";
import { NativeGptReadClient } from "../apps/hub/dist/gpt-native.js";

test("native status bypasses a pending renderer read; mutations remain serialized", async () => {
  const client = new NativeGptReadClient(
    { socketPath: "/private/adapter.sock", userId: "10000000-0000-4000-8000-000000000001" },
    () => {},
  );
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  client.request = async (input) => {
    calls.push(input.operation);
    if (input.operation === "readConversationGraph") return blocked;
    if (input.operation === "status")
      return {
        instanceId: "10000000-0000-4000-8000-000000000002",
        manual: false,
        busy: true,
        writesEnabled: true,
      };
    return {};
  };
  const history = client.call({ operation: "readConversationGraph" });
  const send = client.call({ operation: "dispatchText" });
  let status;
  const heartbeat = client.status().then((value) => {
    status = value;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status?.busy, true, "heartbeat must finish before history is released");
    assert.equal(calls.includes("dispatchText"), false, "writer still waits for renderer");
  } finally {
    release({});
    await Promise.all([history, send, heartbeat]);
  }
  assert.equal(calls.filter((operation) => operation === "dispatchText").length, 1);
});
