import assert from "node:assert/strict";
import test from "node:test";
import {
  beginGptHistory,
  clearGptCache,
  currentGptHistory,
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
