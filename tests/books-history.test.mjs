import assert from "node:assert/strict";
import test from "node:test";
import { Catalog } from "../apps/hub/dist/catalog.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema, HubError } from "../packages/shared/dist/index.js";

test("slow legacy history returns a bounded tail and preserves every older message", async (t) => {
  let elapsed = 0,
    pages = 0;
  t.mock.method(performance, "now", () => elapsed);
  const store = new Store(":memory:");
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://test.local",
      databasePath: ":memory:",
      resultsPath: "/tmp/books-history-test",
    },
    auth: {},
    machines: [{ id: "pc", name: "PC", type: "local-linux" }],
    projects: [{ id: "books", name: "Books", machineId: "pc", workingDirectory: "/tmp" }],
  });
  const thread = store.createThread("books", "native-books", "History");
  store.db.prepare("UPDATE threads SET origin='desktop' WHERE id=?").run(thread.id);
  const rpc = {
    request: async (method, p) => {
      if (method === "thread/read")
        return { thread: { id: "native-books", cwd: "/tmp", updatedAt: 1 } };
      if (method === "thread/items/list")
        throw new HubError(400, "CODEX_METHOD_UNSUPPORTED", "legacy");
      assert.equal(method, "thread/turns/list");
      pages++;
      elapsed += 8000;
      const n = Number(p.cursor || 0);
      return {
        data: [
          {
            id: "turn-" + n,
            items: [
              {
                id: "user-" + n,
                type: "userMessage",
                content: [{ type: "text", text: "Question " + n }],
              },
              { id: "answer-" + n, type: "agentMessage", text: "Answer " + n },
            ],
          },
        ],
        nextCursor: n < 2 ? String(n + 1) : null,
      };
    },
  };
  const catalog = new Catalog(config, store, async () => rpc);
  try {
    let page = await catalog.history(store.thread(thread.id));
    assert.equal(pages, 1, "do not run four ~8s calls to fill 20 messages");
    assert.deepEqual(
      page.messages.map((m) => m.id),
      ["user-0", "answer-0"],
    );
    assert.equal(page.hasMore, true);
    const all = [...page.messages];
    while (page.nextBefore) {
      page = await catalog.history(store.thread(thread.id), page.nextBefore);
      all.unshift(...page.messages);
    }
    assert.equal(pages, 3);
    const ordinary = rpc.request;
    rpc.request = async (method, params) => {
      if (method === "thread/items/list") elapsed += 6000;
      return ordinary(method, params);
    };
    catalog.invalidate(thread.id);
    const deferred = await catalog.history(store.thread(thread.id));
    assert.equal(deferred.messages.length, 0);
    assert.equal(deferred.hasMore, true);
    const resumed = await catalog.history(store.thread(thread.id), deferred.nextBefore);
    assert.deepEqual(
      resumed.messages.map((m) => m.id),
      ["user-0", "answer-0"],
      "a budget exhausted during method fallback must not lose the initial native page",
    );

    assert.equal(all.length, 6);
    assert.equal(new Set(all.map((m) => m.id)).size, 6);
    assert.deepEqual(
      all.map((m) => m.id),
      ["user-2", "answer-2", "user-1", "answer-1", "user-0", "answer-0"],
    );
  } finally {
    store.close();
  }
});

test("history stays coalesced past the old cache TTL while native read is pending", async (t) => {
  let now = Date.now(),
    reads = 0,
    release;
  t.mock.method(Date, "now", () => now);
  const store = new Store(":memory:");
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://test.local",
      databasePath: ":memory:",
      resultsPath: "/tmp/books-history-test",
    },
    auth: {},
    machines: [{ id: "pc", name: "PC", type: "local-linux" }],
    projects: [{ id: "books", name: "Books", machineId: "pc", workingDirectory: "/tmp" }],
  });
  const thread = store.createThread("books", "native-books", "History");
  store.db.prepare("UPDATE threads SET origin='desktop' WHERE id=?").run(thread.id);
  const wait = new Promise((resolve) => (release = resolve));
  const catalog = new Catalog(config, store, async () => ({
    request: async (method) => {
      if (method === "thread/read") {
        reads++;
        await wait;
        return { thread: { id: "native-books", cwd: "/tmp", updatedAt: 1 } };
      }
      return { data: [], nextCursor: null };
    },
  }));
  try {
    const first = catalog.history(store.thread(thread.id));
    await new Promise((resolve) => setImmediate(resolve));
    now += 8000;
    const second = catalog.history(store.thread(thread.id));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    release();
    assert.deepEqual(await first, await second);
    now += 1000;
    await catalog.history(store.thread(thread.id));
    assert.equal(reads, 1, "settled cache starts after the slow read finishes");
  } finally {
    release();
    store.close();
  }
});
