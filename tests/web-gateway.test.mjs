import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { engineInfo } from "../apps/hub/dist/engine-client.js";
import { prepareEngineSocket } from "../apps/hub/dist/engine-socket.js";
import { createWebGateway } from "../apps/hub/dist/web-gateway.js";
import { currentRelease, publishWeb } from "../apps/hub/dist/web-releases.js";
import { devicesFixture } from "./devices-fixture.mjs";
import { formRequest } from "./elicitation-fixture.mjs";
import { healthyConnection } from "./fixtures/gpt-connection.mjs";
import { settings } from "./handoff-fixture.mjs";

const require = createRequire(new URL("../apps/hub/package.json", import.meta.url));
const { WebSocket } = require("ws");
const waitFor = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Wait timed out");
};

import { gatewayFixture } from "./web-gateway-fixture.mjs";

test("GPT reply and queued Codex message survive gateway updates without replay", async () => {
  const streams = [],
    calls = [];
  const connector = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push(req.url);
    if (req.url === "/bridge/chat") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        "data: " + JSON.stringify({ type: "request.started", requestId: "gpt-one" }) + "\n\n",
      );
      streams.push(res);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/status" ? healthyConnection : req.url === "/settings" ? body : { ok: true },
      ),
    );
  });
  connector.listen(0, "127.0.0.1");
  await once(connector, "listening");
  process.env.GATEWAY_GPT_TEST = "fixture";
  const f = await gatewayFixture({
    configure: (config) => {
      config.gpt = {
        endpoint: "http://127.0.0.1:" + connector.address().port,
        tokenSecret: "GATEWAY_GPT_TEST",
      };
    },
  });
  try {
    const key = randomUUID(),
      input = { nativeId: "native-chat", text: "hello", files: [], model: "Latest", effort: "2" };
    assert.equal((await f.http("/api/gpt/send", input, key)).status, 202);
    await waitFor(() => streams.length === 1);
    const emit = (event) => streams[0].write("data: " + JSON.stringify(event) + "\n\n");
    emit({ type: "prompt.sent" });
    emit({ type: "answer.snapshot", text: "Before update" });
    await waitFor(
      () =>
        f.store.db.prepare("SELECT answer FROM gpt_jobs WHERE id=?").get(key)?.answer ===
        "Before update",
    );
    const queue = [],
      native = f.rpc.request.bind(f.rpc);
    f.rpc.request = async (method, p) => {
      if (method === "thread/queue/list") return { data: queue };
      if (method === "thread/queue/add") {
        const item = {
          id: randomUUID(),
          clientUserMessageId: p.clientUserMessageId,
          input: p.input,
        };
        queue.push(item);
        return { queuedSubmission: item };
      }
      return native(method, p);
    };
    assert.equal(
      (await f.http(`/api/threads/${f.thread.id}/turns`, { text: "Working", settings })).status,
      200,
    );
    const queued = { text: "Next", attachments: [], clientId: randomUUID() },
      queueUrl = `/api/threads/${f.thread.id}/queue`;
    assert.equal((await f.http(queueUrl, queued)).status, 200);
    await f.restart();
    assert.equal(streams[0].destroyed, false);
    assert.equal((await f.http(queueUrl, queued)).status, 200);
    assert.equal(queue.length, 1);
    assert.equal((await f.http("/api/gpt/send", input, key)).status, 202);
    emit({ type: "answer.snapshot", text: "After update" });
    emit({ type: "request.done", session: { id: "native-chat" }, artifacts: [] });
    streams[0].end();
    await waitFor(
      () =>
        f.store.db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(key)?.status ===
        "completed",
    );
    assert.equal(
      f.store.db.prepare("SELECT answer FROM gpt_jobs WHERE id=?").get(key).answer,
      "After update",
    );
    assert.equal(calls.filter((p) => p === "/bridge/chat").length, 1);
    assert.equal(f.rpc.closed, false);
  } finally {
    await f.close();
    for (const s of streams) s.destroy();
    connector.closeAllConnections();
    await new Promise((r) => connector.close(r));
    delete process.env.GATEWAY_GPT_TEST;
  }
});

test("gateway restart preserves native stream, pending form identity and exactly-once approval response", async () => {
  const f = await gatewayFixture();
  try {
    const identity = await engineInfo(f.socketPath);
    assert.equal((await fetch(f.origin + "/internal/runtime")).status, 404);
    assert.equal((await fetch(f.origin + "/api/deployment")).status, 401);
    await assert.rejects(() => prepareEngineSocket(f.socketPath), /ALREADY_RUNNING/);
    const sent = await f.http(`/api/threads/${f.thread.id}/turns`, {
      text: "Gateway continuity",
      settings,
      attachments: [],
    });
    assert.equal(sent.status, 200, await sent.clone().text());
    const turnId = f.store.thread(f.thread.id).activeTurnId;
    const first = await f.attach(`/api/events?threadId=${f.thread.id}&after=0`);
    await waitFor(() => first.events.some((e) => e.type === "connection.ready"));
    const runtime = await f.sessions.runtime("project"),
      answers = [];
    runtime.rpc.respond = (id, result) => answers.push({ id, result });
    await f.sessions.request(runtime, {
      id: 71,
      method: "mcpServer/elicitation/request",
      params: { ...formRequest, threadId: f.thread.codexThreadId, turnId },
    });
    const approval = f.sessions.pending(f.thread.id)[0];
    assert(approval);
    await f.restart();
    assert.equal(f.rpc.closed, false);
    assert.equal((await engineInfo(f.socketPath)).instance, identity.instance);
    assert.equal(f.store.thread(f.thread.id).activeTurnId, turnId);
    const second = await f.attach(`/api/events?threadId=${f.thread.id}&after=0`);
    await waitFor(() => second.events.some((e) => e.type === "connection.ready"));
    assert.equal(
      second.events.find((e) => e.type === "connection.ready").approvals[0].id,
      approval.id,
    );
    const key = randomUUID(),
      path = `/api/approvals/${approval.id}/elicitation`,
      body = {
        action: "accept",
        content: { title: "Demo", enabled: false, count: 0, labels: ["x"] },
      };
    assert.equal((await f.http(path, body, key)).status, 200);
    assert.equal((await f.http(path, body, key)).status, 200);
    assert.equal(answers.length, 1);
    f.rpc.emit("notification", "item/completed", {
      threadId: f.thread.codexThreadId,
      turnId,
      item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Still here" },
    });
    f.finishTurn();
    await waitFor(() => second.events.some((e) => e.type === "turn.completed"));
    second.ws.close();
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  } finally {
    await f.close();
  }
});

