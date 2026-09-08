import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { proxyBridge } from "../ops/gpt/bridge-proxy.mjs";

test("GPT proxy preserves image-only payloads and labels only proven pre-dispatch rejection", async (t) => {
  const realFetch = globalThis.fetch;
  let response;
  const forwarded = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8080/chat");
    forwarded.push(JSON.parse(options.body));
    return response;
  });
  const server = createServer((req, res) => proxyBridge(req, res, "/bridge/chat", "fixture-token"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const send = () =>
    realFetch("http://127.0.0.1:" + server.address().port, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "",
        attachments: ["file_one", "file_two"],
        model: "must-not-override-verified-model",
      }),
    });
  response = new Response('data: {"type":"prompt.sent"}\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });
  let result = await send();
  assert.equal(result.status, 200);
  assert.match(await result.text(), /prompt.sent/);
  assert.deepEqual(forwarded[0], {
    message: "",
    attachments: ["file_one", "file_two"],
    stream: true,
  });
  response = new Response(JSON.stringify({ detail: "No message provided" }), { status: 400 });
  result = await send();
  assert.equal(result.headers.get("x-codex-gpt-dispatch"), "not-submitted");
  assert.deepEqual(await result.json(), { error: "GPT_CHAT_NOT_SUBMITTED" });
  for (const body of [
    JSON.stringify({ detail: "PRIVATE_ERROR" }),
    "invalid json",
    "x".repeat(4097),
  ]) {
    response = new Response(body, { status: 400 });
    result = await send();
    assert.equal(result.headers.get("x-codex-gpt-dispatch"), null);
    assert.doesNotMatch(await result.text(), /PRIVATE_ERROR/);
  }
  response = new Response(JSON.stringify({ detail: "No message provided" }), { status: 502 });
  result = await send();
  assert.equal(result.headers.get("x-codex-gpt-dispatch"), null);
  await result.body.cancel();
  assert.equal(forwarded.length, 6, "the proxy never retries a prompt");
});
