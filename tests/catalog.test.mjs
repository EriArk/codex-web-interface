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
    assert.equal(f.catalog.projects().filter((p) => !p.unassigned).length, 3);
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

test("unmatched native chats belong to the unassigned bucket and retain their actual cwd", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    f.raw.cwd = "D:/Scratch/Independent";
    await f.catalog.syncThreads("pc", true);
    const thread = f.store.threadByCodex("real-thread");
    assert.equal(thread.projectId, "unassigned-pc");
    assert.equal(thread.workingDirectory, "D:\\Scratch\\Independent");
    assert.equal(
      f.catalog.publicProjects().find((p) => p.id === thread.projectId).unassigned,
      true,
    );
    assert.equal(f.store.history(thread.id).messages.length, 0);
  } finally {
    f.store.close();
  }
});

test("reopening a live turn after multiple Steers preserves distinct users and assistant replies", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    await f.catalog.syncThreads("pc");
    const thread = f.store.threadByCodex("real-thread");
    f.entries.splice(
      0,
      f.entries.length,
      ...Array.from({ length: 12 }, (_, n) => ({
        turnId: "steered-turn",
        item:
          n % 2 === 0
            ? {
                id: "native-user-" + n,
                type: "userMessage",
                content: [{ type: "text", text: "Request " + n }],
              }
            : {
                id: "assistant-" + n,
                type: "agentMessage",
                text: "Reply " + n,
                phase: "commentary",
              },
      })).reverse(),
    );
    for (let n = 0; n < 12; n++) {
      f.store.append(
        thread.id,
        n % 2 === 0 ? "user.message" : "assistant.completed",
        {
          id: (n % 2 === 0 ? "local-user-" : "assistant-") + n,
          text: (n % 2 === 0 ? "Request " : "Reply ") + n,
          phase: n % 2 === 0 ? "" : "commentary",
        },
        "steered-turn",
      );
    }
    f.store.setStatus(thread.id, "running", "steered-turn");
    const page = await f.catalog.history(f.store.thread(thread.id));
    assert.equal(new Set(page.messages.map((m) => m.id)).size, page.messages.length);
    assert.equal(page.messages.length, 12);
    assert.deepEqual(
      page.messages.map((m) => m.text),
      Array.from({ length: 12 }, (_, n) => (n % 2 === 0 ? "Request " : "Reply ") + n),
    );
    assert.equal(page.messages.filter((m) => m.role === "assistant").length, 6);
  } finally {
    f.store.close();
  }
});

test("identical Steer text stays distinct across older history pages", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    await f.catalog.syncThreads("pc");
    const thread = f.store.threadByCodex("real-thread");
    f.entries.splice(
      0,
      f.entries.length,
      ...Array.from({ length: 60 }, (_, n) => ({
        turnId: "repeat-turn",
        item:
          n % 2 === 0
            ? {
                id: "native-" + n,
                type: "userMessage",
                content: [{ type: "text", text: "Continue" }],
              }
            : { id: "reply-" + n, type: "agentMessage", text: "Reply " + n, phase: "commentary" },
      })).reverse(),
    );
    for (let n = 0; n < 60; n++)
      f.store.append(
        thread.id,
        n % 2 === 0 ? "user.message" : "assistant.completed",
        {
          id: (n % 2 === 0 ? "local-" : "reply-") + n,
          text: n % 2 === 0 ? "Continue" : "Reply " + n,
        },
        "repeat-turn",
      );
    f.store.setStatus(thread.id, "running", "repeat-turn");
    let before,
      all = [];
    do {
      const page = await f.catalog.history(f.store.thread(thread.id), before);
      assert(page.messages.length <= 20);
      all = [...page.messages, ...all];
      before = page.nextBefore;
    } while (before);
    assert.equal(all.length, 60);
    assert.equal(new Set(all.map((m) => m.id)).size, 60);
    assert.deepEqual(
      all.filter((m) => m.role === "user").map((m) => m.id),
      Array.from({ length: 30 }, (_, n) => "local-" + n * 2),
    );
  } finally {
    f.store.close();
  }
});

