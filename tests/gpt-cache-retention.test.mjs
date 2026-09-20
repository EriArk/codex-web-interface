import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { GptHistoryDisk } from "../apps/hub/dist/gpt-history-disk.js";
import { gptResults } from "../apps/hub/dist/gpt-results.js";

const messages = (text = "Saved") => [
  { id: "message", role: "assistant", text, files: [], createdAt: 1 },
];

test("Results uses retained file metadata immediately, then coalesces canonical refresh", async () => {
  let now = 1000,
    reads = 0,
    release;
  const cache = new GptHistoryCache(
    () => {
      reads++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    () => now,
  );
  cache.setPinned(["chat"]);
  cache.seed("chat", [
    {
      ...messages()[0],
      files: [
        {
          id: "archive",
          name: "large.zip",
          url: "/api/gpt/results/archive",
          mime: "application/zip",
          bytes: 400 * 1024 ** 2,
          image: false,
        },
      ],
    },
  ]);
  now += 3600000;
  const saved = await cache.snapshot("chat", 60000, true);
  const results = gptResults("chat", saved.items, {
    inline() {
      throw new Error("No demo preload");
    },
  });
  assert.equal(results[0].title, "large.zip");
  assert.equal(reads, 0);
  assert(JSON.stringify(saved).length < 2000, "400 MiB archive retains metadata only");
  const refresh = cache.snapshot("chat");
  const overlapping = cache.snapshot("chat");
  assert.equal(reads, 1);
  release(messages("Fresh"));
  assert.equal((await refresh).items[0].text, "Fresh");
  assert.equal((await overlapping).items[0].text, "Fresh");
});

test("viewing renews thirty-minute retention; pins and ten recent unpinned chats do not expire", async () => {
  let now = 1000,
    reads = 0;
  const cache = new GptHistoryCache(
    async () => {
      reads++;
      return messages();
    },
    () => now,
  );
  cache.setPinned(["pin"]);
  cache.setRecent(["pin", ...Array.from({ length: 11 }, (_, i) => `recent-${i}`)]);
  for (const id of [
    "pin",
    "viewed",
    "expired",
    ...Array.from({ length: 11 }, (_, i) => `recent-${i}`),
  ])
    cache.seed(id, messages());
  now += 20 * 60000;
  await cache.page("viewed", {}, Infinity, true);
  now += 15 * 60000;
  assert.equal(cache.peek("viewed").length, 1);
  assert.equal(cache.peek("expired").length, 0);
  assert.equal(cache.peek("pin").length, 1);
  for (let i = 0; i < 10; i++) assert.equal(cache.peek(`recent-${i}`).length, 1);
  assert.equal(cache.peek("recent-10").length, 0);
  cache.setPinned([]);
  cache.setRecent([]);
  assert.equal(cache.peek("pin").length, 0);
  assert.equal(cache.peek("recent-0").length, 0);
  assert.equal(reads, 0, "retention does not poll native GPT");
});

test("count pressure evicts least-used ordinary history before retained chats", async () => {
  let now = 1000;
  const cache = new GptHistoryCache(
    async () => messages(),
    () => now,
  );
  cache.setPinned(["pin"]);
  cache.setRecent(["recent"]);
  cache.seed("pin", messages());
  cache.seed("recent", messages());
  for (let i = 0; i < 30; i++) {
    now++;
    cache.seed(`other-${i}`, messages());
  }
  now++;
  await cache.page("other-0", {}, Infinity, true);
  now++;
  cache.seed("new", messages());
  assert.equal(cache.peek("other-1").length, 0);
  for (const id of ["pin", "recent", "other-0", "new"]) assert.equal(cache.peek(id).length, 1);
});

test("the memory budget still applies when every conversation is pinned", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `pin-${i}`);
  let now = 1000;
  const cache = new GptHistoryCache(
    async () => messages(),
    () => now++,
  );
  cache.setPinned(ids);
  for (const id of ids) cache.seed(id, messages("x".repeat(600000)));
  const count = ids.filter((id) => cache.peek(id).length).length;
  assert(count > 0 && count < 32);
  assert.equal(cache.peek("pin-39").length, 1);
});

test("pins restore saved history without native reads; reopening old disk history is immediate", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gpt-cache-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1000,
    reads = 0,
    release;
  const disk = new GptHistoryDisk(root, () => now);
  disk.write("pin", [{ ...messages()[0], activity: "search", phase: "commentary" }], now);
  disk.write("recent", messages(), now);
  disk.write("visited", messages(), now);
  now += 3600000;
  const cache = new GptHistoryCache(
    () => {
      reads++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    () => now,
    disk,
  );
  cache.setPinned(["pin"]);
  cache.setRecent(["recent"]);
  assert.equal(cache.peek("pin")[0].activity, "search");
  assert.equal(cache.peek("recent").length, 1);
  assert.equal(reads, 0);
  const page = await cache.page("visited", { known: "old" }, 60000, true);
  assert.equal(page.items[0].text, "Saved");
  assert.equal(reads, 1, "only the opened chat revalidates in background");
  release(messages("Updated"));
  await cache.snapshot("visited", 0);
  assert.equal(cache.peek("visited")[0].text, "Updated");
});
