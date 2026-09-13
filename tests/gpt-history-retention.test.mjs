import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { gptHistory } from "../apps/hub/dist/gpt-history.js";
import { GptHistoryDisk } from "../apps/hub/dist/gpt-history-disk.js";
import { Store } from "../apps/hub/dist/store.js";
import { showGptJob } from "../apps/web/src/gptState.ts";
import { configSchema, HubError } from "../packages/shared/dist/index.js";

const publicBranch = () => {
  const node = (id, parent, role, channel, text, extra = {}) => ({
    id,
    parent,
    message: {
      id,
      author: { role },
      channel,
      recipient: "all",
      status: "finished_successfully",
      create_time: 10,
      content: { content_type: "text", parts: [text] },
      ...extra,
    },
  });
  return {
    current_node: "final",
    mapping: {
      user: node("user", null, "user", null, "Question"),
      step: node("step", "user", "assistant", "commentary", "Checking the public result"),
      tool: node("tool", "step", "assistant", "commentary", "PRIVATE_TOOL", {
        recipient: "api_tool.call_tool",
      }),
      hidden: node("hidden", "tool", "assistant", "analysis", "PRIVATE_THOUGHT"),
      final: node("final", "hidden", "assistant", "final", "Final answer"),
    },
  };
};

test("cold engine restart during native 429 retains paged public commentary and final, then replaces a changed branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-retention-"));
  let now = Date.now();
  try {
    const disk = new GptHistoryDisk(root, () => now);
    const first = new GptHistoryCache(
      async () => gptHistory(publicBranch()),
      () => now,
      disk,
    );
    const observed = await first.page("chat", {});
    assert.deepEqual(
      observed.items.map((m) => m.id),
      ["user", "step", "final"],
    );
    assert.equal(observed.items[1].phase, "commentary");
    assert.equal(observed.items[2].complete, true);
    assert.doesNotMatch(
      readFileSync(join(root, readdirSync(root)[0]), "utf8"),
      /PRIVATE|mapping|recipient/,
    );
    now += 61000;
    let failing = true;
    const next = new GptHistoryCache(
      async () => {
        if (failing) throw new HubError(429, "GPT_HISTORY_RATE_LIMITED", "Native cooling down");
        const branch = publicBranch();
        branch.mapping.final.message.content.parts = ["Edited final on current branch"];
        return gptHistory(branch);
      },
      () => now,
      new GptHistoryDisk(root, () => now),
    );
    const restored = await next.page("chat", {});
    assert.equal(restored.stale, true);
    assert.deepEqual(restored.items, observed.items);
    assert.equal((await next.snapshot("chat")).items.length, 3);
    const unchanged = await next.page("chat", { known: observed.revision });
    assert.equal(unchanged.notModified, true);
    assert.equal(unchanged.stale, true);
    // Background presentation fallback cannot satisfy a fresh action/search read.
    await assert.rejects(next.messages("chat"), (e) => e.code === "GPT_HISTORY_RATE_LIMITED");
    failing = false;
    const fresh = await next.page("chat", { known: observed.revision });
    assert.equal(fresh.stale, undefined);
    assert.match(fresh.items.at(-1).text, /Edited final/);
    assert.notEqual(fresh.revision, observed.revision);
    next.remove("chat");
    assert.equal(readdirSync(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained history never hides authentication, deletion or unknown source errors", async () => {
  for (const error of [
    new HubError(403, "GPT_LOGIN_REQUIRED", "Login"),
    new HubError(404, "GPT_HISTORY_UNAVAILABLE", "Gone"),
    new Error("Bad data"),
  ]) {
    const cache = new GptHistoryCache(async () => {
      throw error;
    });
    cache.seed("chat", gptHistory(publicBranch()));
    cache.invalidate("chat");
    await assert.rejects(cache.page("chat", {}), (e) => e === error);
  }
});

test("commentary cannot acknowledge a completed answer or make it disappear during a long history outage", () => {
  const all = gptHistory(publicBranch()),
    now = 900000;
  const job = {
    id: "job",
    nativeId: "chat",
    status: "completed",
    text: "Question",
    answer: "Final answer",
    files: [],
    assets: [],
    createdAt: 10000,
    updatedAt: 12000,
  };
  assert.equal(showGptJob(job, all.slice(0, 2), 13000), true);
  assert.equal(showGptJob(job, all.slice(0, 2), now, [job], true), true);
  assert.equal(showGptJob(job, all, now, [job], true), false);
  assert.equal(showGptJob(job, all.slice(0, 2), now, [job], false), false);
  assert.equal(showGptJob(job, [{ ...all[0], createdAt: 100 }, all[2]], now, [job], true), false);
});

test("display and completion share recent native reads while mutation preconditions remain fresh", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gpt-read-sharing-")),
    store = new Store(":memory:");
  let reads = 0;
  const server = createServer((req, res) => {
    reads++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(publicBranch()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.GPT_RETAIN_TEST = "fixture-token";
  const service = new GptService(
    configSchema.parse({
      hub: {
        publicBaseUrl: "https://codex.example.test",
        databasePath: ":memory:",
        resultsPath: root,
      },
      auth: {},
      machines: [],
      projects: [],
      gpt: {
        endpoint: `http://127.0.0.1:${server.address().port}`,
        tokenSecret: "GPT_RETAIN_TEST",
      },
    }),
    store,
  );
  t.after(async () => {
    await service.close();
    store.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
    delete process.env.GPT_RETAIN_TEST;
  });
  await service.historyCache.page("chat", {});
  await service.readConversation("chat");
  await service.historyCache.snapshot("chat");
  service.historyCache.invalidate("chat");
  await service.historyCache.page("chat", {});
  assert.equal(
    reads,
    1,
    "display/results/completion/final invalidation share the same recent read",
  );
  await service.json("/conversation?id=chat");
  assert.equal(reads, 2, "explicit edit/version preconditions still require a new read");
});

test("late native reads cannot recreate a deleted disk snapshot", async () => {
  let release;
  const load = new Promise((r) => {
    release = r;
  });
  const cache = new GptHistoryCache(() => load);
  const pending = cache.page("chat", {});
  cache.remove("chat");
  release(gptHistory(publicBranch()));
  await assert.rejects(pending, (e) => e.statusCode === 404);
  assert.deepEqual(cache.peek("chat"), []);
});