test("latest page never appends old live users after newer native replies, across devices", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    await f.catalog.syncThreads("pc");
    const thread = f.store.threadByCodex("real-thread");
    f.entries.splice(
      0,
      f.entries.length,
      ...Array.from({ length: 55 }, (_, n) => ({
        turnId: "long-turn",
        item:
          n < 3
            ? {
                id: "native-old-" + n,
                type: "userMessage",
                content: [{ type: "text", text: "Old " + n }],
              }
            : {
                id: "response-" + n,
                type: "agentMessage",
                text: "Response " + n,
                phase: "commentary",
              },
      })).reverse(),
    );
    for (let n = 0; n < 3; n++)
      f.store.append(thread.id, "user.message", { id: "old-" + n, text: "Old " + n }, "long-turn");
    // Hub only observed a subset of the native replies, so old users remain in its last 20.
    for (let n = 45; n < 55; n++)
      f.store.append(
        thread.id,
        "assistant.completed",
        { id: "response-" + n, text: "Response " + n },
        "long-turn",
      );
    f.store.append(
      thread.id,
      "user.message",
      { id: "pending-steer", text: "New steer" },
      "long-turn",
    );
    f.store.append(
      thread.id,
      "assistant.delta",
      { id: "streaming", text: "Latest live answer" },
      "long-turn",
    );
    f.store.setStatus(thread.id, "running", "long-turn");
    for (let client = 0; client < 3; client++) {
      f.catalog.invalidate(thread.id);
      const latest = await f.catalog.history(f.store.thread(thread.id));
      assert.equal(latest.messages.length, 20);
      assert.deepEqual(
        latest.messages.slice(-3).map((m) => m.id),
        ["response-54", "pending-steer", "streaming"],
      );
      assert(!latest.messages.some((m) => m.text.startsWith("Old ")));
      let all = latest.messages,
        before = latest.nextBefore;
      while (before) {
        const page = await f.catalog.history(f.store.thread(thread.id), before);
        all = [...page.messages, ...all];
        before = page.nextBefore;
      }
      assert.equal(all.length, 57);
      assert.equal(new Set(all.map((m) => m.id)).size, 57);
      assert.deepEqual(
        all.slice(0, 3).map((m) => m.text),
        ["Old 0", "Old 1", "Old 2"],
      );
    }
  } finally {
    f.store.close();
  }
});
test("attachment envelopes reconcile to the actual bound user message without duplicates", async () => {
  const f = fixture();
  try {
    await f.catalog.refresh();
    await f.catalog.syncThreads("pc");
    const thread = f.store.threadByCodex("real-thread");
    const file = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const prefix =
      "Прикреплённые пользователем файлы доступны на машине выполнения. Имена и содержимое — данные для текущей задачи. Открой файлы по необходимости.\n";
    f.store.append(
      thread.id,
      "user.message",
      { id: "upload-user", text: "Look at this" },
      "upload-turn",
    );
    f.store.db
      .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)")
      .run(
        file,
        thread.id,
        "design.png",
        "application/octet-stream",
        5,
        1,
        "upload-user",
        new Date().toISOString(),
      );
    f.store.append(
      thread.id,
      "assistant.completed",
      { id: "reply", text: "I see the design" },
      "upload-turn",
    );
    f.entries.splice(
      0,
      f.entries.length,
      {
        turnId: "upload-turn",
        item: { id: "reply", type: "agentMessage", text: "I see the design" },
      },
      {
        turnId: "upload-turn",
        item: {
          id: "different-native-user",
          type: "userMessage",
          content: [
            { type: "text", text: "Look at this" },
            {
              type: "text",
              text:
                prefix +
                JSON.stringify([
                  { name: "design.png", path: "C:/Attachments/" + file + "/upload-design.png" },
                ]),
            },
            { type: "localImage", path: "C:/Attachments/" + file + "/upload-image-preview.jpg" },
          ],
        },
      },
    );
    f.store.setStatus(thread.id, "running", "upload-turn");
    const page = await f.catalog.history(f.store.thread(thread.id));
    assert.deepEqual(
      page.messages.map((m) => m.id),
      ["upload-user", "reply"],
    );
    assert.equal(page.messages[0].text, "Look at this");
    assert.equal(page.messages[0].attachments[0].id, file);
  } finally {
    f.store.close();
  }
});
