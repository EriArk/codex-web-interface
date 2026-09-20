import assert from "node:assert/strict";
import test from "node:test";
import { NativeGptReadClient } from "../apps/hub/dist/gpt-native.js";
import { NativeGptProvider } from "../apps/hub/dist/gpt-native-provider.js";

test("interactive calls skip queued reads, coalesce duplicates and preserve mutation order", async () => {
  const client = new NativeGptReadClient(
    { socketPath: "/private/adapter.sock", userId: "10000000-0000-4000-8000-000000000001" },
    () => {},
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  client.request = async (input) => {
    calls.push(input.operation + (input.id ?? ""));
    if (input.id === "first") await gate;
    return {};
  };
  const tasks = [client.call({ operation: "readCatalog", id: "first" })];
  tasks.push(client.call({ operation: "readConversationGraph", id: "a" }));
  tasks.push(client.call({ operation: "readConversationGraph", id: "a" }));
  tasks.push(client.call({ operation: "prepareDispatch" }));
  tasks.push(client.call({ operation: "libraryMutation" }));
  tasks.push(client.call({ operation: "dispatchText" }));
  tasks.push(client.call({ operation: "readConversationGraph", id: "a" }));
  release();
  await Promise.all(tasks);
  assert.deepEqual(calls, [
    "readCatalogfirst",
    "prepareDispatch",
    "readConversationGrapha",
    "libraryMutation",
    "dispatchText",
    "readConversationGrapha",
  ]);
});

test("readiness shares model verification and invalidates it on native restart or manual mode", async () => {
  let instanceId = "one",
    manual = false,
    models = 0;
  const provider = new NativeGptProvider({
    client: {
      status: async () => ({ instanceId, manual }),
      models: async () => {
        models++;
        return { versions: [] };
      },
    },
  });
  await Promise.all([provider.connection(), provider.connection()]);
  await provider.connection();
  assert.equal(models, 1);
  instanceId = "two";
  await provider.connection();
  assert.equal(models, 2);
  manual = true;
  assert.equal((await provider.connection()).canSend, false);
  manual = false;
  await provider.connection();
  assert.equal(models, 3);
});

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
