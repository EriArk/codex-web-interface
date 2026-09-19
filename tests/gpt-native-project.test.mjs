import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptProjectContent } from "../apps/hub/dist/gpt-project-content.js";
import { Store } from "../apps/hub/dist/store.js";
import { NativeDispatchReceipts } from "../ops/gpt-native/dispatch-receipts.mjs";
import { NativeProjectReceipts } from "../ops/gpt-native/project-receipts.mjs";
import { nativeProject } from "../ops/gpt-native/renderer-project.mjs";
import { nativeStoredUpload } from "../ops/gpt-native/renderer-upload-session.mjs";
import { NativeStoredUploads } from "../ops/gpt-native/stored-uploads.mjs";

const hash = (x) => createHash("sha256").update(x).digest("hex");
const projectId = "g-p-disposable",
  revision = "a".repeat(64),
  accountFingerprint = "b".repeat(64);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "native-project-"));
  chmodSync(root, 0o700);
  const dispatch = new NativeDispatchReceipts({
    path: join(root, "db"),
    userId: randomUUID(),
    accountFingerprint,
    conversationIds: [randomUUID()],
  });
  const receipts = new NativeProjectReceipts(dispatch, [projectId]);
  t.after(() => {
    dispatch.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { dispatch, receipts, root };
}
test("project uploads confirm exact native ID after lost acknowledgement, never filename alone or replay", async (t) => {
  const f = fixture(t),
    key = randomUUID(),
    file = {
      id: randomUUID(),
      name: "same.pdf",
      bytes: 32 * 1024 ** 2,
      mime: "application/pdf",
      sha256: "d".repeat(64),
    };
  const request = { key, projectId, revision, action: "upload", file, accountFingerprint };
  let transfers = 0,
    writes = 0,
    available = false,
    files = [];
  const reader = {
    inspectProject: async () => {
      if (writes && !available) throw Error("offline");
      return { canWrite: true, revision, files };
    },
    mutateProject: async (r) => {
      writes++;
      assert.equal(r.uploaded.id, "file-exact");
      files = [{ id: "file-wrong", name: file.name, bytes: file.bytes }];
      throw Error("lost ack");
    },
  };
  const transfer = async () => {
    transfers++;
    return { id: "file-exact", name: file.name, size: file.bytes, mimeType: file.mime };
  };
  assert.equal(
    (
      await f.receipts.execute(
        request,
        reader,
        { verified: async () => "/private/staged" },
        transfer,
      )
    ).state,
    "unknown",
  );
  assert.equal(f.dispatch.pending(), true);
  available = true;
  assert.equal((await f.receipts.check({ key, projectId }, reader)).state, "unknown");
  files.push({ id: "file-exact", name: file.name, bytes: file.bytes });
  assert.equal((await f.receipts.check({ key, projectId }, reader)).state, "completed");
  assert.equal(f.dispatch.pending(), false);
  await f.receipts.execute(request, reader, null, transfer);
  assert.equal(transfers, 1);
  assert.equal(writes, 1);
  await assert.rejects(
    f.receipts.execute({ ...request, revision: "c".repeat(64) }, reader, null, transfer),
    /KEY_CONFLICT/,
  );
  await assert.rejects(f.receipts.check({ key, projectId: "g-p-other" }, reader), /INVALID_CANARY/);
});
test("project revision conflicts are durable rejections with no native side effect", async (t) => {
  const f = fixture(t),
    r = {
      key: randomUUID(),
      projectId,
      revision,
      action: "instructions",
      text: "new",
      accountFingerprint,
    };
  let writes = 0;
  const reader = {
    inspectProject: async () => ({ canWrite: true, revision: "c".repeat(64), files: [] }),
    mutateProject: async () => {
      writes++;
    },
  };
  assert.equal((await f.receipts.execute(r, reader)).state, "rejected");
  assert.equal((await f.receipts.check(r, reader)).state, "rejected");
  assert.equal(writes, 0);
});
test("project disk chunks bind destination and support project images without relaxing chat staging", async (t) => {
  const f = fixture(t),
    uploads = new NativeStoredUploads(join(f.root, "uploads")),
    bytes = Buffer.from("image-fixture"),
    r = {
      key: randomUUID(),
      projectId,
      accountFingerprint,
      file: {
        id: randomUUID(),
        name: "image.png",
        mime: "image/png",
        bytes: bytes.length,
        sha256: hash(bytes),
      },
      offset: 0,
      base64: bytes.toString("base64"),
    };
  await uploads.append(r);
  await uploads.verified(r);
  await assert.rejects(uploads.append({ ...r, projectId: "g-p-other" }), /UPLOAD_CHANGED/);
  await assert.rejects(
    uploads.append({ ...r, projectId: undefined, conversationId: randomUUID() }),
    /INVALID_UPLOAD/,
  );
});
test("native project renderer preserves appearance, rejects stale revisions and removes by exact ID", async () => {
  const principal = { accountId: "a", userId: "u" },
    fingerprint = hash(JSON.stringify(["a", "u", null])),
    calls = [];
  const project = {
    id: projectId,
    name: "Name",
    instructions: "Rules",
    emoji: "book",
    theme: "blue",
    canWrite: true,
    files: [
      { id: "file-a", name: "same.txt", bytes: 1 },
      { id: "file-b", name: "same.txt", bytes: 1 },
    ],
  };
  const m = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: principal }) } },
    kWt: {
      getRequestTarget: (route, options) => {
        calls.push({ route, options });
        return { url: route, headers: {} };
      },
      getRequestBody: (o) => JSON.stringify(o.requestBody),
    },
    $rn: {
      getInstance: () => ({
        fetch: async (url, o) => {
          assert.equal(o.retry, false);
          assert.deepEqual(o.expectedIdentity, principal);
          o.assertRequestCurrent();
          assert.throws(o.assertRequestCurrent, /REPLAY_BLOCKED/);
          return new Response("{}", { status: 200 });
        },
      }),
    },
  };
  const runtime = {
    crypto: webcrypto,
    document: {
      querySelectorAll: (s) =>
        s.includes("textbox")
          ? [{ textContent: "", getClientRects: () => [1], closest: () => null }]
          : [],
    },
  };
  const read = async (r) =>
    r.operation === "inspectAccount" ? { accountFingerprint: fingerprint } : { ...project };
  const r = { operation: "inspectProject", projectId, accountFingerprint: fingerprint };
  const before = await nativeProject(r, read, async () => m, runtime);
  await nativeProject(
    {
      ...r,
      operation: "mutateProject",
      revision: before.revision,
      action: "instructions",
      text: "Changed",
    },
    read,
    async () => m,
    runtime,
  );
  assert.deepEqual(calls[0].options.requestBody, {
    name: "Name",
    instructions: "Changed",
    emoji: "book",
    theme: "blue",
  });
  await nativeProject(
    {
      ...r,
      operation: "mutateProject",
      revision: before.revision,
      action: "remove",
      fileId: "file-b",
      confirm: true,
    },
    read,
    async () => m,
    runtime,
  );
  assert.equal(calls[1].options.parameters.path.file_id, "file-b");
  project.instructions = "Owner edit";
  assert.deepEqual(
    await nativeProject(
      {
        ...r,
        operation: "mutateProject",
        revision: before.revision,
        action: "instructions",
        text: "Bad",
      },
      read,
      async () => m,
      runtime,
    ),
    { dispatched: false },
  );
  assert.equal(calls.length, 2);
});
test("project processing uses native gizmo pipeline and preserves exact library identity", async () => {
  const principal = { accountId: "a", userId: "u" },
    fingerprint = hash(JSON.stringify(["a", "u", null])),
    calls = [];
  const read = async () => ({ accountFingerprint: fingerprint });
  const m = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: principal }) } },
    kWt: {
      postResponse: async (route, o) => {
        calls.push({ route, o });
        o.assertRequestCurrent();
        assert.throws(o.assertRequestCurrent, /REPLAY_BLOCKED/);
        return new Response(
          JSON.stringify({
            event: "file.processing.file_ready",
            extra: { metadata_object_id: "file-library", library_file_name: "same.pdf" },
          }),
        );
      },
    },
  };
  const result = await nativeStoredUpload(
    {
      operation: "finishStoredUpload",
      projectId,
      accountFingerprint: fingerprint,
      nativeId: "file-source",
      file: { name: "same.pdf", mime: "application/pdf", bytes: 32 * 1024 ** 2 },
    },
    read,
    async () => m,
    { crypto: webcrypto },
  );
  assert.equal(result.libraryFileId, "file-library");
  assert.equal(result.id, "file-source");
  assert.equal(calls[0].o.requestBody.use_case, "gizmo");
  assert.equal(calls[0].o.requestBody.gizmo_id, projectId);
  assert.equal(calls[0].o.requestBody.entry_surface, "project_sources");
});
test("shared project service keeps native operation ownership and refuses blind dismissal", async () => {
  const store = new Store(":memory:"),
    controller = new AbortController(),
    key = randomUUID();
  let writes = 0,
    ready = false;
  const input = { projectId, revision, action: "instructions", text: "new" };
  const native = {
    read: async () => ({
      id: projectId,
      name: "Name",
      instructions: "old",
      files: [],
      revision,
      canWrite: true,
    }),
    execute: async () => {
      writes++;
      throw Error("lost ack");
    },
    check: async () => ({ state: ready ? "completed" : "unknown" }),
  };
  let service = new GptProjectContent(
    store,
    async () => {
      throw Error("legacy fallback");
    },
    () => true,
    () => {},
    controller.signal,
    native,
  );
  try {
    service.start(key, input);
    await service.close();
    assert.equal(service.list(projectId)[0].state, "unknown");
    service = new GptProjectContent(
      store,
      async () => {
        throw Error("legacy fallback");
      },
      () => true,
      () => {},
      controller.signal,
      native,
    );
    service.start(key, input);
    assert.equal(writes, 1);
    await assert.rejects(service.checked(key), /Нельзя/);
    ready = true;
    assert.equal(await service.check(key), true);
    assert.equal(writes, 1);
    const legacy = new GptProjectContent(
      store,
      async () => {
        throw Error("legacy fallback");
      },
      () => true,
      () => {},
      controller.signal,
    );
    await assert.rejects(legacy.check(key), /прежнему подключению/);
  } finally {
    controller.abort();
    await service.close();
    store.close();
  }
});

