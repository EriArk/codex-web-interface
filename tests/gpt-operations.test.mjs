import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  GptOperations,
  operationBaseline,
  operationConfirmation,
} from "../apps/hub/dist/gpt-operations.js";
import { gptVersion, gptVersions } from "../apps/hub/dist/gpt-versions.js";
import { Store } from "../apps/hub/dist/store.js";

const node = (id, parent, role, text, channel = "final", status = "finished_successfully") => ({
  id,
  parent,
  message: {
    id,
    author: { role },
    content: { content_type: "text", parts: [text] },
    channel,
    status,
  },
});
const original = () => ({
  current_node: "a",
  mapping: { u: node("u", null, "user", "Original"), a: node("a", "u", "assistant", "Old answer") },
});
const input = {
  nativeId: "chat",
  messageId: "u",
  currentNode: "a",
  action: "edit",
  text: "Edited",
  model: "Latest",
  effort: "2",
};

test("manual branch recovery cannot release the writer before the native call returns", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController();
  const entered = Promise.withResolvers(),
    response = Promise.withResolvers();
  const service = new GptOperations(
    store,
    async (path) => {
      if (path === "/active") return {};
      if (path === "/native-features") return { ready: true };
      if (path === "/settings") return { model: "Latest", effort: "2" };
      if (path.startsWith("/conversation")) return original();
      if (path === "/native-operation") {
        entered.resolve();
        return response.promise;
      }
      return {};
    },
    () => true,
    () => {},
    controller.signal,
  );
  const id = randomUUID();
  try {
    service.start(id, input);
    await entered.promise;
    assert.equal(service.list().items[0].state, "running");
    assert.equal(await service.confirm(id), false);
    await assert.rejects(service.checked(id), /ещё выполняется/);
    assert.throws(() => service.start(randomUUID(), input), /Сначала/);
    response.reject(Error("lost acknowledgement"));
    await service.close();
    assert.equal(service.list().items[0].state, "unknown");
    await service.checked(id);
    assert.equal(service.blocked(), false);
  } finally {
    response.reject(Error("cleanup"));
    controller.abort();
    await service.close();
    store.close();
  }
});
test("native edit confirmation requires exact current branch, files and a new public completed answer", () => {
  const source = original(),
    baseline = operationBaseline(source, input);
  assert.throws(() => operationBaseline(source, { ...input, currentNode: "other" }));
  assert.equal(operationConfirmation(source, input, baseline), false);
  source.mapping.u2 = node("u2", null, "user", "Edited");
  source.mapping.thought = node("thought", "u2", "assistant", "HIDDEN", "analysis");
  source.current_node = "thought";
  assert.equal(operationConfirmation(source, input, baseline), false);
  source.mapping.a2 = node("a2", "thought", "assistant", "New answer");
  source.current_node = "a2";
  assert.equal(operationConfirmation(source, input, baseline), true);
  source.mapping.u2.message.content.parts = ["Different"];
  assert.equal(operationConfirmation(source, input, baseline), false);
  source.mapping.u2.message.content.parts = ["Edited"];
  source.mapping.u3 = node("u3", "a2", "user", "Another turn");
  source.current_node = "u3";
  assert.equal(operationConfirmation(source, input, baseline), false);
});
test("native regenerate never accepts the old response, hidden completion or another user", () => {
  const source = original(),
    value = { ...input, action: "regenerate", messageId: "a", text: "" },
    baseline = operationBaseline(source, value);
  assert.equal(operationConfirmation(source, value, baseline), false);
  source.mapping.a2 = node("a2", "u", "assistant", "New answer");
  source.current_node = "a2";
  assert.equal(operationConfirmation(source, value, baseline), true);
  source.mapping.a2.message.channel = "analysis";
  assert.equal(operationConfirmation(source, value, baseline), false);
});
test("version previews stay on their message family and a fork requires preserved native context", () => {
  const source = original();
  source.mapping.old = node("old", null, "user", "Older version");
  source.mapping.oldAnswer = node("oldAnswer", "old", "assistant", "Older answer");
  assert.deepEqual(
    gptVersions(source, "chat", "u").items.map((v) => v.messageId),
    ["u", "old"],
  );
  assert.throws(() => gptVersion(source, "chat", "a", "oldAnswer"), /Версия/);
  assert.equal(gptVersion(source, "chat", "u", "old").messages.at(-1).text, "Older version");
  const value = { ...input, action: "fork", targetMessageId: "old", text: "Continue here" },
    baseline = operationBaseline(source, value);
  const copy = {
    current_node: "newAnswer",
    mapping: {
      old: source.mapping.old,
      oldAnswer: source.mapping.oldAnswer,
      newUser: node("newUser", "oldAnswer", "user", "Continue here"),
      newAnswer: node("newAnswer", "newUser", "assistant", "Continued"),
    },
  };
  copy.mapping.newUser.message.create_time = Date.now() / 1000;
  assert.equal(operationConfirmation(copy, value, baseline), true);
  copy.mapping.old.message.content.parts = ["Changed context"];
  assert.equal(operationConfirmation(copy, value, baseline), false);
});
test("lost native operation receipt and process reconstruction never replay a click", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController(),
    calls = [];
  const source = original();
  const json = async (path, body) => {
    calls.push({ path, body });
    if (path === "/active") return {};
    if (path === "/settings") return { model: "Latest", effort: "2" };
    if (path.startsWith("/conversation")) return structuredClone(source);
    if (path === "/bridge/sessions/select") return { ok: true };
    if (path === "/native-operation") throw Error("lost response SECRET");
    if (path === "/native-features") return { ready: true, generating: false };
    throw Error(path);
  };
  let operations = new GptOperations(
    store,
    json,
    () => true,
    () => {},
    controller.signal,
  );
  const id = randomUUID();
  operations.start(id, input);
  await operations.close();
  assert.equal(operations.list().items[0].state, "unknown");
  assert.equal(operations.blocked(), true);
  assert.throws(() => operations.start(randomUUID(), input), /Сначала/);
  operations = new GptOperations(
    store,
    json,
    () => true,
    () => {},
    controller.signal,
  );
  assert.deepEqual(operations.start(id, input), { id });
  assert.throws(() => operations.start(id, { ...input, text: "Changed" }), /другим/);
  assert.equal(await operations.confirm(id), false);
  assert.equal(calls.filter((c) => c.path === "/native-operation").length, 1);
  assert.doesNotMatch(JSON.stringify(operations.list()), /SECRET|fingerprint|baseline/);
  source.mapping.u2 = node("u2", null, "user", "Edited");
  source.mapping.a2 = node("a2", "u2", "assistant", "New answer");
  source.current_node = "a2";
  assert.equal(await operations.confirm(id), true);
  assert.equal(operations.blocked(), false);
  assert.equal(calls.filter((c) => c.path === "/native-operation").length, 1);
  controller.abort();
  store.close();
});
test("pre-dispatch failures preserve text and release the writer", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController();
  const operations = new GptOperations(
    store,
    async (path) => (path === "/active" ? {} : { ...original(), current_node: "changed" }),
    () => true,
    () => {},
    controller.signal,
  );
  operations.start(randomUUID(), input);
  await operations.close();
  assert.equal(operations.list().items[0].state, "failed");
  assert.equal(operations.list().items[0].text, "Edited");
  assert.equal(operations.blocked(), false);
  controller.abort();
  store.close();
});
