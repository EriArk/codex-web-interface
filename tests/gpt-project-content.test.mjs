import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { GptProjectContent, gptProjectInput } from "../apps/hub/dist/gpt-project-content.js";
import { Store } from "../apps/hub/dist/store.js";
import { projectFields, projectRevision } from "../ops/gpt/browser-project-content.mjs";

const project = () => ({
  id: "g-p-fixture",
  name: "Fixture",
  instructions: "Original",
  revision: "a".repeat(64),
  canWrite: true,
  files: [],
});
const input = {
  projectId: "g-p-fixture",
  revision: "a".repeat(64),
  action: "instructions",
  text: "Changed",
};

test("manual project recovery cannot release an in-flight native mutation", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController();
  const entered = Promise.withResolvers(),
    response = Promise.withResolvers();
  const service = new GptProjectContent(
    store,
    async (path) => {
      if (path === "/active") return {};
      if (path.startsWith("/project-content?")) return project();
      entered.resolve();
      return response.promise;
    },
    () => true,
    () => {},
    controller.signal,
  );
  const id = randomUUID();
  try {
    service.start(id, input);
    await entered.promise;
    assert.equal(service.list(input.projectId)[0].state, "pending");
    assert.equal(await service.check(id), false);
    await assert.rejects(service.checked(id), /ещё выполняется/);
    assert.throws(() => service.start(randomUUID(), input), /Сначала/);
    response.reject(Error("lost acknowledgement"));
    await service.close();
    assert.equal(service.list(input.projectId)[0].state, "unknown");
    await service.checked(id);
    assert.equal(service.blocked(), false);
  } finally {
    response.reject(Error("cleanup"));
    controller.abort();
    await service.close();
    store.close();
  }
});
test("native project projection drops account metadata and changes revision with permissions or files", () => {
  const raw = {
    gizmo: {
      id: "g-p-fixture",
      instructions: "Original",
      display: { name: "Fixture", emoji: null, theme: "blue" },
      current_user_permission: { can_write: true },
      author: { password: "SECRET" },
    },
    files: [{ file_id: "file-a", name: "a.txt", size: 12, location: "https://private/SECRET" }],
  };
  const fields = projectFields(raw);
  assert.doesNotMatch(JSON.stringify(fields), /SECRET|password|location/);
  assert.notEqual(projectRevision(fields), projectRevision({ ...fields, canWrite: false }));
  assert.notEqual(projectRevision(fields), projectRevision({ ...fields, files: [] }));
  assert.throws(() => projectFields({ ...raw, files: [{ file_id: "../escape", name: "bad" }] }));
  assert.throws(() => gptProjectInput.parse({ ...input, extra: "raw command" }));
});
test("project lost acknowledgement reconciles canonical instructions without replay", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController();
  let current = project(),
    clicks = 0;
  const json = async (path) => {
    if (path === "/active") return {};
    if (path.startsWith("/project-content?")) return current;
    if (path === "/project-content") {
      clicks++;
      current = { ...current, instructions: "Changed" };
      throw Error("SECRET lost ack");
    }
    throw Error(path);
  };
  let service = new GptProjectContent(
      store,
      json,
      () => true,
      () => {
        throw Error("unused");
      },
      controller.signal,
    ),
    id = randomUUID();
  service.start(id, input);
  await service.close();
  assert.equal(service.list(input.projectId)[0].state, "unknown");
  assert.equal(service.blocked(), true);
  service = new GptProjectContent(
    store,
    json,
    () => true,
    () => {
      throw Error("unused");
    },
    controller.signal,
  );
  service.start(id, input);
  assert.throws(() => service.start(id, { ...input, text: "Other" }));
  assert.equal(clicks, 1);
  assert.equal(await service.check(id), true);
  assert.equal(service.blocked(), false);
  assert.equal(clicks, 1);
  assert.doesNotMatch(JSON.stringify(service.list(input.projectId)), /SECRET|fingerprint|baseline/);
  controller.abort();
  store.close();
});
test("stale native project revision fails before any mutation and preserves input", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController();
  let clicks = 0;
  const service = new GptProjectContent(
    store,
    async (path) => {
      if (path === "/active") return {};
      if (path.startsWith("/project-content?")) return { ...project(), revision: "b".repeat(64) };
      clicks++;
      return {};
    },
    () => true,
    () => {},
    controller.signal,
  );
  service.start(randomUUID(), input);
  await service.close();
  assert.equal(clicks, 0);
  assert.equal(service.list(input.projectId)[0].state, "failed");
  assert.equal(service.blocked(), false);
  controller.abort();
  store.close();
});
test("project upload confirmation requires a new exact name and size, not an old or partial file", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController();
  const current = { ...project(), files: [{ id: "file-old", name: "a.txt", bytes: 12 }] };
  const service = new GptProjectContent(
    store,
    async (path) => {
      if (path === "/active") return {};
      if (path.startsWith("/project-content?")) return current;
      throw Error("lost ack");
    },
    () => true,
    () => ({ id: "upload", name: "a.txt", bytes: 12, base64: "YQ==" }),
    controller.signal,
  );
  const id = randomUUID();
  service.start(id, {
    projectId: input.projectId,
    revision: input.revision,
    action: "upload",
    uploadId: randomUUID(),
  });
  await service.close();
  assert.equal(await service.check(id), false);
  current.files.push({ id: "file-new", name: "a.txt", bytes: 1 });
  assert.equal(await service.check(id), false);
  current.files[1].bytes = 12;
  assert.equal(await service.check(id), true);
  controller.abort();
  store.close();
});
