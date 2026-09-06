import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLimits } from "../apps/hub/dist/usage.js";

test("weekly usage is identified by window length, not primary/secondary position; private billing fields are omitted", () => {
  const week = { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1789307281 };
  const result = normalizeLimits({
    rateLimits: { limitId: "codex", primary: week, credits: { balance: "private" } },
    rateLimitsByLimitId: {
      codex: { limitName: null, primary: week },
      spark: {
        limitName: "Spark",
        primary: { usedPercent: 110, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1789307281 },
      },
    },
  });
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups[0], {
    id: "codex",
    name: "Codex",
    windows: [{ minutes: 10080, remainingPercent: 96, resetsAt: 1789307281 }],
  });
  assert.equal(result.groups[1].windows[0].minutes, 10080);
  assert.equal(result.groups[1].windows[1].remainingPercent, 0);
  assert(!JSON.stringify(result).includes("private"));
  assert.equal(
    normalizeLimits({ rateLimits: { primary: week } }).groups[0].windows[0].remainingPercent,
    96,
  );
  for (const value of [
    null,
    {},
    { rateLimits: { primary: { usedPercent: NaN, windowDurationMins: 10080 } } },
  ]) {
    assert.equal(normalizeLimits(value).available, false);
  }
});
