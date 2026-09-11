import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { DictationJobs } from "../apps/hub/dist/dictation.js";
import { handoffFixture } from "./handoff-fixture.mjs";

test("dictation receipts bind exact audio and owner, serialize work and discard cancelled results", async () => {
  let finish,
    calls = 0,
    signal;
  const jobs = new DictationJobs((_bytes, s) => {
    calls++;
    signal = s;
    return new Promise((r) => {
      finish = r;
    });
  });
  try {
    const id = randomUUID(),
      audio = Buffer.from("synthetic");
    jobs.create(id, "one", audio);
    jobs.create(id, "one", audio);
    await setImmediate();
    assert.equal(calls, 1);
    assert.throws(
      () => jobs.create(id, "one", Buffer.from("different")),
      (e) => e.code === "DICTATION_CONFLICT",
    );
    assert.throws(
      () => jobs.create(id, "two", audio),
      (e) => e.code === "DICTATION_CONFLICT",
    );
    assert.throws(
      () => jobs.read(id, "two"),
      (e) => e.code === "DICTATION_MISSING",
    );
    assert.throws(
      () => jobs.create(randomUUID(), "one", audio),
      (e) => e.code === "DICTATION_BUSY",
    );
    jobs.remove(id, "two");
    assert.equal(signal.aborted, false);
    jobs.remove(id, "one");
    assert.equal(signal.aborted, true);
    finish("private late result");
    await setImmediate();
    assert.throws(
      () => jobs.read(id, "one"),
      (e) => e.code === "DICTATION_MISSING",
    );
  } finally {
    jobs.close();
  }
});
test("dictation handles synchronous provider errors and rejects oversized transcripts", async () => {
  for (const transcribe of [
    () => {
      throw Error("secret");
    },
    async () => "x".repeat(32001),
  ]) {
    const jobs = new DictationJobs(transcribe),
      id = randomUUID();
    try {
      jobs.create(id, "owner", Buffer.from("audio"));
      await setImmediate();
      assert.deepEqual(jobs.read(id, "owner"), { state: "failed", text: "" });
    } finally {
      jobs.close();
    }
  }
});
test("authenticated dictation accepts audio once, keeps draft-only results, rejects CSRF and invalid input", async () => {
  let calls = 0;
  const f = await handoffFixture(undefined, undefined, {
    transcribe: async (bytes, _signal, mime) => {
      calls++;
      assert.equal(bytes.toString(), "fixture");
      assert.equal(mime, "audio/mp4");
      return "Распознанный текст";
    },
  });
  const id = randomUUID(),
    url = `/api/dictation/${id}?mime=audio%2Fmp4`,
    headers = { ...f.headers, "content-type": "application/octet-stream" };
  try {
    assert.equal((await f.app.inject({ url: "/api/dictation/status" })).statusCode, 401);
    assert.deepEqual(
      (await f.app.inject({ url: "/api/dictation/status", headers: f.headers })).json(),
      { available: true },
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url,
          headers: { cookie: headers.cookie, "content-type": "application/octet-stream" },
          payload: Buffer.from("fixture"),
        })
      ).statusCode,
      403,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await f.app.inject({ method: "POST", url, headers, payload: Buffer.from("fixture") }))
          .statusCode,
        202,
      );
    await setImmediate();
    assert.equal(calls, 1);
    assert.deepEqual((await f.app.inject({ url: `/api/dictation/${id}`, headers })).json(), {
      state: "completed",
      text: "Распознанный текст",
    });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: url.replace("audio%2Fmp4", "text%2Fhtml"),
          headers,
          payload: Buffer.from("fixture"),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url,
          headers,
          payload: Buffer.alloc(6 * 1024 * 1024 + 1),
        })
      ).statusCode,
      413,
    );
    assert.equal(
      (await f.app.inject({ method: "DELETE", url: `/api/dictation/${id}`, headers })).statusCode,
      200,
    );
    assert.equal((await f.app.inject({ url: `/api/dictation/${id}`, headers })).statusCode, 404);
    assert(!f.calls.some((c) => ["turn/start", "turn/steer"].includes(c.method)));
  } finally {
    await f.close();
  }
});
