import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexClient } from "../packages/codex/dist/index.js";

const source = await readFile(new URL("../apps/web/src/api.ts", import.meta.url), "utf8");
const { api, configureApi } = await import(
  "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(source, { mode: "transform" })).toString("base64")
);
test("proxy HTML and empty responses produce readable API errors, not Safari JSON parsing errors", async () => {
  const original = globalThis.fetch;
  let expired = false;
  configureApi("csrf", () => {
    expired = true;
  });
  try {
    for (const status of [502, 200, 401]) {
      globalThis.fetch = async () =>
        new Response(status === 200 ? "" : "<html>Gateway unavailable</html>", {
          status,
          headers: { "content-type": "text/html" },
        });
      await assert.rejects(
        api("/threads/id/turns", { method: "POST", body: { text: "привет" } }),
        (e) => e.code === "INVALID_RESPONSE" && e.status === status && !(e instanceof SyntaxError),
      );
    }
    assert(expired);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "THREAD_IN_USE", message: "Диалог занят" } }), {
        status: 409,
      });
    await assert.rejects(api("/threads/id/turns", { method: "POST", body: { text: "привет" } }), {
      code: "THREAD_IN_USE",
      message: "Диалог занят",
    });
  } finally {
    globalThis.fetch = original;
  }
});
test("native writer conflicts preserve a useful safe error without exposing arbitrary RPC details", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
  });
  const rpc = new CodexClient(child);
  child.stdin.on("data", (bytes) => {
    const request = JSON.parse(bytes.toString());
    child.stdout.write(
      JSON.stringify({
        id: request.id,
        error: {
          code: -32600,
          message:
            request.method === "thread/resume"
              ? "thread private-id already has an active writer"
              : "sensitive upstream detail",
        },
      }) + "\n",
    );
  });
  try {
    await assert.rejects(
      rpc.request("thread/resume", { threadId: "private-id" }),
      (e) =>
        e.code === "THREAD_IN_USE" && e.statusCode === 409 && !e.message.includes("private-id"),
    );
    await assert.rejects(
      rpc.request("other", {}),
      (e) => e.code === "CODEX_RPC_ERROR" && !e.message.includes("sensitive"),
    );
  } finally {
    rpc.close();
  }
});

test("copying draft attachments preserves originals and rejects attachments from another chat", async () => {
  const { Attachments } = await import("../apps/hub/dist/attachments.js");
  const { Store } = await import("../apps/hub/dist/store.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-copy-test-")),
    store = new Store(":memory:");
  try {
    const source = store.createThread("p", "source", "Source"),
      target = store.createThread("p", "target", "Copy");
    const files = new Attachments(root, store),
      payload = Buffer.from("private draft attachment");
    const original = await files.put(source.id, "note.txt", payload);
    await files.copyPending(source.id, target.id, [original.id]);
    const copy = files.pending(target.id)[0];
    assert(copy);
    assert.notEqual(copy.id, original.id);
    assert.equal(files.pending(source.id)[0].id, original.id);
    const bytes = [];
    for await (const chunk of files.stream(copy.id).stream) bytes.push(chunk);
    assert.deepEqual(Buffer.concat(bytes), payload);
    await assert.rejects(files.copyPending(target.id, source.id, [original.id]), {
      code: "ATTACHMENT_IN_USE",
    });
  } finally {
    store.close();
    await rm(root, { recursive: true });
  }
});
