import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { gptHistory } from "../apps/hub/dist/gpt-history.js";
import { gptSandboxFiles } from "../apps/hub/dist/gpt-sandbox-files.js";
import { Store } from "../apps/hub/dist/store.js";
import { readAsset } from "../ops/gpt/browser-assets.mjs";
import { configSchema } from "../packages/shared/dist/index.js";

const body =
  "[Markdown](sandbox:/mnt/data/test.md) [JSON](sandbox:/mnt/data/test.json) [TXT](sandbox:/mnt/data/test.txt)";
const raw = {
  current_node: "answer",
  mapping: {
    answer: {
      message: {
        id: "answer",
        author: { role: "assistant" },
        channel: "final",
        content: { content_type: "text", parts: [body] },
      },
    },
  },
};
test("canonical GPT sandbox downloads retain names and become scoped Hub links/results", () => {
  const [message] = gptHistory(raw, "conversation");
  assert.equal(message.files.length, 3);
  assert.deepEqual(
    message.files.map((f) => f.name),
    ["test.md", "test.json", "test.txt"],
  );
  for (const file of message.files) {
    assert.match(file.url, /^\/api\/gpt\/downloads\/conversation\/answer\/sandbox-[a-f0-9]{64}$/);
    assert(message.text.includes(file.url));
  }
  assert.doesNotMatch(message.text, /sandbox:\//);
  assert.notEqual(gptHistory(raw, "other")[0].files[0].id, message.files[0].id);
});
test("sandbox mapping preserves code, encoded filenames and excludes traversal or hidden branches", () => {
  const code =
    "```md\n[Example](sandbox:/mnt/data/example.txt)\n```\n`[Example](sandbox:/mnt/data/inline.txt)`";
  assert.equal(gptSandboxFiles(code, "c", "m").text, code);
  const named = gptSandboxFiles(
    "[File](<sandbox:/mnt/data/%D1%82%D0%B5%D1%81%D1%82%20one.txt>)",
    "c",
    "m",
  );
  assert.equal(named.files[0].name, "тест one.txt");
  for (const path of [
    "/etc/passwd",
    "/mnt/data/../secret",
    "/mnt/data/%2e%2e/secret",
    "/mnt/data/%252e%252e/secret",
    "/mnt/data/a%5cb",
    "/mnt/data/a%00b",
    "/mnt/data//x",
  ])
    assert.equal(gptSandboxFiles(`[File](sandbox:${path})`, "c", "m").files.length, 0);
  const hidden = structuredClone(raw);
  hidden.mapping.answer.message.channel = "analysis";
  assert.equal(gptHistory(hidden, "c").length, 0);
});
test("download resolver revalidates the visible answer before fetching native file bytes", async () => {
  const calls = [],
    root = mkdtempSync(join(tmpdir(), "gpt-download-")),
    store = new Store(":memory:");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://test");
    calls.push(url);
    if (url.pathname === "/conversation")
      res.setHeader("Content-Type", "application/json").end(JSON.stringify(raw));
    else if (url.pathname === "/sandbox-file")
      res.setHeader("Content-Type", "text/plain").end("original bytes\n");
    else res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.GPT_DOWNLOAD_TEST_TOKEN = "fixture-token";
  const config = configSchema.parse({
    hub: { publicBaseUrl: "https://example.test", databasePath: ":memory:", resultsPath: root },
    auth: {},
    machines: [],
    projects: [],
    gpt: {
      endpoint: `http://127.0.0.1:${server.address().port}`,
      tokenSecret: "GPT_DOWNLOAD_TEST_TOKEN",
    },
  });
  const service = new GptService(config, store);
  try {
    const key = gptHistory(raw, "conversation")[0].files[2].id;
    const result = await service.sandboxFile("conversation", "answer", key);
    assert.equal(await result.response.text(), "original bytes\n");
    assert.equal(calls.at(-1).searchParams.get("path"), "/mnt/data/test.txt");
    for (const [c, m, k] of [
      ["other", "answer", key],
      ["conversation", "other", key],
      ["conversation", "answer", "sandbox-" + "0".repeat(64)],
    ])
      await assert.rejects(service.sandboxFile(c, m, k), { code: "GPT_RESULT_NOT_FOUND" });
    assert.equal(calls.filter((c) => c.pathname === "/sandbox-file").length, 1);
  } finally {
    await service.close();
    store.close();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
    delete process.env.GPT_DOWNLOAD_TEST_TOKEN;
  }
});
test("native sandbox downloader keeps authentication in its origin and transfers bytes with bounded destination", async () => {
  const oldFetch = globalThis.fetch,
    oldLocation = globalThis.location,
    calls = [];
  globalThis.location = { origin: "https://chatgpt.com" };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/api/auth/session")) return Response.json({ accessToken: "private" });
    if (String(url).includes("/interpreter/download"))
      return Response.json({ download_url: "https://files.oaiusercontent.com/file" });
    return new Response("test bytes", { headers: { "content-type": "text/plain" } });
  };
  try {
    const result = await readAsset({ evaluate: (fn, args) => fn(args) }, null, {
      conversationId: "c",
      messageId: "m",
      path: "/mnt/data/a b.txt",
    });
    assert.equal(Buffer.from(result.base64, "base64").toString(), "test bytes");
    const endpoint = new URL(calls[1].url, "https://chatgpt.com");
    assert.equal(endpoint.pathname, "/backend-api/conversation/c/interpreter/download");
    assert.equal(endpoint.searchParams.get("sandbox_path"), "/mnt/data/a b.txt");
    assert.equal(calls[2].options.credentials, "omit");
    assert.equal(calls[2].options.headers, undefined);
    assert.equal(calls[2].options.redirect, "error");
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.location = oldLocation;
  }
});
