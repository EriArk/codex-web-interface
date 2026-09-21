import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { gptResults, resultPage } from "../apps/hub/dist/gpt-results.js";
import { Previews } from "../apps/hub/dist/previews.js";
import { Store } from "../apps/hub/dist/store.js";
import { resultCategory } from "../packages/shared/dist/index.js";

test("result category pagination finds older media without downloading technical pages", () => {
  const store = new Store(":memory:");
  try {
    const thread = store.createThread("p", "native", "Results"),
      other = store.createThread("p", "other", "Other");
    for (let n = 0; n < 45; n++)
      store.result(thread.id, "turn", String(n), "image", "Image " + n, { url: "/image/" + n });
    store.result(other.id, "turn", "private", "image", "Other thread", {});
    for (let n = 0; n < 70; n++) store.result(thread.id, "turn", "check" + n, "check", "Check", {});
    store.result(thread.id, "turn", "demo", "preview", "Demo", {});
    store.result(thread.id, "turn", "file", "file", "File", {});
    const first = store.results(thread.id, undefined, "images");
    assert.equal(first.items.length, 20);
    assert.equal(first.counts.images, 45);
    assert.equal(first.counts.work, 70);
    assert(first.items.every((r) => r.type === "image"));
    const second = store.results(thread.id, first.nextBefore, "images"),
      third = store.results(thread.id, second.nextBefore, "images");
    assert.equal(
      new Set([...first.items, ...second.items, ...third.items].map((r) => r.id)).size,
      45,
    );
    assert.equal(third.nextBefore, null);
    assert.throws(() => store.resultById(other.id, first.items[0].id), {
      code: "RESULT_NOT_FOUND",
    });
    assert.equal(store.resultById(thread.id, first.items[0].id).type, "image");
    assert.equal(resultCategory("unrecognized-future-result"), "work");
  } finally {
    store.close();
  }
});
test("GPT results contain only assistant artifacts and inline HTML from the current native branch", async () => {
  const store = new Store(":memory:"),
    root = await mkdtemp(join(tmpdir(), "gpt-result-test-"));
  try {
    const previews = new Previews(root, store, () => {
      throw Error("Must not resolve a Windows machine for inline GPT HTML");
    });
    const file = (id, image) => ({
      id,
      name: id,
      mime: image ? "image/png" : "text/plain",
      url: "/api/gpt/assets/" + id,
      image,
      bytes: 0,
    });
    const fence = String.fromCharCode(96).repeat(3),
      html = "<main><button onclick=\"this.textContent='Done'\">Go</button></main>";
    const messages = [
      { id: "u", role: "user", text: "User input", createdAt: 1, files: [file("file-user", true)] },
      ...Array.from({ length: 45 }, (_, n) => ({
        id: "a" + n,
        role: "assistant",
        text: n === 0 ? fence + "html\n" + html + "\n" + fence : "Answer",
        createdAt: n + 2,
        files: [file("file-" + n, n % 2 === 0)],
      })),
    ];
    let loads = 0,
      current = messages;
    const cache = new GptHistoryCache(async () => {
      loads++;
      return current;
    });
    await cache.page("native-123456789", {});
    const results = gptResults(
      "native-123456789",
      await cache.messages("native-123456789"),
      previews,
    );
    assert.equal(loads, 1);
    assert(!results.some((r) => r.id === "file-user"));
    assert.equal(results.length, 47); // 45 files, one demo and the request's response history.
    const first = resultPage(results, "images"),
      second = resultPage(results, "images", first.nextBefore);
    assert.equal(first.items.length, 20);
    assert.equal(second.items.length, 3);
    assert.equal(second.nextBefore, null);
    assert.equal(first.counts.demos, 1);
    assert.equal(first.counts.files, 22);
    const demo = results.find((r) => r.type === "preview");
    assert.equal(previews.thread(demo.id), "gpt:native-123456789");
    assert((await previews.document(demo.id)).includes(html));
    assert.equal(
      gptResults("native-123456789", messages, previews).find((r) => r.type === "preview").id,
      demo.id,
    );
    cache.invalidate("native-123456789");
    current = [messages[0]];
    const replaced = gptResults("native-123456789", await cache.messages("native-123456789"), previews);
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].type, "reasoning");
    assert.deepEqual(replaced[0].payload.steps, []);
    assert.throws(() => resultPage(results, "images", "missing"), { code: "RESULTS_CHANGED" });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GPT result lineage survives normal appends and invalidation but changes on native regeneration", async () => {
  let items = [{ id: "one", role: "assistant", text: "A", createdAt: 1, files: [] }];
  const cache = new GptHistoryCache(async () => items);
  const first = await cache.snapshot("chat");
  items = [...items, { id: "two", role: "assistant", text: "B", createdAt: 2, files: [] }];
  cache.invalidate("chat");
  assert.equal((await cache.snapshot("chat")).lineage, first.lineage);
  items = [{ ...items[0], text: "Updated" }, items[1]];
  cache.invalidate("chat");
  assert.equal((await cache.snapshot("chat")).lineage, first.lineage);
  items = [items[0], { ...items[1], id: "regenerated" }];
  cache.invalidate("chat");
  assert.notEqual((await cache.snapshot("chat")).lineage, first.lineage);
});

