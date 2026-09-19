import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NativePipe } from "../ops/gpt-native/pipe.mjs";
import { NativeRendererReader } from "../ops/gpt-native/renderer.mjs";

function fixture(t, respond) {
  const input = new PassThrough(),
    output = new PassThrough(),
    calls = [];
  const pipe = new NativePipe(input, output);
  input.on("data", (frame) => {
    const call = JSON.parse(frame.subarray(0, -1).toString());
    calls.push(call);
    const result = respond?.(call);
    if (result !== undefined) {
      const frame = Buffer.from(
        JSON.stringify({
          id: call.id,
          ...(call.sessionId ? { sessionId: call.sessionId } : {}),
          result,
        }) + "\0",
      );
      output.write(frame.subarray(0, 7));
      output.write(frame.subarray(7));
    }
  });
  t.after(() => pipe.close());
  return { pipe, input, output, calls };
}

test("inherited pipe selects only the guarded native renderer and detaches without any TCP discovery", async (t) => {
  const f = fixture(t, (call) => {
    if (call.method === "Target.getTargets")
      return {
        targetInfos: [
          { type: "page", url: "app://-/index.html", targetId: "main" },
          { type: "page", url: "https://other.test", targetId: "other" },
        ],
      };
    if (call.method === "Target.attachToTarget") return { sessionId: "session" };
    if (call.method === "Runtime.evaluate")
      return {
        result: {
          value: call.params.expression.startsWith("!!")
            ? true
            : { ok: true, value: { writesEnabled: false } },
        },
      };
    return {};
  });
  const reader = new NativeRendererReader({ transport: f.pipe });
  assert.deepEqual(await reader.inspectAccount(), { writesEnabled: false });
  assert.equal(f.calls.at(-1).method, "Target.detachFromTarget");
  assert.equal(f.calls.filter((c) => c.method === "Target.attachToTarget").length, 1);
});

test("pipe abort and EOF reject pending reads without resending", async (t) => {
  const f = fixture(t),
    abort = new AbortController();
  const pending = f.pipe.call("Target.getTargets", {}, abort.signal);
  abort.abort();
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(f.calls.length, 1);
  const lost = f.pipe.call("Target.getTargets", {}, AbortSignal.timeout(1000));
  f.output.end();
  await assert.rejects(lost, /PIPE_CLOSED/);
  assert.equal(f.calls.length, 2);
});

test("cross-session responses and oversized pipe frames close the transport", async (t) => {
  const f = fixture(t);
  const pending = f.pipe.call("Runtime.evaluate", {}, AbortSignal.timeout(1000), "expected");
  f.output.write(JSON.stringify({ id: 1, sessionId: "other", result: {} }) + "\0");
  await assert.rejects(pending, /PIPE_CLOSED/);
  const other = fixture(t),
    huge = other.pipe.call("Target.getTargets", {}, AbortSignal.timeout(1000));
  other.output.write(Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(huge, /PIPE_CLOSED/);
});
