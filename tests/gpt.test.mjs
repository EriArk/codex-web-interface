import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import {
  gptCompletion,
  gptHistory,
  gptProjectConversations,
  gptProjects,
} from "../apps/hub/dist/gpt-history.js";
import { Store } from "../apps/hub/dist/store.js";
import { showGptJob } from "../apps/web/src/gptState.ts";
import { configSchema } from "../packages/shared/dist/index.js";

const waitUntil = async (fn) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 5000) throw Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
function history() {
  const node = (id, parent, role, content, extra = {}) => ({
    id,
    parent,
    message: { id, author: { role }, content, create_time: 100, metadata: {}, ...extra },
  });
  const text = (parts) => ({ content_type: "text", parts: [parts] });
  return {
    current_node: "final",
    mapping: {
      user: node("user", null, "user", text("hello")),
      thought: node(
        "thought",
        "user",
        "assistant",
        { content_type: "thoughts", thoughts: [{ content: "PRIVATE_REASONING" }] },
        { channel: "analysis" },
      ),
      tool: node("tool", "thought", "tool", text("PRIVATE_TOOL_LOG"), { channel: "commentary" }),
      image: node(
        "image",
        "tool",
        "tool",
        {
          content_type: "multimodal_text",
          parts: [
            {
              content_type: "image_asset_pointer",
              asset_pointer: "sediment://file_image",
              size_bytes: 123,
            },
          ],
        },
        { channel: "final", metadata: { image_gen_title: "Green circle" } },
      ),
      hidden: node("hidden", "image", "tool", text("PRIVATE_IMAGE_CAPTION"), {
        metadata: { is_visually_hidden_from_conversation: true },
      }),
      final: node("final", "hidden", "assistant", text("Done"), {
        channel: "final",
        status: "finished_successfully",
        metadata: { is_complete: true },
      }),
      abandoned: node("abandoned", "user", "assistant", text("OLD_BRANCH")),
    },
  };
}
test("GPT history follows the selected branch and exposes visible images without hidden reasoning", () => {
  const data = history(),
    messages = gptHistory(data),
    serialized = JSON.stringify(messages);
  assert.deepEqual(
    messages.map((m) => m.id),
    ["user", "image", "final"],
  );
  assert.equal(messages[1].files[0].url, "/api/gpt/assets/file_image");
  assert.doesNotMatch(serialized, /PRIVATE_|OLD_BRANCH/);
  assert.equal(gptCompletion(data, "hello", 100000).complete, true);
  assert.equal(gptCompletion(data, "another prompt", 100000).complete, false);
  assert.equal(gptCompletion(data, "hello", 200000).complete, false);
  data.mapping.final.message.metadata.is_complete = false;
  assert.equal(gptCompletion(data, "hello", 100000).complete, false);
});
test("GPT projects use actual nested native project metadata", () => {
  const data = {
    items: [
      {
        gizmo: {
          gizmo: {
            id: "g-p-project",
            display: { name: "Real project" },
            author: { user_email: "PRIVATE" },
          },
        },
        conversations: {
          items: [
            {
              id: "native-chat",
              title: "Conversation",
              gizmo_id: "g-p-project",
              update_time: "2026-09-06T12:00:00Z",
            },
          ],
        },
      },
    ],
  };
  assert.deepEqual(gptProjects(data), [{ id: "g-p-project", name: "Real project" }]);
  assert.equal(gptProjectConversations(data)[0].updatedAt, 1788696000);
  assert.doesNotMatch(JSON.stringify(gptProjects(data)), /PRIVATE/);
});
test("GPT sends survive client closure, serialize jobs, reject conflicting retries and omit private events", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gpt-test-")),
    requests = [],
    streams = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url, body });
    if (req.url === "/bridge/chat") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        "data: " +
          JSON.stringify({ type: "request.started", requestId: "request-" + streams.length }) +
          "\n\n",
      );
      streams.push(res);
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.GPT_TEST_TOKEN = "private-test-service-token";
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: ":memory:",
      resultsPath: root,
    },
    auth: {},
    machines: [],
    projects: [],
    gpt: { endpoint: "http://127.0.0.1:" + server.address().port, tokenSecret: "GPT_TEST_TOKEN" },
  });
  const store = new Store(":memory:"),
    service = new GptService(config, store);
  t.after(() => {
    service.close();
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.GPT_TEST_TOKEN;
  });
  const value = { nativeId: "native-chat", text: "hello", files: [], model: "Latest", effort: "2" },
    first = randomUUID(),
    second = randomUUID();
  assert.equal(service.enqueue(first, value).id, first);
  assert.equal(service.enqueue(first, value).id, first);
  assert.throws(() => service.enqueue(first, { ...value, text: "different" }), /другое сообщение/);
  service.enqueue(second, { ...value, text: "next" });
  await waitUntil(() => streams.length === 1);
  assert.equal(service.job(second).status, "queued");
  const send = (stream, event) => stream.write("data: " + JSON.stringify(event) + "\n\n");
  send(streams[0], { type: "prompt.sent" });
  send(streams[0], { type: "thinking.snapshot", text: "PRIVATE_REASONING" });
  send(streams[0], { type: "diagnostic.anything", token: "PRIVATE_TOKEN" });
  send(streams[0], { type: "answer.snapshot", text: "Visible answer" });
  await waitUntil(() => service.job(first).answer === "Visible answer");
  assert.doesNotMatch(JSON.stringify(service.jobs()), /PRIVATE_/);
  send(streams[0], { type: "request.done", session: { id: "native-chat" }, artifacts: [] });
  streams[0].end();
  await waitUntil(() => streams.length === 2);
  assert.equal(service.job(first).status, "completed");
  assert.equal(requests.filter((r) => r.path === "/bridge/chat").length, 2);
  // Losing confirmation must not automatically replay or start another queued request.
  const third = randomUUID();
  service.enqueue(third, { ...value, text: "third" });
  streams[1].destroy();
  await waitUntil(() => service.job(second).status === "unknown");
  assert.equal(service.job(third).status, "queued");
  assert.throws(() => service.enqueue(randomUUID(), value), /предыдущую отправку/);
  service.resolve(second);
  await waitUntil(() => streams.length === 3);
  send(streams[2], { type: "request.done", session: { id: "native-chat" }, artifacts: [] });
  streams[2].end();
  await waitUntil(() => service.job(third).status === "completed");
});
test("GPT restart does not replay a possibly submitted request", () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-restart-")),
    store = new Store(":memory:");
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: ":memory:",
      resultsPath: root,
    },
    auth: {},
    machines: [],
    projects: [],
  });
  const first = new GptService(config, store),
    id = randomUUID();
  store.db
    .prepare("INSERT INTO gpt_jobs VALUES(?,?,?,?,?,?,?,'running','',?,?,?,'',NULL,1)")
    .run(id, "hash", "native-chat", "hello", "[]", "Latest", "2", "[]", 100, 100);
  first.close();
  const second = new GptService(config, store);
  assert.equal(second.job(id).status, "unknown");
  second.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("old GPT outbox entries never appear after the latest native messages", () => {
  const job = {
    status: "completed",
    text: "old",
    answer: "old reply",
    assets: [],
    createdAt: 100000,
    updatedAt: 150000,
  };
  const messages = [
    { role: "user", text: "new", createdAt: 160 },
    { role: "assistant", text: "new reply", createdAt: 161 },
  ];
  assert.equal(showGptJob(job, messages, 180000), false);
  assert.equal(showGptJob({ ...job, status: "queued" }, messages, 180000), true);
});
