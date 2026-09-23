import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerGpt } from "../apps/hub/dist/gpt.js";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { GptResultIndex } from "../apps/hub/dist/gpt-result-index.js";
import { gptResults } from "../apps/hub/dist/gpt-results.js";
import { Store } from "../apps/hub/dist/store.js";
import Fastify from "../apps/hub/node_modules/fastify/fastify.js";
import { mergeGptHistory } from "../apps/web/src/gptState.ts";
import { firstResultPage, mergeResultUpdate } from "../apps/web/src/resultState.ts";
import { configSchema, HubError } from "../packages/shared/dist/index.js";

const messages = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? "assistant" : "user",
    createdAt: i + 1,
    text: `Message ${i} ` + "x".repeat(2000),
    files: [],
    complete: true,
  }));
const previews = { inline: (_chat, id) => `demo-${id}` };
const file = (i) => ({
  id: `f${i}`,
  name: `${i}.txt`,
  url: `/api/gpt/files/f${i}`,
  bytes: 10,
  mime: "text/plain",
  image: false,
});

test("history sends only changed suffix, preserves loaded older objects and scroll, detects equal-length edits", async () => {
  let list = messages(1000),
    writes = 0;
  const cache = new GptHistoryCache(async () => list, Date.now, {
    write() {
      writes++;
    },
    read() {},
  });
  const first = await cache.page("c", {});
  let view = mergeGptHistory(undefined, first);
  view = mergeGptHistory(view, await cache.page("c", { before: view.before }), true);
  view.scrollTop = 321;
  view.sticky = false;
  const object = view.messages[0];
  cache.seed("c", structuredClone(list));
  assert.equal(writes, 1);
  list = messages(1002);
  cache.seed("c", list);
  const delta = await cache.page("c", { known: view.revision, delta: "1" });
  assert.equal(delta.items.length, 2);
  assert.ok(JSON.stringify(delta).length < JSON.stringify(first).length / 5);
  view = mergeGptHistory(view, delta);
  assert.equal(view.messages.length, 42);
  assert.equal(view.messages[0], object);
  assert.equal(view.scrollTop, 321);
  list[1001].text = list[1001].text.replace("Message", "Changed");
  cache.seed("c", list);
  const edit = await cache.page("c", { known: view.revision, delta: "1" });
  assert.equal(edit.items.length, 1);
  view = mergeGptHistory(view, edit);
  assert.match(view.messages.at(-1).text, /^Changed/);
  list = list.slice(0, -1);
  cache.seed("c", list);
  view = mergeGptHistory(view, await cache.page("c", { known: view.revision, delta: "1" }));
  assert.equal(view.messages.at(-1).id, "m1000");
  assert.equal(writes, 4);
});

test("history branches and missed bursts fall back canonically; incorrect delta base is rejected", async () => {
  const cache = new GptHistoryCache(async () => messages(60));
  let view = mergeGptHistory(undefined, await cache.page("c", {}));
  const branch = messages(60);
  branch[50].id = "branch";
  branch[50].text = "branch";
  cache.seed("c", branch);
  const update = await cache.page("c", { known: view.revision, delta: "1" });
  assert.throws(() => mergeGptHistory({ ...view, revision: "wrong" }, update), /MISMATCH/);
  view = mergeGptHistory(view, update);
  assert.equal(view.messages[10].id, "branch");
  cache.seed("c", messages(100));
  assert.equal((await cache.page("c", { known: view.revision, delta: "1" })).delta, undefined);
  assert.equal((await cache.page("c", { known: "expired", delta: "1" })).items.length, 20);
});

test("indexed projection exactly matches canonical ordering, duplicate links, files, images and public reasoning", () => {
  const list = messages(8);
  list[1].text =
    "[one](https://example.com/a) [two](https://example.com/b) ![picture](https://example.com/p.png)\n```html\n<!doctype html><html><body>Hello</body></html>\n```";
  list[1].files = [file(1), file(2)];
  list[3].files = [{ ...file(1), image: true, name: "changed.png" }];
  list[5].text = "[again](https://example.com/a)";
  const index = new GptResultIndex("c", previews);
  index.update(list);
  assert.deepEqual(index.items, gptResults("c", list, previews));
  const previous = index.items;
  index.update(list);
  assert.equal(index.items, previous);
});

test("result delta preserves paged cards, removes changed files, and rejects unknown versions", () => {
  const list = messages(100);
  for (const m of list) if (m.role === "assistant") m.files = [file(m.id)];
  const index = new GptResultIndex("c", previews);
  index.update(list);
  const first = index.page("files"),
    older = index.page("files", first.nextBefore);
  let view = { ...older, items: [...first.items, ...older.items] };
  const stable = view.items[5];
  const added = [
    ...list,
    ...messages(2).map((m, i) => ({ ...m, id: `new${i}`, files: i ? [file("new")] : [] })),
  ];
  index.update(added);
  const delta = index.page("files", undefined, view.revision);
  assert.ok(delta.delta);
  assert.equal(delta.items.length, 1);
  view = mergeResultUpdate(view, delta);
  assert.equal(view.items.length, 41);
  assert.equal(view.items[6], stable);
  assert.equal(firstResultPage(view).items.length, 20);
  const changed = [...added];
  changed[101] = { ...changed[101], files: [] };
  index.update(changed);
  view = mergeResultUpdate(view, index.page("files", undefined, view.revision));
  assert.equal(view.items.length, 40);
  const unchanged = index.page("files", undefined, view.revision);
  assert.equal(mergeResultUpdate(view, unchanged).items, view.items);
  assert.equal(index.page("files", undefined, "unknown").reset, true);
  assert.throws(() => mergeResultUpdate(undefined, delta), /MISMATCH/);
  const oldEdit = [...changed];
  oldEdit[1] = { ...changed[1], files: [] };
  index.update(oldEdit);
  assert.equal(index.page("files", undefined, view.revision).reset, true);
});

