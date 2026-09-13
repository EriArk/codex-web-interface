import assert from "node:assert/strict";
import test from "node:test";
import {
  beginGptHistory,
  clearGptCache,
  currentGptHistory,
  flushGptCache,
  gptCache,
  gptCacheEpoch,
} from "../apps/web/src/gptCache.ts";

test("late GPT history cannot replace a newer request or resurrect a signed-out session", () => {
  clearGptCache();
  const first = beginGptHistory("a"),
    second = beginGptHistory("a"),
    other = beginGptHistory("b");
  assert.equal(currentGptHistory("a", first), false);
  assert.equal(currentGptHistory("a", second), true);
  assert.equal(currentGptHistory("b", other), true);
  const epoch = gptCacheEpoch();
  gptCache.jobs = [{ answer: "private conversation" }];
  clearGptCache();
  assert.notEqual(gptCacheEpoch(), epoch);
  assert.equal(currentGptHistory("a", second), false);
  assert.equal(gptCache.jobs.length, 0);
});

test("a large outbox cannot erase every saved conversation on reload", () => {
  const oldStorage = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = {
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  try {
    clearGptCache();
    gptCache.chats.current = {
      messages: [
        { id: "answer", role: "assistant", text: "Retained final", files: [], createdAt: 1 },
      ],
      checkedAt: Date.now(),
      revision: "r",
      before: null,
      prefix: "",
      anchor: "answer",
      scrollTop: 55,
      sticky: false,
    };
    gptCache.jobs = [{ id: "large", answer: "x".repeat(1900000) }];
    flushGptCache();
    const saved = JSON.parse(values.get("gpt-view-cache-v1"));
    assert.equal(saved.data.chats.current.messages[0].text, "Retained final");
    assert.equal(saved.data.chats.current.scrollTop, 55);
    assert.equal(saved.data.jobs.length, 0);
    assert.equal(gptCache.jobs[0].answer.length, 1900000, "memory receipt is not deleted");
  } finally {
    clearGptCache();
    globalThis.sessionStorage = oldStorage;
  }
});
