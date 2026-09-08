import assert from "node:assert/strict";
import test from "node:test";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { gptProgress, mergeGptProgress } from "../apps/hub/dist/gpt-progress.js";
import { mergeGptHistory, mergeGptJobs } from "../apps/web/src/gptState.ts";

const messages = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: "m" + i,
    role: i % 2 ? "assistant" : "user",
    text: "message " + i,
    files: [],
    createdAt: i,
  }));
test("GPT history shares native reads, confirms unchanged pages and preserves explicit older pages", async () => {
  let calls = 0,
    now = 1000,
    list = messages(60);
  const cache = new GptHistoryCache(
    async () => {
      calls++;
      await Promise.resolve();
      return list;
    },
    () => now,
  );
  const [first, second] = await Promise.all([cache.page("chat", {}), cache.page("chat", {})]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.items.length, 20);
  let client = mergeGptHistory(undefined, first);
  const older = await cache.page("chat", { before: client.before });
  client = mergeGptHistory(client, older, true);
  assert.equal(client.messages.length, 40);
  assert.equal(calls, 1);
  const unchanged = await cache.page("chat", { known: client.revision });
  assert.equal(unchanged.notModified, true);
  assert.equal(unchanged.items.length, 0);
  client.scrollTop = 742;
  client.sticky = false;
  assert.equal(mergeGptHistory(client, unchanged).scrollTop, 742);
  now += 16000;
  list = messages(62);
  const latest = await cache.page("chat", {
    known: client.revision,
    anchor: client.anchor,
    prefix: client.prefix,
  });
  assert.equal(latest.retainOlder, true);
  client = mergeGptHistory(client, latest);
  assert.equal(client.messages.length, 42);
  assert.equal(client.messages.at(-1).id, "m61");
  assert.equal(client.before, "m20");
  assert.equal(client.sticky, false);
  assert.equal(calls, 2);
  now += 16000;
  list = messages(62);
  list[10] = { ...list[10], text: "edited native branch" };
  const changed = await cache.page("chat", {
    known: client.revision,
    anchor: client.anchor,
    prefix: client.prefix,
  });
  assert.equal(changed.retainOlder, false);
  assert.equal(mergeGptHistory(client, changed).messages.length, 20);
  now += 16000;
  list = messages(4);
  await assert.rejects(cache.page("chat", { before: "m20" }), /История изменилась/);
});
test("GPT public stages whitelist short native DOM labels and preserve stages after disappearance", () => {
  const label = {
    id: "dom-label",
    kind: "thinking",
    source: "cot-v5",
    visible: true,
    active: true,
    text: "Проверяю варианты",
  };
  const event = { type: "assistant.progress.snapshot", source: "tab.observation", items: [label] };
  const accepted = gptProgress(event);
  assert.equal(accepted[0].text, label.text);
  assert.deepEqual(Object.keys(accepted[0]).sort(), ["id", "state", "text"]);
  for (const item of [
    { ...label, visible: false },
    { ...label, kind: "tool_status" },
    { ...label, source: "analysis" },
    { ...label, text: "x".repeat(501) },
    { ...label, text: "https://private.example/?token=PRIVATE" },
  ])
    assert.deepEqual(gptProgress({ ...event, items: [item] }), []);
  assert.deepEqual(gptProgress({ type: "thinking.snapshot", text: "PRIVATE", items: [label] }), []);
  assert.deepEqual(gptProgress({ ...event, source: "forced_snapshot" }), []);
  const next = gptProgress({
    ...event,
    items: [{ ...label, id: "second", text: "Сопоставляю результат" }],
  });
  const merged = mergeGptProgress(accepted, next);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].state, "completed");
  assert.deepEqual(mergeGptProgress(merged, []), merged);
});
test("GPT job summaries cannot erase retained answers and late snapshots cannot regress state", () => {
  const old = {
    id: "a",
    nativeId: "chat",
    status: "running",
    text: "prompt",
    answer: "answer",
    progress: [{ text: "Public step" }],
    createdAt: 1,
    updatedAt: 10,
  };
  assert.equal(mergeGptJobs([old], []).length, 1);
  const unchanged = [old];
  assert.equal(mergeGptJobs(unchanged, []), unchanged);
  const result = mergeGptJobs(
    [old],
    [{ ...old, text: "", answer: "", status: "completed", summaryOnly: true, updatedAt: 20 }],
  );
  assert.equal(result[0].answer, "answer");
  assert.equal(result[0].status, "completed");
  assert.equal(mergeGptJobs(result, [old])[0].status, "completed");
});

test("Late GPT polling cannot resurrect a dismissed outbox item or its cached contents", () => {
  const job = {
    id: "deleted",
    status: "failed",
    text: "Old question",
    files: [],
    assets: [],
    answer: "",
    createdAt: 1,
    updatedAt: 2,
  };
  const dismissed = mergeGptJobs([job], [{ ...job, dismissed: true }]);
  assert.equal(dismissed[0].text, "");
  const late = mergeGptJobs(dismissed, [{ ...job, updatedAt: 3 }]);
  assert.equal(late[0].dismissed, true);
  assert.equal(late[0].text, "");
  assert.deepEqual(late[0].files, []);
  assert.deepEqual(late[0].progress, []);
});
