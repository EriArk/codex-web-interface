import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { entityAction, Library } from "../apps/hub/dist/library.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { libraryRequest, mutateLibrary } from "../ops/gpt/browser-library.mjs";
import { configSchema, HubError } from "../packages/shared/dist/index.js";

async function codex(t) {
  const root = mkdtempSync(join(tmpdir(), "codex-library-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: ":memory:",
      resultsPath: root,
    },
    auth: {},
    machines: [{ id: "pc", name: "PC", type: "local-linux", codex: { command: "codex" } }],
    projects: [{ id: "seed", name: "Seed", machineId: "pc", workingDirectory: "/workspace" }],
  });
  const store = new Store(":memory:");
  class Rpc extends EventEmitter {
    closed = false;
    calls = [];
    queue = [];
    state = "idle";
    archived = false;
    project = { id: "native-project", name: "Seed", roots: [{ path: "/workspace" }] };
    native = {
      id: randomUUID(),
      name: "Conversation",
      cwd: "/workspace",
      path: "/rollout.jsonl",
      status: { type: "idle" },
      projectId: "native-project",
      createdAt: 1,
      updatedAt: 2,
    };
    async initialize() {
      return { userAgent: "codex/0.153.4" };
    }
    async request(method, p) {
      this.calls.push({ method, p });
      if (method === "account/read") return {};
      if (method === "project/list") return { data: this.project ? [this.project] : [] };
      if (method === "project/update") {
        this.project = { ...this.project, name: p.name };
        return { project: this.project };
      }
      if (method === "project/delete") {
        this.project = null;
        this.native.projectId = null;
        return {};
      }
      if (method === "thread/list") return { data: this.deleted ? [] : [this.native] };
      if (method === "thread/read")
        return { thread: { ...this.native, status: { type: this.state } } };
      if (method === "thread/queue/list") {
        if (this.archived) throw Error("Archived queues are unavailable");
        return { data: this.queue };
      }
      if (method === "thread/name/set") {
        this.native.name = p.name;
        return {};
      }
      if (method === "thread/archive") {
        this.archived = true;
        return {};
      }
      if (method === "thread/unarchive") {
        this.archived = false;
        return { thread: this.native };
      }
      if (method === "thread/delete") {
        this.deleted = true;
        return {};
      }
      if (method === "thread/unsubscribe") return {};
      throw Error("Unexpected " + method);
    }
    close() {
      this.closed = true;
    }
  }
  const rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc);
  await sessions.catalog.refresh();
  const thread = sessions.catalog.importThread(sessions.project("seed"), rpc.native);
  t.after(async () => {
    await sessions.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, sessions, rpc, thread };
}
test("Codex library uses native rename/archive/restore and server pins; restore never loads an archived queue", async (t) => {
  const { store, sessions, rpc, thread } = await codex(t);
  await sessions.manageEntity("thread", thread.id, { action: "pin", value: true });
  assert.equal(sessions.catalog.library.get("thread", thread.codexThreadId).pinned, true);
  assert(!rpc.calls.some((c) => c.method === "thread/metadata/update"));
  await sessions.manageEntity("thread", thread.id, { action: "rename", name: "Новое имя" });
  assert.equal(store.thread(thread.id).title, "Новое имя");
  await sessions.manageEntity("thread", thread.id, { action: "archive", value: true });
  assert.equal(store.threads("seed").length, 0);
  await sessions.manageEntity("thread", thread.id, { action: "archive", value: false });
  assert.equal(store.threads("seed").length, 1);
  assert.equal(rpc.calls.filter((c) => c.method === "thread/queue/list").length, 1);
});
test("Codex destructive operations reject active and queued work before mutation", async (t) => {
  const { sessions, rpc, thread } = await codex(t);
  rpc.state = "active";
  await assert.rejects(
    sessions.manageEntity("thread", thread.id, { action: "delete", confirm: true }),
    (e) => e.code === "ENTITY_BUSY",
  );
  rpc.state = "idle";
  rpc.queue = [{ id: "queued" }];
  await assert.rejects(
    sessions.manageEntity("project", "seed", { action: "delete", confirm: true }),
    (e) => e.code === "ENTITY_QUEUED",
  );
  assert(!rpc.calls.some((c) => c.method === "thread/delete" || c.method === "project/delete"));
});
test("Deleting a Codex project detaches its chats, preserves source files and does not reappear from configuration", async (t) => {
  const { store, sessions, rpc, thread } = await codex(t);
  await sessions.manageEntity("project", "seed", { action: "delete", confirm: true });
  await sessions.catalog.refresh(true);
  assert.equal(sessions.catalog.publicProjects().find((p) => p.id === "seed").deleted, true);
  assert.equal(store.thread(thread.id).projectId, "unassigned-pc");
  assert(!rpc.calls.some((c) => c.method.startsWith("fs/") || c.method === "thread/delete"));
});
test("Native thread deletion purges Hub history and idempotent repeats do not resend it", async (t) => {
  const { store, sessions, rpc, thread } = await codex(t);
  store.append(thread.id, "user.message", { id: "u", text: "private history" }, "turn");
  const key = randomUUID(),
    action = { action: "delete", confirm: true };
  const run = () =>
    store.once("delete:" + thread.id, key, action, () =>
      sessions.manageEntity("thread", thread.id, action),
    );
  await run();
  await run();
  assert.throws(() => store.thread(thread.id));
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE threadId=?").get(thread.id).n,
    0,
  );
  assert.equal(rpc.calls.filter((c) => c.method === "thread/delete").length, 1);
  assert.equal(sessions.catalog.library.get("thread", thread.codexThreadId).deleted, true);
});
test("Project mutation blocks queue writes until native acknowledgement", async (t) => {
  const { sessions, rpc, thread } = await codex(t);
  let release;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, p) =>
    method === "project/update"
      ? await new Promise((resolve) => {
          release = () => resolve({ project: { ...rpc.project, name: p.name } });
        })
      : original(method, p);
  const pending = sessions.manageEntity("project", "seed", { action: "rename", name: "Renamed" });
  while (!release) await new Promise((r) => setTimeout(r, 1));
  await assert.rejects(
    sessions.withThreadWrite(thread.id, async () => {}),
    (e) => e.code === "ENTITY_BUSY",
  );
  release();
  await pending;
});
test("Destructive contracts require explicit confirmation and prohibit arbitrary native URLs", () => {
  assert.equal(entityAction.safeParse({ action: "delete" }).success, false);
  assert.equal(entityAction.safeParse({ action: "delete", confirm: true }).success, true);
  assert.throws(() =>
    libraryRequest({ kind: "project", id: "../other", action: "delete", confirm: true }),
  );
  assert.throws(() => libraryRequest({ kind: "thread", id: "valid", action: "delete" }));
  assert.deepEqual(
    libraryRequest({ kind: "thread", id: "native", action: "archive", value: false }),
    { path: "/backend-api/conversation/native", method: "PATCH", body: { is_archived: false } },
  );
});
test("GPT project rename preserves native instructions and appearance", async () => {
  const requests = [],
    previous = global.fetch;
  global.fetch = async (path, options) => {
    requests.push({ path, options });
    if (path === "/api/auth/session") return Response.json({ accessToken: "private-test-token" });
    if (path === "/backend-api/gizmos/g-project")
      return Response.json({
        gizmo: { instructions: "Keep my instructions", display: { emoji: "leaf", theme: "green" } },
      });
    return Response.json({ success: true });
  };
  try {
    const page = { evaluate: (fn, args) => fn(args) };
    const result = await mutateLibrary(page, {
      kind: "project",
      id: "g-project",
      action: "rename",
      name: "Новое имя",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
      name: "Новое имя",
      instructions: "Keep my instructions",
      emoji: "leaf",
      theme: "green",
    });
  } finally {
    global.fetch = previous;
  }
});
test("GPT library mutations serialize with sends, use real pins and preserve project archive on the Hub", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gpt-library-"));
  process.env.GPT_LIBRARY_TEST = "private-test-token";
  const store = new Store(":memory:"),
    config = configSchema.parse({
      hub: {
        publicBaseUrl: "https://codex.example.test",
        databasePath: ":memory:",
        resultsPath: root,
      },
      auth: {},
      machines: [],
      projects: [],
      gpt: { endpoint: "http://127.0.0.1:8786", tokenSecret: "GPT_LIBRARY_TEST" },
    });
  const service = new GptService(config, store),
    calls = [];
  let release;
  service.json = async (path, body) => {
    calls.push({ path, body });
    if (path === "/active") return {};
    if (path === "/pins")
      return [
        {
          item_type: "conversation",
          item: { id: "native-thread", title: "Pinned", update_time: 1 },
        },
      ];
    if (path === "/projects")
      return { items: [{ gizmo: { id: "g-project", display: { name: "Project" } } }] };
    if (path.startsWith("/catalog")) return { items: [], total: 0 };
    if (path.startsWith("/conversation?")) return { title: "Conversation", mapping: {} };
    if (path === "/library")
      return await new Promise((resolve) => {
        release = () => resolve({ ok: true });
      });
    throw Error("Unexpected " + path);
  };
  t.after(async () => {
    await service.close();
    store.close();
    delete process.env.GPT_LIBRARY_TEST;
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await service.catalog()).items[0].pinned, true);
  await service.manageEntity("project", "g-project", { action: "archive", value: true });
  assert.equal(new Library(store, "gpt").archived()[0].id, "g-project");
  assert(!calls.some((c) => c.path === "/library"));
  const pending = service.manageEntity("thread", "native-thread", {
    action: "rename",
    name: "Renamed",
  });
  while (!release) await new Promise((r) => setTimeout(r, 1));
  assert.throws(
    () =>
      service.enqueue(randomUUID(), {
        nativeId: "native-thread",
        text: "Do work",
        files: [],
        model: "model",
        effort: "1",
      }),
    (e) => e.code === "GPT_LIBRARY_BUSY",
  );
  release();
  await pending;
  assert.deepEqual(calls.find((c) => c.path === "/library").body, {
    kind: "thread",
    id: "native-thread",
    action: "rename",
    name: "Renamed",
  });
  service.library.save("project", "g-project", {
    name: "Confirmed name",
    renamed: true,
    nameCheckedAt: Date.now(),
  });
  assert.equal((await service.projects()).items[0].name, "Confirmed name");
  service.library.save("project", "g-project", { nameCheckedAt: 0 });
  const previousJson = service.json.bind(service);
  service.json = async (path, body) =>
    path.startsWith("/project?id=")
      ? { gizmo: { id: "g-project", display: { name: "Changed in ChatGPT" } } }
      : previousJson(path, body);
  assert.equal((await service.projects()).items[0].name, "Changed in ChatGPT");
});

test("Empty Codex chats archive locally without inventing a native message", async (t) => {
  const { store, sessions, rpc, thread } = await codex(t);
  store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(thread.id);
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, p) => {
    if (method === "thread/archive") throw new HubError(404, "THREAD_NOT_PERSISTED", "No rollout");
    return original(method, p);
  };
  await sessions.manageEntity("thread", thread.id, { action: "archive", value: true });
  assert.equal(store.thread(thread.id).archived, 1);
  assert.equal(sessions.catalog.library.get("thread", thread.codexThreadId).localArchive, true);
  await sessions.manageEntity("thread", thread.id, { action: "archive", value: false });
  assert.equal(store.thread(thread.id).archived, 0);
  assert(!rpc.calls.some((c) => c.method === "thread/unarchive" || c.method === "turn/start"));
});
