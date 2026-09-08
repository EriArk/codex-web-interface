import assert from "node:assert/strict";
import test from "node:test";
import { workspaceTool } from "../apps/hub/dist/workspaceTools.js";
import { workspaceDependenciesScript } from "../packages/machines/dist/workspace.js";
import { HubError } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const machine = { id: "pc", type: "ssh-windows" };
const request = { namespace: "codex_app", tool: "load_workspace_dependencies", arguments: {} };
test("desktop workspace tool returns discovered runtime paths and rejects caller data", async () => {
  let reads = 0;
  const read = async () => {
    reads++;
    return {
      installed: true,
      root: "C:/Runtime",
      bundleVersion: "1",
      node: "C:/Runtime/node.exe",
      python: "C:/Runtime/python.exe",
      nodeModules: "C:/Runtime/modules",
      plugins: "C:/Runtime/plugins",
    };
  };
  const result = await workspaceTool(request, machine, read);
  assert.equal(result.success, true);
  assert.match(result.contentItems[0].text, /C:\/Runtime\/python.exe/);
  assert.equal(
    (await workspaceTool({ ...request, arguments: { command: "injected" } }, machine, read))
      .success,
    false,
  );
  assert.equal(await workspaceTool({ ...request, namespace: "untrusted" }, machine, read), null);
  assert.equal(reads, 1);
  assert.equal(
    (
      await workspaceTool(
        { ...request, namespace: null, tool: "codex_app__load_workspace_dependencies" },
        machine,
        read,
      )
    ).success,
    true,
  );
  assert.equal(
    (await workspaceTool(request, machine, async () => ({ installed: false }))).success,
    false,
  );
  assert.equal(
    (
      await workspaceTool(request, machine, async () => {
        throw new Error("secret path");
      })
    ).contentItems[0].text.includes("secret path"),
    false,
  );
  assert.doesNotMatch(
    workspaceDependenciesScript(),
    /Invoke-Expression|Start-Process|Invoke-WebRequest/,
  );
});

test("unknown desktop tools return a tool failure without poisoning chat connection state", async () => {
  const f = await handoffFixture();
  try {
    await f.release();
    await f.sessions.resume(f.thread.id);
    const runtime = await f.sessions.runtime("project"),
      replies = [];
    runtime.rpc.respond = (id, value) => replies.push({ id, value });
    runtime.rpc.rejectRequest = () => assert.fail("dynamic calls need a normal tool response");
    await f.sessions.request(runtime, {
      id: 100,
      method: "item/tool/call",
      params: {
        ...request,
        threadId: f.thread.codexThreadId,
        turnId: "turn",
        tool: "desktop_unknown",
        arguments: { private: "never expose" },
      },
    });
    assert.equal(replies[0].value.success, false);
    assert.equal(f.store.db.prepare("select count(*) n from events where type='error'").get().n, 0);
    const row = f.store.db.prepare("select * from results where type='error'").get();
    assert.ok(row);
    assert.doesNotMatch(row.payload, /never expose/);
    await f.sessions.request(runtime, {
      id: 101,
      method: "item/tool/call",
      params: {
        ...request,
        threadId: f.thread.codexThreadId,
        turnId: "turn",
        tool: "desktop_unknown",
      },
    });
    assert.equal(
      f.store.db.prepare("select count(*) n from results where type='error'").get().n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("resume checks paged turn state even when excluded turns are empty and thread was loaded", async () => {
  const f = await handoffFixture();
  try {
    await f.release();
    await f.sessions.resume(f.thread.id);
    const r = await f.sessions.runtime("project"),
      original = r.rpc.request.bind(r.rpc);
    let status = "inProgress";
    r.rpc.request = async (method, params) =>
      method === "thread/turns/list"
        ? { data: [{ id: "active-native", status, items: [] }] }
        : original(method, params);
    f.store.setStatus(f.thread.id, "unknown", "active-native");
    assert.equal((await f.sessions.resume(f.thread.id)).status, "running");
    status = "interrupted";
    f.store.setStatus(f.thread.id, "unknown", "active-native");
    assert.equal((await f.sessions.resume(f.thread.id)).status, "idle");
    assert.equal(r.active.has(f.thread.id), false);
    status = "future-status";
    f.store.setStatus(f.thread.id, "unknown", "active-native");
    assert.equal((await f.sessions.resume(f.thread.id)).status, "unknown");
    r.rpc.request = async (method, params) =>
      method === "thread/turns/list" ? {} : original(method, params);
    await assert.rejects(() => f.sessions.resume(f.thread.id), { code: "INVALID_CODEX_RESPONSE" });
    assert.equal(f.store.thread(f.thread.id).status, "unknown");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  } finally {
    await f.close();
  }
});

test("empty unpersisted web placeholder can recover without reading nonexistent native turns", async () => {
  const f = await handoffFixture();
  try {
    await f.release();
    f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
    const r = await f.sessions.runtime("project"),
      original = r.rpc.request.bind(r.rpc);
    r.rpc.request = async (method, params) => {
      if (method === "thread/resume" || method === "thread/turns/list")
        throw new HubError(404, "THREAD_NOT_PERSISTED", "No rollout");
      if (method === "thread/start") return { thread: { id: "new-placeholder", turns: [] } };
      return original(method, params);
    };
    const restored = await f.sessions.resume(f.thread.id);
    assert.equal(restored.codexThreadId, "new-placeholder");
    assert.equal(restored.status, "idle");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  } finally {
    await f.close();
  }
});
