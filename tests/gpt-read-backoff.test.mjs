import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { GptReadBackoff } from "../apps/hub/dist/gpt-read-backoff.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";

test("history cooldown honors Retry-After, grows on repeated throttling and survives late success", () => {
  let now = 1000000;
  const backoff = new GptReadBackoff(() => now);
  assert.equal(backoff.fail(429, "90").code, "GPT_HISTORY_RATE_LIMITED");
  now += 61000;
  backoff.success();
  assert.throws(() => backoff.check(), { statusCode: 429 });
  now += 29000;
  backoff.check();
  backoff.fail(429, "invalid");
  now += 119000;
  assert.throws(() => backoff.check());
  now += 1000;
  backoff.check();
  backoff.success();
  backoff.fail(503, null);
  now += 15000;
  backoff.check();
  backoff.success();
  backoff.fail(429, new Date(now + 180000).toUTCString());
  now += 179000;
  assert.throws(() => backoff.check());
  now += 1000;
  backoff.check();
});

test("concurrent history consumers share a read and rate limiting never repeats it or blocks health/writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gpt-read-")),
    store = new Store(":memory:");
  let reads = 0,
    writes = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = createServer(async (req, res) => {
    if (req.url.startsWith("/conversation?")) {
      reads++;
      await gate;
      res.writeHead(429, { "Retry-After": "120", "Content-Type": "application/json" });
      res.end("{}");
    } else {
      if (req.method === "POST") writes++;
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.GPT_BACKOFF_TEST = "fixture-token";
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
        tokenSecret: "GPT_BACKOFF_TEST",
      },
    }),
    store,
  );
  t.after(async () => {
    release();
    await service.close();
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    delete process.env.GPT_BACKOFF_TEST;
  });
  const first = service.json("/conversation?id=one"),
    second = service.json("/conversation?id=one");
  release();
  const result = await Promise.allSettled([first, second]);
  assert(
    result.every((r) => r.status === "rejected" && r.reason.code === "GPT_HISTORY_RATE_LIMITED"),
  );
  assert.equal(reads, 1);
  for (const id of ["one", "two", "one"])
    await assert.rejects(service.historyCache.page(id, {}), { code: "GPT_HISTORY_RATE_LIMITED" });
  assert.equal(reads, 1, "different clients and chats respect the account-wide cooldown");
  assert.equal((await service.json("/status")).ok, true);
  assert.equal((await service.json("/bridge/test-write", { text: "fixture" })).ok, true);
  assert.equal(writes, 1);
});
