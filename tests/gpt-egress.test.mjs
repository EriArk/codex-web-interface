import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { publicIPv4, publicProxy, publicTarget } from "../ops/gpt/public-egress.mjs";

test("GPT public egress excludes LAN, Tailnet, special-purpose and alternate IP representations", async () => {
  for (const ip of [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.0.1",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:8.8.8.8",
    "0x08080808",
    "134744072",
  ])
    assert.equal(publicIPv4(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "104.18.32.7"]) assert.equal(publicIPv4(ip), true, ip);
  const dns = async () => [{ address: "8.8.8.8" }];
  for (const [value, tunnel] of [
    ["http://user:pass@example.test", false],
    ["https://example.test", false],
    ["http://example.test:22", false],
    ["example.test:22", true],
    ["example.test:443/path", true],
    ["example.test:443?query", true],
    ["example.test", true],
  ])
    await assert.rejects(publicTarget(value, tunnel, dns));
  await assert.rejects(
    publicTarget("http://example.test", false, async () => [
      { address: "8.8.8.8" },
      { address: "192.168.1.2" },
    ]),
  );
  let calls = 0;
  const rebound = async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1" }];
  assert.equal((await publicTarget("example.test:443", true, rebound)).address, "8.8.8.8");
  await assert.rejects(publicTarget("example.test:443", true, rebound));
});
test("GPT proxy strips credentials, relays HTTP and refuses forbidden CONNECT without connecting", async (t) => {
  const upstream = createServer((req, res) => {
    assert.equal(req.headers["proxy-authorization"], undefined);
    assert.equal(req.headers["x-hop-secret"], undefined);
    assert.equal(req.headers.host, "example.test");
    res.end("public fixture");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const proxy = publicProxy({
    resolveTarget: async (value, tunnel) => {
      if (tunnel) throw Error("EGRESS_DENIED");
      return { address: "127.0.0.1", port: upstream.address().port, url: new URL(value) };
    },
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const body = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: proxy.address().port,
        path: "http://example.test/safe",
        headers: {
          "proxy-authorization": "secret",
          connection: "x-hop-secret",
          "x-hop-secret": "secret",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "public fixture");
  const socket = connect(proxy.address().port, "127.0.0.1");
  await once(socket, "connect");
  socket.write("CONNECT 192.168.1.1:443 HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n");
  assert.match(String((await once(socket, "data"))[0]), /403 Forbidden/);
  socket.destroy();
});
