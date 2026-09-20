import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeDispatchReceipts } from "../ops/gpt-native/dispatch-receipts.mjs";
import { NativeLibraryReceipts } from "../ops/gpt-native/library-receipts.mjs";
import { nativeLibrary } from "../ops/gpt-native/renderer-library.mjs";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

function ledger(t) {
  const root = mkdtempSync(join(tmpdir(), "native-library-"));
  chmodSync(root, 0o700);
  const id = randomUUID(),
    userId = randomUUID(),
    accountFingerprint = "a".repeat(64),
    path = join(root, "receipts.sqlite");
  let dispatch, library;
  const open = () => {
    dispatch = new NativeDispatchReceipts({
      path,
      userId,
      accountFingerprint,
      conversationIds: [id],
    });
    library = new NativeLibraryReceipts(dispatch);
  };
  open();
  t.after(() => {
    dispatch.close();
    rmSync(root, { recursive: true, force: true });
  });
  let writes = 0,
    unreadable = false,
    current = { exists: true, name: "Before", projectId: null, archived: false, canWrite: true };
  const reader = {
    readLibrary: async () => {
      if (unreadable) throw Error("offline");
      return { ...current };
    },
    mutateLibrary: async (r) => {
      writes++;
      current.name = r.name;
      unreadable = true;
      throw Error("lost ack");
    },
  };
  const request = {
    key: randomUUID(),
    kind: "thread",
    id,
    action: "rename",
    name: "After",
    accountFingerprint,
  };
  return {
    request,
    reader,
    get dispatch() {
      return dispatch;
    },
    get library() {
      return library;
    },
    get writes() {
      return writes;
    },
    readable: () => {
      unreadable = false;
    },
    reopen: () => {
      dispatch.close();
      open();
    },
  };
}
test("native library lost ack survives restart, blocks new work, and reconciliation never writes", async (t) => {
  const f = ledger(t);
  assert.equal((await f.library.run(f.request, f.reader)).state, "unknown");
  assert.equal(f.writes, 1);
  assert.equal(f.dispatch.pending(), true);
  f.reopen();
  await assert.rejects(
    f.library.run({ ...f.request, key: randomUUID() }, f.reader),
    /PENDING_DISPATCH/,
  );
  f.readable();
  assert.equal((await f.library.run(f.request, f.reader, true)).state, "completed");
  assert.equal(f.writes, 1);
  assert.equal(f.dispatch.pending(), false);
  await f.library.run(f.request, f.reader);
  assert.equal(f.writes, 1);
  await assert.rejects(f.library.run({ ...f.request, name: "Other" }, f.reader), /KEY_CONFLICT/);
  await assert.rejects(
    f.library.run({ ...f.request, key: randomUUID() }, f.reader, true),
    /RECEIPT_MISSING/,
  );
  await assert.rejects(
    f.library.run({ ...f.request, id: randomUUID() }, f.reader),
    /INVALID_CANARY/,
  );
});
function renderer() {
  const id = randomUUID(),
    p = { accountId: "account", userId: "user" },
    fingerprint = () =>
      createHash("sha256")
        .update(JSON.stringify([p.accountId, p.userId, null]))
        .digest("hex");
  const r = {
    operation: "readLibrary",
    kind: "thread",
    id,
    action: "rename",
    name: "After",
    accountFingerprint: fingerprint(),
  };
  let metadata = { conversation_id: id, title: "Before", is_archived: false },
    changed = false;
  const calls = [];
  const read = async (r) =>
    r.operation === "inspectAccount" ? { accountFingerprint: fingerprint() } : { items: [] };
  const editor = { getClientRects: () => [1], textContent: "", closest: () => null };
  const runtime = {
    crypto: webcrypto,
    document: { querySelectorAll: (s) => (s.includes("textbox") ? [editor] : []) },
  };
  const m = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: p }) } },
    kWt: {
      getRequestTarget: (route, options) => ({ url: route, headers: {} }),
      getRequestBody: (o) => JSON.stringify(o.requestBody),
    },
    $rn: {
      getInstance: () => ({
        fetch: async (url, o) => {
          calls.push({ url, ...o });
          assert.equal(o.retry, false);
          assert.deepEqual(o.expectedIdentity, { accountId: "account", userId: "user" });
          o.assertRequestCurrent();
          assert.throws(o.assertRequestCurrent, /REPLAY_BLOCKED/);
          if (changed) p.accountId = "other";
          return new Response(JSON.stringify(o.method === "GET" ? metadata : {}), { status: 200 });
        },
      }),
    },
  };
  return {
    r,
    calls,
    editor,
    setChanged: () => {
      changed = true;
    },
    setMetadata: (v) => {
      metadata = v;
    },
    run: (r) => nativeLibrary(r, read, async () => m, runtime),
  };
}
test("fixed native library request keeps identity/retry guards and preserves draft", async () => {
  const f = renderer(),
    baseline = await f.run(f.r);
  assert.equal(baseline.name, "Before");
  f.editor.textContent = "Owner draft";
  assert.deepEqual(await f.run({ ...f.r, operation: "mutateLibrary", baseline }), {
    dispatched: false,
  });
  assert.equal(f.calls.filter((x) => x.method === "PATCH").length, 0);
  f.editor.textContent = "";
  assert.equal((await f.run({ ...f.r, operation: "mutateLibrary", baseline })).accepted, true);
  const write = f.calls.find((x) => x.method === "PATCH");
  assert.equal(write.url, "/conversation/{conversation_id}");
  assert.deepEqual(JSON.parse(write.body), { title: "After" });
  f.setChanged();
  await assert.rejects(f.run(f.r), /ACCOUNT_CHANGED/);
});
test("native library rejects changed baselines and unexpected operations before mutation", async () => {
  const f = renderer(),
    baseline = await f.run(f.r);
  assert.deepEqual(
    await f.run({ ...f.r, operation: "mutateLibrary", baseline: { ...baseline, name: "Stale" } }),
    { dispatched: false },
  );
  await assert.rejects(f.run({ ...f.r, action: "shell" }), /INVALID_LIBRARY/);
  assert.equal(f.calls.filter((x) => x.method === "PATCH").length, 0);
});
test("shared library route retains pending action and checks it read-only after lost ack", async (t) => {
  const native = nativeWorkspaceFixture();
  let calls = 0,
    checks = 0,
    ready = false;
  native.client.libraryMutation = async (r, check) => {
    if (check) {
      checks++;
      return { state: ready ? "completed" : "unknown", name: "Before", projectId: null };
    }
    calls++;
    throw Error("NATIVE_TIMEOUT");
  };
  const f = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => f.close());
  const path = "/api/library/gpt/thread/" + native.conversationId,
    key = randomUUID(),
    payload = { action: "rename", name: "After" };
  const post = (body = payload, k = key) =>
    f.app.inject({
      method: "POST",
      url: path,
      headers: { ...f.headers, "idempotency-key": k },
      payload: body,
    });
  assert.equal((await post()).json().error?.code, "GPT_LIBRARY_UNKNOWN");
  const pending = await f.app.inject({ url: path + "/pending", headers: f.headers });
  assert.deepEqual(pending.json().pending, { key, action: payload });
  assert.equal((await post()).json().error?.code, "GPT_LIBRARY_UNKNOWN");
  assert.equal(calls, 1);
  assert.equal(checks, 1);
  ready = true;
  assert.equal((await post()).statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(checks, 2);
  assert.equal((await post()).statusCode, 200);
  assert.equal(checks, 2);
  assert.equal((await post({ action: "rename", name: "Changed" })).statusCode, 409);
  assert.equal((await f.app.inject({ url: path + "/pending" })).statusCode, 401);
});

