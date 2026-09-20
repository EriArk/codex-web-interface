import assert from "node:assert/strict";
import test from "node:test";
import { api, configureApi } from "../apps/web/src/api.ts";
import { waitingGptJob } from "../apps/web/src/gptState.ts";

test("reads quietly retry transport failure once; writes and permanent failures do not", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    configureApi("test", () => {});
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError("network");
      return Response.json({ value: "ok" });
    };
    assert.deepEqual(await api("/projects"), { value: "ok" });
    assert.equal(calls, 2);
    for (const [options, status, code, expected] of [
      [{ method: "POST", body: { text: "send once" } }, 503, "TRANSPORT_UNAVAILABLE", 1],
      [{}, 503, "TRANSPORT_UNAVAILABLE", 2],
      [{}, 403, "FORBIDDEN", 1],
      [{}, 429, "RATE_LIMITED", 1],
      [{}, 502, "FILE_MISSING", 1],
    ]) {
      calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({ error: { code } }, { status });
      };
      await assert.rejects(api("/test", options));
      assert.equal(calls, expected);
    }
    calls = 0;
    const abort = new AbortController();
    globalThis.fetch = async () => {
      calls++;
      setTimeout(() => abort.abort(), 20);
      throw new TypeError("network");
    };
    await assert.rejects(api("/projects", { signal: abort.signal }));
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      setTimeout(() => configureApi("new-session", () => {}), 20);
      throw new TypeError("network");
    };
    await assert.rejects(api("/projects"));
    assert.equal(calls, 1, "retry never crosses account/session rotation");
  } finally {
    globalThis.fetch = original;
  }
});

test("GPT queue means waiting behind work in the same chat, not initial dispatch", () => {
  const job = { id: "new", status: "queued", nativeId: "chat", createdAt: 2 };
  assert.equal(waitingGptJob(job, [job]), false);
  const prior = { id: "prior", status: "running", nativeId: "other", createdAt: 1 };
  assert.equal(waitingGptJob(job, [job, prior]), false);
  prior.nativeId = "chat";
  assert.equal(waitingGptJob(job, [job, prior]), true);
  prior.status = "completed";
  assert.equal(waitingGptJob(job, [job, prior]), false);
  prior.status = "unknown";
  assert.equal(waitingGptJob(job, [job, prior]), true);
  assert.equal(waitingGptJob({ ...job, nativeId: null }, [prior]), false);
});
