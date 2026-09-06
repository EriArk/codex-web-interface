import assert from "node:assert/strict";
import test from "node:test";
import { Catalog } from "../apps/hub/dist/catalog.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";

const config = configSchema.parse({
  hub: {
    publicBaseUrl: "https://codex.example.test",
    databasePath: ":memory:",
    resultsPath: "/tmp/codex-catalog-tests",
  },
  auth: {},
  machines: [
    {
      id: "pc",
      name: "PC",
      type: "ssh-windows",
      ssh: { target: "test-pc" },
      codex: { command: "codex.exe" },
    },
  ],
  projects: [{ id: "seed", name: "Seed", machineId: "pc", workingDirectory: "D:\\Projects\\Seed" }],
});
function fixture() {
  const store = new Store(":memory:"),
    calls = [];
  let projects = [
    { id: "native-seed", name: "Home project", roots: [{ path: "d:/projects/seed" }] },
    { id: "other", name: "Other", roots: [{ path: "D:\\Projects\\Other" }] },
  ];
  const raw = {
    id: "real-thread",
    name: "Real title",
    cwd: "D:\\Projects\\Other",
    historyMode: "paginated",
    updatedAt: 1000,
    createdAt: 100,
    model: "qa-model",
    reasoningEffort: "high",
  };
  const entries = Array.from({ length: 135 }, (_, n) => ({
    turnId: "turn-" + Math.floor(n / 3),
    item:
      n % 3 === 2
        ? { id: "c" + n, type: "commandExecution", command: "npm test", exitCode: 0 }
        : {
            id: "m" + n,
            type: n % 3 === 0 ? "userMessage" : "agentMessage",
            text: "Message " + n,
            content: [{ type: "text", text: "Message " + n }],
            phase: "final_answer",
          },
  })).reverse();
  const rpc = {
    request: async (method, p) => {
      calls.push({ method, p });
      if (method === "project/list") return { data: projects, nextCursor: null };
      if (method === "thread/list") return { data: [raw], nextCursor: null };
      if (method === "thread/read") return { thread: raw };
      if (method === "thread/items/list") {
        const rows = entries.filter((e) => !p.turnId || e.turnId === p.turnId),
          start = Number(p.cursor ?? 0);
        return {
          data: rows.slice(start, start + p.limit),
          nextCursor: start + p.limit < rows.length ? String(start + p.limit) : null,
        };
      }
      if (method === "fs/readDirectory")
        return {
          entries: [
            { fileName: "Folder", isDirectory: true },
            { fileName: "../escape", isDirectory: true },
            { fileName: "file.txt", isFile: true },
          ],
        };
      if (method === "fs/getMetadata") return { isDirectory: true };
      if (method === "fs/createDirectory") return {};
      if (method === "project/create") {
        const project = { id: "created", name: p.name, roots: p.roots };
        projects.push(project);
        return { project };
      }
      throw new Error("Unexpected RPC " + method);
    },
  };
  const catalog = new Catalog(config, store, async () => rpc);
  return {
    store,
    catalog,
    calls,
    raw,
    entries,
    removeProject: (id) => (projects = projects.filter((p) => p.id !== id)),
    addProject: (p) => projects.push(p),
  };
}
test("native catalog reuses configured roots, imports metadata only, tracks additions and deletions", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh(true);
    assert.equal(f.catalog.projects().find((p) => p.sourceId === "native-seed").id, "seed");
    await f.catalog.syncThreads("pc", true);
    const imported = f.store.threadByCodex("real-thread");
    assert.equal(imported.title, "Real title");
    assert.equal(imported.origin, "desktop");
    assert.equal(f.store.history(imported.id).messages.length, 0);
    assert(!f.calls.some((c) => c.method === "thread/read" || c.method === "thread/resume"));
    f.addProject({
      id: "same-root",
      name: "Same root project",
      roots: [{ path: "D:\\Projects\\Seed" }],
    });
    await f.catalog.refresh(true);
    assert.equal(f.catalog.projects().length, 3);
    assert.notEqual(f.catalog.projects().find((p) => p.sourceId === "same-root").id, "seed");
    f.removeProject("other");
    await f.catalog.refresh(true);
    assert(!f.catalog.projects().some((p) => p.sourceId === "other"));
    await f.catalog.createProject("pc", "Created", "D:\\Projects\\Created", true, "key");
    assert(f.catalog.publicProjects().some((p) => p.name === "Created"));
    assert.equal(f.calls.find((c) => c.method === "project/create").p.idempotencyKey, "key");
    assert.equal((await f.catalog.directories("pc", "D:\\Projects")).entries.length, 1);
    await assert.rejects(f.catalog.directories("pc", "relative"), {
      code: "ABSOLUTE_PATH_REQUIRED",
    });
  } finally {
    f.store.close();
  }
});
test("native history pages 20 chat items through command-heavy source pages without duplicates or lost messages", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    await f.catalog.syncThreads("pc");
    const thread = f.store.threadByCodex("real-thread"),
      seen = new Set();
    let before,
      all = [];
    do {
      const page = await f.catalog.history(thread, before);
      assert(page.messages.length <= 20);
      for (const m of page.messages) {
        assert(!seen.has(m.id));
        seen.add(m.id);
      }
      all = [...page.messages, ...all];
      before = page.nextBefore;
    } while (before);
    assert.equal(all.length, 90);
    assert.equal(all[0].text, "Message 0");
    assert.equal(all.at(-1).text, "Message 133");
    assert(
      f.calls.filter((c) => c.method === "thread/read").every((c) => c.p.includeTurns === false),
    );
    assert(!f.calls.some((c) => c.method === "thread/resume"));
    assert(f.calls.filter((c) => c.method === "thread/items/list").every((c) => c.p.limit === 40));
    const first = await f.catalog.history(thread);
    const other = f.store.createThread("seed", "unrelated", "Unrelated");
    await assert.rejects(f.catalog.history(other, first.nextBefore), {
      code: "HISTORY_CURSOR_EXPIRED",
    });
    const context = await f.catalog.history(thread, undefined, "turn-10");
    assert(context.messages.every((m) => m.turnId === "turn-10"));
  } finally {
    f.store.close();
  }
});
test("reload during an active native turn keeps optimistic IDs and a consistent event cursor", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    await f.catalog.syncThreads("pc");
    const thread = f.store.threadByCodex("real-thread");
    f.store.append(
      thread.id,
      "user.message",
      { id: "optimistic-user", text: "Message 132" },
      "turn-44",
    );
    f.store.append(
      thread.id,
      "assistant.delta",
      { id: "m133", text: "Live full response" },
      "turn-44",
    );
    f.store.setStatus(thread.id, "running", "turn-44");
    const page = await f.catalog.history(thread);
    assert.equal(page.messages.length, 20);
    assert.equal(page.messages.at(-2).id, "optimistic-user");
    assert.equal(page.messages.at(-1).id, "m133");
    assert.equal(page.messages.at(-1).text, "Live full response");
    assert.equal(page.lastSeq, f.store.lastSeq(thread.id));
  } finally {
    f.store.close();
  }
});
