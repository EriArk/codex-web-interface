import assert from "node:assert/strict";
import test from "node:test";
import { NativeRendererReader } from "../ops/gpt-native/renderer.mjs";

function fixture(t, { pages, respond } = {}) {
  const originalFetch = globalThis.fetch,
    originalSocket = globalThis.WebSocket;
  const sockets = [],
    calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:9222/json/list");
    assert.equal(options.redirect, "error");
    options.signal.throwIfAborted();
    return new Response(
      JSON.stringify(
        pages ?? [
          {
            type: "page",
            url: "app://-/index.html",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/main",
          },
        ],
      ),
    );
  };
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    close() {
      this.closed = true;
      queueMicrotask(() => this.onclose?.());
    }
    send(raw) {
      const call = JSON.parse(raw);
      calls.push(call);
      assert.equal(call.method, "Runtime.evaluate");
      const result = respond
        ? respond(call, this)
        : {
            id: 1,
            result: {
              result: {
                value: call.params.expression.startsWith("!!")
                  ? true
                  : { ok: true, value: { writesEnabled: false } },
              },
            },
          };
      if (result != null) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(result) }));
    }
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalSocket;
  });
  return { reader: new NativeRendererReader(), sockets, calls };
}

test("private native transport selects main window and closes every connection", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.reader.inspectAccount(), { writesEnabled: false });
  assert.equal(f.sockets.length, 2);
  assert.equal(
    f.sockets.every((s) => s.closed),
    true,
  );
  assert.match(f.calls[1].params.expression, /expectedIdentity:before.principal/);
});

test("discovery rejects external debugger addresses before opening a socket", async (t) => {
  const f = fixture(t, {
    pages: [
      {
        type: "page",
        url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://example.com:9222/devtools/page/main",
      },
    ],
  });
  await assert.rejects(f.reader.inspectAccount(), /UNSAFE_TARGET/);
  assert.equal(f.sockets.length, 0);
});

test("multiple main windows are ambiguous and never receive a history operation", async (t) => {
  const f = fixture(t, {
    pages: ["one", "two"].map((id) => ({
      type: "page",
      url: "app://-/index.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
    })),
  });
  await assert.rejects(f.reader.inspectAccount(), /WINDOW_AMBIGUOUS/);
  assert.equal(
    f.calls.every((c) => c.params.expression.startsWith("!!")),
    true,
  );
  assert.equal(
    f.sockets.every((s) => s.closed),
    true,
  );
});

test("disconnection returns a fixed error without retrying", async (t) => {
  const f = fixture(t, {
    respond: (_call, ws) => {
      ws.close();
      return null;
    },
  });
  await assert.rejects(f.reader.inspectAccount(), { message: "NATIVE_DISCONNECTED" });
});

test("cancellation closes an in-flight native request without retrying", async (t) => {
  const controller = new AbortController();
  const f = fixture(t, {
    respond: () => {
      queueMicrotask(() => controller.abort());
      return null;
    },
  });
  await assert.rejects(f.reader.inspectAccount({ signal: controller.signal }), {
    message: "NATIVE_CANCELLED",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.sockets.every((s) => s.closed),
    true,
  );
});

test("mismatched response IDs fail closed", async (t) => {
  const f = fixture(t, {
    respond: () => ({ id: 2, result: { result: { value: "wrong request" } } }),
  });
  await assert.rejects(f.reader.inspectAccount(), /INVALID_RESPONSE/);
  assert.equal(
    f.sockets.every((s) => s.closed),
    true,
  );
});

test("oversized debugger data is discarded", async (t) => {
  const f = fixture(t, {
    respond: () => ({ id: 1, result: { result: { value: "x".repeat(2 * 1024 * 1024) } } }),
  });
  await assert.rejects(f.reader.inspectAccount(), /RESPONSE_TOO_LARGE/);
  assert.equal(
    f.sockets.every((s) => s.closed),
    true,
  );
});
