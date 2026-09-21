import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerGpt } from "../apps/hub/dist/gpt.js";
import { gptResultContent } from "../apps/hub/dist/gpt-result-content.js";
import { gptResults } from "../apps/hub/dist/gpt-results.js";
import {
  GPT_TEXT_LIMIT,
  GptTextArtifacts,
  textExcerpt,
} from "../apps/hub/dist/gpt-text-artifacts.js";
import { Previews } from "../apps/hub/dist/previews.js";
import { Store } from "../apps/hub/dist/store.js";
import Fastify from "../apps/hub/node_modules/fastify/fastify.js";
import { configSchema, HubError } from "../packages/shared/dist/index.js";

test("public fenced blocks retain exact CRLF, identity and frozen versions; replay is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-text-")),
    store = new Store(":memory:");
  try {
    const artifacts = new GptTextArtifacts(root, store),
      previews = new Previews(root, store, () => {
        throw Error();
      });
    const body = "Привет 👍\r\n  spaces\r\n" + "line\r\n".repeat(19);
    const text = "Ordinary prose\r\n\r\n```markdown\r\n" + body + "```\r\n";
    const blocks = gptResultContent(text).blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, body);
    assert.equal(gptResultContent("```js\nunfinished").blocks.length, 0);
    const message = {
      id: "m",
      role: "assistant",
      phase: "final",
      complete: true,
      text,
      files: [],
      createdAt: 1,
    };
    const first = gptResults("chat", [message], previews, undefined, artifacts)[0];
    assert.equal(first.turnId, "m");
    assert.equal(first.payload.bytes, Buffer.byteLength(body));
    assert.equal(readFileSync(artifacts.describe(first.id.slice(5)).path, "utf8"), body);
    assert.deepEqual(gptResults("chat", [message], previews, undefined, artifacts)[0], first);
    assert.equal(store.db.prepare("SELECT count(*) n FROM gpt_text_artifacts").get().n, 1);
    const revised = gptResults(
      "chat",
      [{ ...message, text: text.replace("spaces", "changed") }],
      previews,
      undefined,
      artifacts,
    )[0];
    assert.notEqual(revised.id, first.id);
    assert.equal(readFileSync(artifacts.describe(first.id.slice(5)).path, "utf8"), body);
    assert.notEqual(
      gptResults("other-chat", [message], previews, undefined, artifacts)[0].id,
      first.id,
    );
    for (const patch of [{ role: "user" }, { phase: "commentary" }, { complete: false }])
      assert(
        !gptResults("chat", [{ ...message, ...patch }], previews, undefined, artifacts).some((r) =>
          r.id.startsWith("text-"),
        ),
      );
    assert(textExcerpt("x".repeat(100000)).length < 1300);
    assert(textExcerpt("line\n".repeat(100)).split("\n").length <= 7);
    const large = artifacts.put(
      "chat",
      "large",
      { index: 0, text: "x".repeat(GPT_TEXT_LIMIT + 1), language: "" },
      "",
    );
    assert(!large.payload.url);
    assert.match(large.payload.message, /2 МБ/);
    const limited = new GptTextArtifacts(root, store, 0).put(
      "chat",
      "quota",
      { index: 0, text: "quota", language: "" },
      "",
    );
    assert(!limited.payload.url);
    assert(limited.payload.message);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated routes stream frozen files and reveal only the exact long message block", async () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-text-http-"));
  const stores = [new Store(":memory:"), new Store(":memory:")],
    apps = [];
  let revoked = false;
  try {
    const services = [];
    for (let index = 0; index < 2; index++) {
      const config = configSchema.parse({
        hub: {
          publicBaseUrl: "https://test.invalid",
          databasePath: ":memory:",
          resultsPath: join(root, String(index)),
        },
        auth: {},
        machines: [],
        projects: [],
      });
      const app = Fastify();
      apps.push(app);
      app.setErrorHandler((e, _req, reply) =>
        reply.code(e.statusCode ?? e.status ?? 500).send({ code: e.code }),
      );
      const service = registerGpt(app, config, stores[index], () => {
        if (revoked) throw new HubError(403, "REVOKED", "Revoked");
      });
      await app.ready();
      await service.close();
      services.push(service);
    }
    const item = services[0].textArtifacts.put(
      "chat",
      "m",
      { index: 1, text: "exact\r\n👍\n", language: "md" },
      "",
    );
    const response = await apps[0].inject(item.payload.url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "exact\r\n👍\n");
    assert.match(response.headers["content-disposition"], /attachment.*\.md/);
    assert.equal((await apps[1].inject(item.payload.url)).statusCode, 404);
    services[0].library.save("thread", "chat", { deleted: true });
    assert.equal((await apps[0].inject(item.payload.url)).statusCode, 404);
    services[0].library.save("thread", "chat", { deleted: false });
    revoked = true;
    assert.equal((await apps[0].inject(item.payload.url)).statusCode, 403);
    revoked = false;
    const body = "long\r\n".repeat(21),
      text = "Before\r\n\r\n```md\r\n" + body + "```\r\nAfter";
    const message = {
      id: "reply",
      role: "assistant",
      text,
      files: [],
      createdAt: 1,
      complete: true,
    };
    services[0].historyCache.messages = async (id) => (id === "chat" ? [message] : []);
    const block = gptResultContent(text).blocks[0];
    const reference = {
      source: `text-block:${block.offset}:${createHash("sha256").update(body).digest("hex")}`,
      messageId: "reply",
    };
    const reveal = (ref, chat = "chat") =>
      apps[0].inject({
        method: "POST",
        url: `/api/gpt/conversations/${chat}/results/reveal`,
        payload: ref,
      });
    const exact = await reveal(reference);
    assert.equal(exact.statusCode, 200);
    assert.equal((await apps[0].inject(exact.json().payload.url)).body, body);
    assert.equal((await reveal({ ...reference, messageId: "other" })).statusCode, 404);
    assert.equal((await reveal(reference, "other")).statusCode, 404);
    message.text = text.replace("long", "changed");
    assert.equal((await reveal(reference)).statusCode, 404);
  } finally {
    for (const app of apps) await app.close();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("1 to 20 lines remain in chat; 21 lines export without renumbering or losing images/links", () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-block-policy-")),
    store = new Store(":memory:");
  try {
    const artifacts = new GptTextArtifacts(root, store),
      previews = new Previews(root, store, () => {
        throw Error();
      });
    const text =
      [1, 20, 21].map((n) => "```md\r\n" + "line\r\n".repeat(n) + "```").join("\r\n\r\n") +
      "\n\n![Web](https://example.org/image.png)\n\n[Source](https://example.org/page)";
    const items = gptResults(
      "chat",
      [{ id: "m", role: "assistant", text, files: [], createdAt: 1, complete: true }],
      previews,
      undefined,
      artifacts,
    );
    assert.equal(items.filter((x) => x.id.startsWith("text-")).length, 1);
    assert.equal(store.db.prepare("SELECT blockIndex FROM gpt_text_artifacts").get().blockIndex, 2);
    assert.equal(items.find((x) => x.type === "image").title, "Web");
    assert.equal(items.filter((x) => x.type === "link").length, 1);
    assert.equal(gptResultContent("```md\nunfinished\n".repeat(1)).blocks.length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
