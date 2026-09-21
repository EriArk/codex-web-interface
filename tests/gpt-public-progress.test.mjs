import assert from "node:assert/strict";
import test from "node:test";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { gptHistory } from "../apps/hub/dist/gpt-history.js";
import { gptResults, resultPage } from "../apps/hub/dist/gpt-results.js";
import { nativeActivity } from "../ops/gpt-native/public-activity.mjs";

test("activity exposes a bounded category, never tool arguments, output or thoughts", () => {
  const message = {
    author: { role: "assistant" },
    recipient: "api_tool.call_tool",
    content: {
      parts: [JSON.stringify({ path: "/mcp/github/search", args: { private: "SECRET" } })],
    },
  };
  assert.deepEqual(nativeActivity(message), { kind: "search", text: "Поиск", state: "active" });
  assert.equal(
    nativeActivity({ ...message, metadata: { is_visually_hidden_from_conversation: true } }),
    null,
  );
  assert.equal(nativeActivity({ ...message, recipient: "all", channel: "analysis" }), null);
  assert.equal(nativeActivity({ ...message, recipient: "unknown_tool" }), null);
  assert.doesNotMatch(JSON.stringify(nativeActivity(message)), /SECRET|args|path/);
});

test("Results groups public intermediate output and the final answer by exact request", () => {
  const user = (id) => ({ id, role: "user", text: "Question " + id, files: [], createdAt: 1 });
  const step = {
    id: "step",
    role: "assistant",
    text: "Public explanation",
    phase: "commentary",
    complete: true,
    files: [],
    createdAt: 2,
  };
  const items = gptResults(
    "chat",
    [user("u1"), step, { ...step, id: "final", phase: "final", text: "Final answer" }, user("u2")],
    { inline: () => null },
  );
  const page = resultPage(items, "reasoning");
  assert.equal(page.counts.reasoning, 2);
  assert.equal(page.counts.work, 0);
  assert.equal(page.items[0].turnId, "u2");
  assert.deepEqual(page.items[0].payload.steps, []);
  assert.equal(page.items[1].payload.steps[0].text, "Public explanation");
  assert.deepEqual(page.items[1].payload.steps.map(({ id, text, state }) => ({ id, text, state })), [
    { id: "step", text: "Public explanation", state: "completed" },
    { id: "final", text: "Final answer", state: "completed" },
  ]);
  const parsed = gptHistory({
    current_node: "s",
    mapping: {
      s: {
        id: "s",
        message: {
          id: "s",
          author: { role: "assistant" },
          channel: "commentary",
          recipient: "all",
          content: { content_type: "text", parts: ["Поиск"] },
          metadata: { codex_activity: "search" },
        },
      },
    },
  });
  assert.equal(parsed[0].activity, "search");
});

test("active chat warming coalesces, serves cached history immediately, and keeps completion", async () => {
  let release,
    reads = 0,
    now = 1000;
  const cache = new GptHistoryCache(
    async () => {
      reads++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    () => now,
  );
  const old = [{ id: "a", role: "assistant", text: "Previous", files: [], createdAt: 1 }];
  cache.seed("active", old);
  cache.warm("active");
  cache.warm("active");
  assert.equal(reads, 1);
  const page = await cache.page("active", {}, 15000, true);
  assert.equal(page.items[0].text, "Previous");
  assert.equal(page.stale, undefined);
  release([...old, { ...old[0], id: "b", text: "New public output" }]);
  await cache.snapshot("active", 0);
  assert.equal((await cache.page("active", {})).items.length, 2);
  now += 5000;
  cache.warm("active");
  assert.equal(reads, 1);
  cache.warm("active", true);
  assert.equal(reads, 2, "completion bypasses the running refresh budget");
  release([{ ...old[0], text: "Final" }]);
  await cache.snapshot("active", 0);
  assert.equal(cache.peek("active")[0].text, "Final");
  assert.equal(cache.peek("inactive").length, 0);
});

test("deleting a chat during background refresh never resurrects its snapshot", async () => {
  let release;
  const cache = new GptHistoryCache(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  cache.warm("deleted");
  cache.remove("deleted");
  release([{ id: "secret", role: "assistant", text: "private", files: [], createdAt: 1 }]);
  await assert.rejects(cache.snapshot("deleted", 0), /./);
  assert.deepEqual(cache.peek("deleted"), []);
});
