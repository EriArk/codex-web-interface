import assert from "node:assert/strict";
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
    const body = "Привет 👍\r\n  spaces\r\n\r\n";
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

test("authenticated routes stream frozen files, reject revocation/cross-account IDs and coalesce Canvas metadata", async () => {
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
    let calls = 0;
    services[0].workspaceWork.canvases = async (id) => {
      calls++;
      await Promise.resolve();
      return {
        items: [
          {
            id: "doc",
            conversationId: id,
            title: "Notes",
            type: "document",
            content: "private body",
            version: 3,
            revision: "r",
          },
        ],
      };
    };
    const [a, b] = await Promise.all([
      services[0].canvasResults("chat"),
      services[0].canvasResults("chat"),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    assert.equal(a[0].payload.canvas.id, "doc");
    assert(!JSON.stringify(a).includes("private body"));
    assert.equal((await services[0].canvasResults("chat"))[0].id, a[0].id);
    assert.equal(calls, 1);
    assert.deepEqual(await services[1].canvasResults("chat", true), []);
    const exact = await apps[0].inject("/api/gpt/conversations/chat/results/" + a[0].id);
    assert.equal(exact.statusCode, 200);
    assert.equal(exact.json().payload.canvas.id, "doc");
  } finally {
    for (const app of apps) await app.close();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