test("unchanged history avoids reparsing demos and artifact blocks, changed messages alone are projected", () => {
  let calls = 0;
  const counter = {
    inline: (_c, id) => {
      calls++;
      return id;
    },
  };
  const list = messages(100);
  for (const m of list)
    if (m.role === "assistant")
      m.text = "```html\n<!doctype html><html><body>Demo</body></html>\n```";
  const cache = new GptHistoryCache(async () => list);
  const index = new GptResultIndex("c", counter);
  index.update(cache.seed("c", list).items);
  assert.equal(calls, 50);
  index.update(cache.seed("c", structuredClone(list)).items);
  assert.equal(calls, 50);
  list[99].text += " amended";
  index.update(cache.seed("c", list).items);
  assert.equal(calls, 51);
});

test("several small missed result bursts reset instead of leaving a gap between loaded pages", () => {
  let list = messages(2);
  list[1].files = Array.from({ length: 30 }, (_, i) => file(i));
  const index = new GptResultIndex("c", previews);
  index.update(list);
  const before = index.page("files");
  for (let batch = 0; batch < 2; batch++) {
    list = [
      ...list,
      {
        ...list[1],
        id: `batch${batch}`,
        files: Array.from({ length: 12 }, (_, i) => file(`${batch}-${i}`)),
      },
    ];
    index.update(list);
  }
  const next = index.page("files", undefined, before.revision);
  assert.equal(next.reset, true);
  assert.equal(next.items.length, 20);
  assert.equal(next.counts.files, 54);
});

test("unchanged disk snapshots refresh hourly and restart retains content revision without a delta journal", async () => {
  let now = 1000,
    saved,
    writes = 0;
  const disk = {
    write(_id, items, checkedAt) {
      writes++;
      saved = { items: structuredClone(items), checkedAt };
    },
    read() {
      return saved;
    },
  };
  const cache = new GptHistoryCache(
    async () => messages(2),
    () => now,
    disk,
  );
  const first = await cache.page("c", {});
  now += 60000;
  cache.seed("c", messages(2));
  assert.equal(writes, 1);
  now += 3600000;
  cache.seed("c", messages(2));
  assert.equal(writes, 2);
  const restored = new GptHistoryCache(
    async () => messages(2),
    () => now,
    disk,
  );
  assert.equal(
    (await restored.page("c", { known: first.revision, delta: "1" }, 60000, true)).notModified,
    true,
  );
  assert.equal(writes, 2);
});

test("actual Hub routes negotiate private deltas and still enforce deletion and revoked access", async () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-delta-routes-"));
  const stores = [],
    apps = [],
    services = [];
  let revoked = false;
  try {
    for (let account = 0; account < 2; account++) {
      const store = new Store(":memory:");
      stores.push(store);
      const app = Fastify();
      apps.push(app);
      app.setErrorHandler((e, _req, reply) =>
        reply.code(e.statusCode ?? 500).send({ code: e.code }),
      );
      const service = registerGpt(
        app,
        configSchema.parse({
          hub: {
            publicBaseUrl: "https://test.invalid",
            databasePath: ":memory:",
            resultsPath: join(root, String(account)),
          },
          auth: {},
          machines: [],
          projects: [],
        }),
        store,
        () => {
          if (revoked) throw new HubError(403, "REVOKED", "Revoked");
        },
      );
      await app.ready();
      await service.close();
      services.push(service);
    }
    let list = messages(2);
    list[1].files = [file(1)];
    services[0].historyCache.seed("chat", list);
    services[1].historyCache.seed("chat", []);
    const url = "/api/gpt/conversations/chat/results?category=files";
    const initial = (await apps[0].inject(url)).json();
    assert.equal(initial.items.length, 1);
    assert.equal(
      (await apps[0].inject(url + "&known=" + initial.revision)).json().notModified,
      true,
    );
    assert.equal((await apps[1].inject(url + "&known=" + initial.revision)).json().items.length, 0);
    list = [...list, { ...list[1], id: "new", files: [file(2)] }];
    services[0].historyCache.seed("chat", list);
    const next = await apps[0].inject(url + "&known=" + initial.revision);
    assert.equal(next.statusCode, 200);
    assert.equal(next.json().delta.baseRevision, initial.revision);
    assert.equal(next.json().items.length, 1);
    assert.equal((await apps[0].inject("/api/gpt/conversations/chat/results/f2")).statusCode, 200);
    services[0].library.save("thread", "chat", { deleted: true });
    assert.equal((await apps[0].inject(url + "&known=" + initial.revision)).statusCode, 404);
    services[0].library.save("thread", "chat", { deleted: false });
    revoked = true;
    assert.equal((await apps[0].inject(url + "&known=" + initial.revision)).statusCode, 403);
  } finally {
    for (const app of apps) await app.close();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