test("deleting a native chat keeps its completed jobs and provider receipts", async (t) => {
  const native = nativeWorkspaceFixture();
  let writes = 0;
  native.client.libraryMutation = async () => {
    writes++;
    return { state: "completed", name: "Disposable", projectId: null };
  };
  const f = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => f.close());
  const key = randomUUID(),
    job = randomUUID(),
    now = Date.now();
  f.store.db
    .prepare(
      "INSERT INTO gpt_jobs(id,fingerprint,nativeId,text,files,model,effort,status,answer,assets,error,createdAt,updatedAt) VALUES(?,'existing-proof',?,?,'[]',?,?,'completed','','[]','',?,?)",
    )
    .run(job, native.conversationId, "Existing receipt", "latest", "1", now, now);
  const url = "/api/library/gpt/thread/" + native.conversationId;
  const result = await f.app.inject({
    method: "POST",
    url,
    headers: { ...f.headers, "idempotency-key": key },
    payload: { action: "delete", confirm: true },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(writes, 0);
  assert.equal(
    f.store.db.prepare("SELECT done FROM gpt_deletions WHERE id=?").get(native.conversationId).done,
    0,
  );
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM gpt_jobs WHERE id=?").get(job).n, 1);
  const again = await f.app.inject({
    method: "POST",
    url,
    headers: { ...f.headers, "idempotency-key": key },
    payload: { action: "delete", confirm: true },
  });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(writes, 0);
  assert.equal(
    f.store.db.prepare("SELECT done FROM gpt_deletions WHERE id=?").get(native.conversationId).done,
    0,
  );
});

test("native project rename preserves instructions and appearance in fixed PATCH", async () => {
  const principal = { accountId: "a", userId: "u" },
    accountFingerprint = createHash("sha256")
      .update(JSON.stringify(["a", "u", null]))
      .digest("hex");
  const project = {
    name: "Before",
    instructions: "Owner rules",
    canWrite: true,
    emoji: "book",
    theme: "blue",
  };
  const writes = [];
  const read = async (r) => (r.operation === "inspectAccount" ? { accountFingerprint } : project);
  const m = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: principal }) } },
    kWt: {
      getRequestTarget: (route, o) => {
        assert.equal(route, "/projects/{project_id}");
        assert.equal(o.parameters.path.project_id, "g-p-example");
        return { url: route, headers: {} };
      },
      getRequestBody: (o) => JSON.stringify(o.requestBody),
    },
    $rn: {
      getInstance: () => ({
        fetch: async (url, o) => {
          o.assertRequestCurrent();
          writes.push(JSON.parse(o.body));
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
  const r = {
    operation: "readLibrary",
    kind: "project",
    id: "g-p-example",
    action: "rename",
    name: "After",
    accountFingerprint,
  };
  const baseline = await nativeLibrary(r, read, async () => m, runtime);
  await nativeLibrary({ ...r, operation: "mutateLibrary", baseline }, read, async () => m, runtime);
  assert.deepEqual(writes, [
    { name: "After", instructions: "Owner rules", emoji: "book", theme: "blue" },
  ]);
});
