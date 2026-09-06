import assert from "node:assert/strict";
import test from "node:test";
import { Catalog } from "../apps/hub/dist/catalog.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema, HubError } from "../packages/shared/dist/index.js";

const config = configSchema.parse({
  hub: {
    publicBaseUrl: "https://codex.example.test",
    databasePath: ":memory:",
    resultsPath: "/tmp/codex-test",
  },
  auth: {},
  machines: [{ id: "pc", name: "PC", type: "local-linux" }],
  projects: [{ id: "p", name: "Project", machineId: "pc", workingDirectory: "/tmp" }],
});
test("legacy result navigation restores the saved native turn cursor instead of showing the latest turn", async () => {
  const store = new Store(":memory:");
  const turns = Array.from({ length: 45 }, (_, n) => ({
    id: "t" + n,
    items: [
      { id: "u" + n, type: "userMessage", content: [{ type: "text", text: "Question " + n }] },
      { id: "a" + n, type: "agentMessage", text: "Answer " + n, phase: "final_answer" },
    ],
  })).reverse();
  const raw = { id: "native", cwd: "/tmp", name: "Legacy", historyMode: "legacy", updatedAt: 100 };
  const rpc = {
    request: async (method, p) => {
      if (method === "thread/read") return { thread: raw };
      if (method === "thread/items/list")
        throw new HubError(502, "CODEX_RPC_ERROR", "Unsupported legacy item pagination");
      if (method === "thread/turns/list") {
        const start = Number(p.cursor ?? 0);
        return {
          data: turns.slice(start, start + 1),
          nextCursor: start + 1 < turns.length ? String(start + 1) : null,
        };
      }
      throw new Error(method);
    },
  };
  const c = new Catalog(config, store, async () => rpc);
  try {
    const t = c.importThread(c.projects()[0], raw);
    const first = await c.history(t);
    const second = await c.history(t, first.nextBefore);
    const target = second.messages[0].turnId;
    const context = await c.history(t, undefined, target);
    assert.equal(context.contextTurn, target);
    assert(context.messages.length > 0);
    assert(context.messages.every((m) => m.turnId === target));
    assert.equal(context.messages.at(-1).text, "Answer " + target.slice(1));
  } finally {
    store.close();
  }
});
test("an unsent web draft renders empty without reading an unpersisted native rollout", async () => {
  const store = new Store(":memory:");
  try {
    const catalog = new Catalog(config, store, async () => {
      throw new Error("Must not contact Codex");
    });
    const t = store.createThread("p", "draft", "Draft");
    store.db.prepare("UPDATE threads SET historyMode='paginated' WHERE id=?").run(t.id);
    const page = await catalog.history(store.thread(t.id));
    assert.equal(page.messages.length, 0);
    assert.equal(page.hasMore, false);
  } finally {
    store.close();
  }
});
