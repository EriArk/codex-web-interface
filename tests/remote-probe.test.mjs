import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import { verifyPrivateVnc } from "../apps/hub/dist/remote-probe.js";

const password = "Test_123";
// Independent OpenSSL DES-ECB vector: reversed password bits, challenge 00..0f.
const expectedResponse = Buffer.from("ccd19a2a437e572086a8e53375454455", "hex");
const challenge = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
async function peer(t, exchange) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    exchange(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return (options) => {
    assert.deepEqual(options, { host: "100.64.0.2", port: 5900 });
    return createConnection({ host: "127.0.0.1", port: server.address().port });
  };
}
test("private Remote probe authenticates fragmented RFB and never initializes a desktop", async (t) => {
  let transcript = Buffer.alloc(0),
    state = 0;
  let onClosed;
  const closed = new Promise((resolve) => {
    onClosed = resolve;
  });
  const connect = await peer(t, (socket) => {
    socket.once("close", onClosed);
    socket.write("RFB 003.");
    setImmediate(() => socket.write("008\n"));
    socket.on("data", (bytes) => {
      transcript = Buffer.concat([transcript, bytes]);
      if (state === 0 && transcript.length >= 12) {
        state = 1;
        assert.equal(transcript.subarray(0, 12).toString(), "RFB 003.008\n");
        socket.write(Buffer.from([2, 16, 2]));
      }
      if (state === 1 && transcript.length >= 13) {
        state = 2;
        assert.equal(transcript[12], 2);
        socket.write(challenge.subarray(0, 7));
        setImmediate(() => socket.write(challenge.subarray(7)));
      }
      if (state === 2 && transcript.length >= 29) {
        state = 3;
        assert.deepEqual(transcript.subarray(13, 29), expectedResponse);
        socket.write(Buffer.from([0, 0]));
        setImmediate(() => socket.write(Buffer.from([0, 0])));
      }
    });
  });
  await verifyPrivateVnc("100.64.0.2", password, connect);
  await closed;
  assert.equal(state, 3);
  assert.equal(transcript.length, 29, "no ClientInit, framebuffer or input packet");
});
test("Remote authentication accepts coalesced protocol data", async (t) => {
  const connect = await peer(t, (socket) =>
    socket.write(
      Buffer.concat([
        Buffer.from("RFB 003.008\n"),
        Buffer.from([1, 2]),
        challenge,
        Buffer.alloc(4),
      ]),
    ),
  );
  await verifyPrivateVnc("100.64.0.2", password, connect);
});
test("Remote probe rejects unprotected, failed, oversized and incomplete peers", async (t) => {
  for (const [name, bytes] of [
    ["no authentication", Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([2, 1, 2])])],
    [
      "failed password",
      Buffer.concat([
        Buffer.from("RFB 003.008\n"),
        Buffer.from([1, 2]),
        challenge,
        Buffer.from([0, 0, 0, 1]),
      ]),
    ],
    ["no security types", Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([0])])],
    ["unknown version", Buffer.from("RFB 003.003\n")],
    ["oversized", Buffer.alloc(4097)],
    ["closed", Buffer.from("RFB")],
  ])
    await t.test(name, async (t) => {
      const connect = await peer(t, (socket) => socket.end(bytes));
      await assert.rejects(
        verifyPrivateVnc("100.64.0.2", password, connect),
        /^Error: REMOTE_VERIFICATION_FAILED$/,
      );
    });
});
test("Remote probe validates fixed private destination and credential before connecting", () => {
  const connect = () => {
    throw Error("must not connect");
  };
  for (const host of [
    "127.0.0.1",
    "192.168.1.2",
    "100.128.0.1",
    "example.com",
    "::1",
    "100.64.0.2\n",
  ])
    assert.throws(() => verifyPrivateVnc(host, password, connect));
  for (const secret of ["", "short", "morethan8", "1234567\n", "12345678\n"])
    assert.throws(
      () => verifyPrivateVnc("100.64.0.2", secret, connect),
      /REMOTE_CREDENTIAL_INVALID/,
    );
});