test("gateway restart retains terminal process/buffer and never replays input or uncertain native sends", async () => {
  const f = await gatewayFixture();
  try {
    const created = await f.http("/api/devices/server/terminals", { kind: "shell" }),
      terminal = await created.json();
    assert.equal(created.status, 200);
    const open = async () => {
      const ticket = await (await f.http(`/api/device-terminals/${terminal.id}/ticket`, {})).json();
      const connection = await f.attach(`/api/device-terminals/${terminal.id}/socket`);
      connection.ws.send(JSON.stringify({ ticket: ticket.ticket }));
      await waitFor(() => connection.events.some((e) => e.type === "ready"));
      return connection;
    };
    const first = await open();
    first.ws.send(JSON.stringify({ type: "input", data: "long-command\r" }));
    await waitFor(() => f.processes[0].writes.length === 1);
    f.loseAck();
    const key = randomUUID(),
      body = { text: "Unknown acknowledgement", settings, attachments: [] };
    assert.notEqual((await f.http(`/api/threads/${f.thread.id}/turns`, body, key)).status, 200);
    await f.restart();
    assert.equal(f.processes[0].killed, false);
    f.processes[0].output("command finished\r\n");
    const second = await open();
    await waitFor(() => second.events.some((e) => e.data?.includes("command finished")));
    assert.deepEqual(f.processes[0].writes, ["long-command\r"]);
    assert.notEqual((await f.http(`/api/threads/${f.thread.id}/turns`, body, key)).status, 200);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    const status = await (await f.http("/api/deployment")).json();
    assert(status.blockers.some((b) => b.kind === "terminal"));
    second.ws.close();
  } finally {
    await f.close();
  }
});

test("UI publication is atomic, retains old assets, rejects incompatible schema and rolls back failed postcheck", async () => {
  const f = await gatewayFixture();
  try {
    const before = currentRelease(f.releaseRoot),
      instance = (await engineInfo(f.socketPath)).instance;
    const source = join(f.root, "next");
    mkdirSync(join(source, "assets"), { recursive: true });
    const id = "b".repeat(64);
    writeFileSync(join(source, "version.json"), JSON.stringify({ id }));
    writeFileSync(join(source, "index.html"), "<html>Second client</html>");
    writeFileSync(join(source, "sw.js"), "// worker");
    writeFileSync(join(source, "assets", "second.js"), "// second");
    writeFileSync(
      join(source, "engine-compat.json"),
      JSON.stringify({ protocol: 1, minSchema: 29, maxSchema: 29 }),
    );
    await assert.rejects(
      () =>
        publishWeb({ source, root: f.releaseRoot, socketPath: f.socketPath, revision: "bbbbbbb" }),
      /INCOMPATIBLE/,
    );
    assert.equal(currentRelease(f.releaseRoot).id, before.id);
    writeFileSync(
      join(source, "engine-compat.json"),
      JSON.stringify({ protocol: 1, minSchema: 28, maxSchema: 28 }),
    );
    await assert.rejects(
      () =>
        publishWeb({
          source,
          root: f.releaseRoot,
          socketPath: f.socketPath,
          revision: "bbbbbbb",
          postcheck: async () => {
            throw new Error("PUBLIC_POSTCHECK_FAILED");
          },
        }),
      /POSTCHECK/,
    );
    assert.equal(currentRelease(f.releaseRoot).id, before.id);
    assert.equal(JSON.parse(readFileSync(join(f.releaseRoot, "status.json"))).state, "rolled_back");
    await publishWeb({
      source,
      root: f.releaseRoot,
      socketPath: f.socketPath,
      revision: "bbbbbbb",
    });
    assert.equal(await (await fetch(f.origin)).text(), "<html>Second client</html>");
    const old = Object.keys(before.files).find((p) => p.endsWith(".js") && p.startsWith("assets/"));
    assert.equal((await fetch(f.origin + "/" + old)).status, 200);
    assert.equal((await fetch(f.origin + "/status.json")).status, 404);
    assert.equal((await fetch(f.origin + "/releases/" + before.id + "/release.json")).status, 404);
    assert.equal((await engineInfo(f.socketPath)).instance, instance);
  } finally {
    await f.close();
  }
});