test("GPT links use visible Markdown, exact public URLs, stable identities and separate counts", () => {
  const demoHtml = [];
  const previews = {
    inline: (_scope, _id, html) => {
      demoHtml.push(html);
      return "demo-id";
    },
  };
  const messages = [
    {
      id: "user",
      role: "user",
      createdAt: 1,
      files: [],
      text: "[User source](https://example.org/user)",
    },
    {
      id: "reply",
      role: "assistant",
      createdAt: 2,
      files: [],
      text: [
        "[Documentation](<https://example.org/doc?q=1&b=2>)",
        "[Reference][ref] and https://example.org/plain.",
        "[ref]: https://example.org/reference",
        "[Local](https://hub.test/api/artifacts/file)",
        "[Credentials](https://user:pass@example.org/private)",
        "[File](sandbox:/mnt/data/test.zip)",
        "![Image](https://example.org/image.png)",
        "`https://example.org/code`",
        "```text\nhttps://example.org/fenced\n```",
        "````markdown\n```html\n<div>Only an example</div>\n```\n````",
        "```html\n<div>Real demo</div>\n```",
        "[Bad](javascript:alert(1))",
      ].join("\n\n"),
    },
    {
      id: "latest",
      role: "assistant",
      createdAt: 3,
      files: [],
      text: "[Latest documentation](https://example.org/doc?q=1&b=2)",
    },
  ];
  const items = gptResults("chat", messages, previews, "https://hub.test");
  const page = resultPage(items, "links");
  assert.equal(page.counts.links, 4);
  assert.equal(page.counts.demos, 1);
  assert.deepEqual(demoHtml, ["<div>Real demo</div>"]);
  assert.equal(page.counts.work, 0);
  assert.equal(page.counts.reasoning, 1);
  assert.equal(page.counts.all, 6);
  assert.equal(page.items[0].title, "Latest documentation");
  assert.equal(page.items[0].turnId, "latest");
  assert.equal(
    page.items[0].id,
    gptResults("chat", messages.slice(0, 2), previews, "https://hub.test").find(
      (r) => r.payload.url === "https://example.org/doc?q=1&b=2",
    ).id,
  );
  assert.deepEqual(
    new Set(page.items.map((r) => r.payload.url)),
    new Set([
      "https://example.org/user",
      "https://example.org/doc?q=1&b=2",
      "https://example.org/reference",
      "https://example.org/plain",
    ]),
  );
  const many = gptResults(
    "chat",
    [
      {
        ...messages[0],
        text: Array.from({ length: 24 }, (_, i) => `https://example.org/${i}`).join("\n\n"),
      },
    ],
    previews,
  );
  const first = resultPage(many, "links"),
    second = resultPage(many, "links", first.nextBefore);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 4);
  assert.equal(second.nextBefore, null);
});
