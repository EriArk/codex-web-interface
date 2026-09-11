import assert from "node:assert/strict";
import test from "node:test";
import { transcribeDictation } from "../ops/gpt/browser-dictation.mjs";

test("native dictation uses the consumer transcription route only and projects only text", async () => {
  const original = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/auth/session")
      return Response.json({ accessToken: "fixture-private-token" });
    assert.equal(path, "/backend-api/transcribe");
    assert.deepEqual([...options.body.keys()], ["file"]);
    const file = options.body.get("file");
    assert.equal(file.type, "audio/wav");
    assert.equal(file.name, "dictation.wav");
    assert.equal(await file.text(), "audio fixture");
    assert.equal(options.headers.Authorization, "Bearer fixture-private-token");
    return Response.json({ text: "Проверка диктовки.", internal: "never expose" });
  };
  try {
    const page = {
      url: () => "https://chatgpt.com/c/original",
      evaluate: (fn, input) => fn(input),
    };
    const result = await transcribeDictation(page, {
      audio: Buffer.from("audio fixture").toString("base64"),
      mime: "audio/wav",
    });
    assert.deepEqual(result, { status: 200, text: "Проверка диктовки." });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});
test("native dictation rejects unrecognized inputs and never requests alternate origins or billing models", async () => {
  const page = {
    url: () => "https://chatgpt.com/",
    evaluate: () => {
      throw Error("Unexpected native call");
    },
  };
  for (const input of [
    { audio: "YQ==", mime: "__proto__" },
    { audio: "YQ==", mime: "audio/wav", url: "https://other.invalid" },
    { audio: "!", mime: "audio/wav" },
  ])
    assert.equal((await transcribeDictation(page, input)).status, 400);
  page.url = () => "https://example.invalid/";
  assert.equal((await transcribeDictation(page, { audio: "YQ==", mime: "audio/wav" })).status, 401);
});
test("login failures and native refusal preserve failure without fallback", async () => {
  const original = globalThis.fetch;
  const page = { url: () => "https://chatgpt.com/", evaluate: (fn, input) => fn(input) };
  const input = { audio: "YQ==", mime: "audio/mp4" };
  try {
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    assert.equal((await transcribeDictation(page, input)).status, 401);
    globalThis.fetch = async (path) =>
      path === "/api/auth/session"
        ? Response.json({ accessToken: "private" })
        : new Response("refused", { status: 403 });
    assert.deepEqual(await transcribeDictation(page, input), {
      status: 403,
      error: "DICTATION_NATIVE_FAILED",
    });
  } finally {
    globalThis.fetch = original;
  }
});
