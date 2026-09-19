import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("the real Guacamole tunnel preserves workspace and native runtime in one query", () => {
  const urls = [];
  const context = {
    URL,
    URLSearchParams,
    console,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    WebSocket: class {
      constructor(url) {
        urls.push(url);
      }
      close() {}
    },
    navigator: { userAgent: "" },
  };
  context.window = context;
  context.location = { protocol: "https:", host: "example.test", pathname: "/gpt-connect" };
  vm.createContext(context);
  vm.runInContext(
    readFileSync(
      new URL("../apps/web/public/vendor/guacamole-1.6.0.min.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  const workspace = "00000000-0000-4000-8000-000000000001";
  const params = new URLSearchParams({
    workspace,
    runtime: "native",
    width: "1280",
    height: "900",
  });
  const tunnel = new context.Guacamole.WebSocketTunnel("wss://example.test/gpt-connect/remote");
  tunnel.connect(params.toString());
  const parsed = new URL(urls[0]);
  assert.equal(parsed.searchParams.get("workspace"), workspace);
  assert.equal(parsed.searchParams.get("runtime"), "native");
  assert.equal(parsed.searchParams.get("width"), "1280");
  assert.equal(parsed.search.match(/\?/g)?.length, 1);
  // Guard the actual client wiring, not only the library fixture.
  const client = readFileSync(new URL("../ops/gpt/connect-client.js", import.meta.url), "utf8");
  assert.match(client, /new G\.WebSocketTunnel\([^;]*'\/gpt-connect\/remote'\)/);
  assert.match(client, /active\.connect\(query\.toString\(\)\)/);
});