test("disposable project creation is opt-in, persists admission and never retries unknown creation", async (t) => {
  const f = fixture(t),
    key = randomUUID(),
    unknown = randomUUID(),
    projects = new NativeProjectReceipts(f.dispatch, [], [key, unknown]);
  let calls = 0;
  const reader = {
    createProject: async () => {
      calls++;
      if (calls === 2) throw Error("lost");
      return { projectId };
    },
  };
  assert.equal((await projects.create({ key, name: "Disposable" }, reader)).projectId, projectId);
  assert.equal(projects.allowed.has(projectId), true);
  await projects.create({ key, name: "Disposable" }, reader);
  assert.equal(calls, 1);
  assert.equal(
    new NativeProjectReceipts(f.dispatch, [], [key, unknown]).allowed.has(projectId),
    true,
  );
  await assert.rejects(projects.create({ key: unknown, name: "Uncertain" }, reader), /lost/);
  assert.equal(f.dispatch.pending(), true);
  assert.equal(
    (await projects.create({ key: unknown, name: "Uncertain" }, reader)).projectId,
    null,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    projects.create({ key: randomUUID(), name: "Not allowed" }, reader),
    /INVALID_CANARY/,
  );
});

test("native HTTP rejection is terminal, but transport loss remains unknown and is not replayed", async () => {
  const principal = { accountId: "a", userId: "u" },
    fingerprint = hash(JSON.stringify(["a", "u", null]));
  let calls = 0,
    status = 422;
  const m = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: principal }) } },
    kWt: {
      getRequestTarget: () => ({ url: "/projects", headers: {} }),
      getRequestBody: (o) => JSON.stringify(o.requestBody),
    },
    $rn: {
      getInstance: () => ({
        fetch: async (url, o) => {
          calls++;
          o.assertRequestCurrent();
          throw Object.assign(Error("private upstream details"), {
            status,
            responseStatus: status,
          });
        },
      }),
    },
  };
  const request = {
      operation: "createProject",
      name: "Disposable",
      accountFingerprint: fingerprint,
    },
    read = async () => ({ accountFingerprint: fingerprint });
  assert.deepEqual(await nativeProject(request, read, async () => m, { crypto: webcrypto }), {
    projectId: null,
    rejected: true,
  });
  assert.equal(calls, 1);
  status = 500;
  await assert.rejects(
    nativeProject(request, read, async () => m, { crypto: webcrypto }),
    /private upstream/,
  );
  assert.equal(calls, 2);
});
