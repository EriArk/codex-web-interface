import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { GptHistoryNormalizer } from "../apps/hub/dist/gpt-history.js";
import { GptHistoryDisk } from "../apps/hub/dist/gpt-history-disk.js";

const graph = (count = 1000) => ({
  current_node: `m${count - 1}`,
  codex_native_assets: true,
  mapping: Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `m${i}`,
      {
        id: `m${i}`,
        parent: i ? `m${i - 1}` : null,
        message: {
          id: `m${i}`,
          author: { role: i % 2 ? "assistant" : "user" },
          channel: "final",
          recipient: "all",
          status: "finished_successfully",
          create_time: i,
          content: { content_type: "text", parts: ["content " + i + "x".repeat(2000)] },
        },
      },
    ]),
  ),
});
test("canonical normalization reuses public nodes, detects old edits, branch replacement and late files", () => {
  const normalizer = new GptHistoryNormalizer(),
    raw = graph();
  const first = normalizer.normalize(raw, "chat");
  const again = normalizer.normalize(structuredClone(raw), "chat");
  assert.ok(first.every((m, i) => m === again[i]));
  raw.mapping.m11.message.content.parts = ["edited older answer"];
  raw.mapping.m999.message.metadata = {
    attachments: [{ id: "file", name: "late.png", mime_type: "image/png" }],
  };
  const changed = normalizer.normalize(raw, "chat");
  assert.equal(changed[0], first[0]);
  assert.notEqual(changed[11], first[11]);
  assert.equal(changed.at(-1).files[0].id, "file");
  raw.current_node = "m10";
  const shortened = normalizer.normalize(raw, "chat");
  assert.equal(shortened.length, 11);
  assert.equal(shortened[0], first[0]);
  raw.mapping.m3.message.channel = "analysis";
  assert.equal(
    normalizer.normalize(raw, "chat").some((m) => m.id === "m3"),
    false,
  );
  assert.notEqual(normalizer.normalize(raw, "other")[0], first[0]);
});
test("disk writes suffixes, restores exact history, compacts interrupted append and accepts legacy snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-delta-"));
  try {
    let now = Date.now();
    const disk = new GptHistoryDisk(root, () => now),
      normalizer = new GptHistoryNormalizer();
    const cache = new GptHistoryCache(
        async () => [],
        () => now,
        disk,
      ),
      raw = graph();
    cache.seed("chat", normalizer.normalize(raw, "chat"));
    const path = join(
      root,
      readdirSync(root).find((x) => x.endsWith(".json")),
    );
    const initial = readFileSync(path, "utf8");
    raw.mapping.m999.message.content.parts = ["changed final"];
    now += 20000;
    const expected = normalizer.normalize(raw, "chat");
    cache.seed("chat", expected);
    assert.equal(readFileSync(path, "utf8"), initial);
    assert.ok(readFileSync(path + ".delta").length < 1500);
    const restarted = new GptHistoryDisk(root, () => now);
    assert.deepEqual(restarted.read("chat").items, expected);
    // Incomplete final write is ignored; the next write replaces the damaged journal atomically.
    appendFileSync(path + ".delta", '{"epoch":');
    const recovery = new GptHistoryDisk(root, () => now);
    assert.deepEqual(recovery.read("chat").items, expected);
    const next = new GptHistoryCache(
      async () => expected,
      () => now,
      recovery,
    );
    await next.snapshot("chat");
    expected[0] = { ...expected[0], text: "early change" };
    next.seed("chat", expected, ++now);
    assert.deepEqual(new GptHistoryDisk(root, () => now).read("chat").items, expected);
    assert.equal(
      readdirSync(root).some((x) => x.endsWith(".delta")),
      false,
    );
    // Existing version 1 snapshots migrate on the next accepted refresh.
    writeFileSync(path, JSON.stringify({ version: 1, checkedAt: now, items: expected }));
    assert.deepEqual(new GptHistoryDisk(root, () => now).read("chat").items, expected);
    recovery.remove("chat");
    assert.equal(readdirSync(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("branch truncation and a different delta base never mix histories", () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-branch-"));
  try {
    const disk = new GptHistoryDisk(root),
      normalizer = new GptHistoryNormalizer();
    const cache = new GptHistoryCache(async () => [], Date.now, disk),
      raw = graph(20);
    cache.seed("chat", normalizer.normalize(raw, "chat"));
    raw.current_node = "m5";
    const shortened = normalizer.normalize(raw, "chat");
    cache.seed("chat", shortened);
    assert.deepEqual(new GptHistoryDisk(root).read("chat").items, shortened);
    const path = join(
      root,
      readdirSync(root).find((x) => x.endsWith(".delta")),
    );
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.base = "wrong";
    writeFileSync(path, JSON.stringify(record) + "\n");
    assert.equal(new GptHistoryDisk(root).read("chat"), undefined);
    // Compaction survived, stale old-generation journal must not resurrect another branch.
    record.epoch = "old-generation";
    writeFileSync(path, JSON.stringify(record) + "\n");
    assert.equal(new GptHistoryDisk(root).read("chat").items.length, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
