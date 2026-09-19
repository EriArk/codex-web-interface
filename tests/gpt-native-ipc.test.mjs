import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSocket, NativeReadProbe, requestFrame } from "../ops/gpt-native/ipc.mjs";

async function fixture(t, reply) {
  const root = await mkdtemp(join(tmpdir(), "native-ipc-"));
  const path =
    process.platform === "win32"
      ? "\\\\.\\pipe\\native-probe-" + root.split(/[\\/]/).at(-1)
      : join(root, "test.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (data) => reply(socket, JSON.parse(data.subarray(4))));
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return path;
}
function frame(data) {
  const body = Buffer.from(JSON.stringify(data)),
    out = Buffer.alloc(body.length + 4);
  out.writeUInt32LE(body.length);
  body.copy(out, 4);
  return out;
}
test("native RPC handles fragmented UTF-8 responses and exact IDs", async (t) => {
  const path = await fixture(t, (socket, message) => {
    const data = frame({ jsonrpc: "2.0", id: message.id, result: { text: "Привет" } });
    socket.write(data.subarray(0, 3));
    setTimeout(() => socket.end(data.subarray(3)), 5);
  });
  assert.deepEqual(
    await requestFrame(path, { jsonrpc: "2.0", id: "probe", method: "tools/list" }),
    { text: "Привет" },
  );
});
test("native RPC fails closed on mismatched IDs, oversized frames and disconnects", async (t) => {
  const wrong = await fixture(t, (socket) =>
    socket.end(frame({ jsonrpc: "2.0", id: "wrong", result: {} })),
  );
  await assert.rejects(requestFrame(wrong, { id: "probe" }), /INVALID_RESPONSE/);
  const big = await fixture(t, (socket) => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(9 * 1024 * 1024);
    socket.write(head);
  });
  await assert.rejects(requestFrame(big, { id: "probe" }), /INVALID_FRAME/);
  const closed = await fixture(t, (socket) => socket.end());
  await assert.rejects(requestFrame(closed, { id: "probe" }), /DISCONNECTED/);
  const quiet = await fixture(t, () => {});
  await assert.rejects(requestFrame(quiet, { id: "probe" }, { timeoutMs: 20 }), /TIMEOUT/);
});
test("unverified builds and mutation calls are rejected before connection", async () => {
  assert.throws(
    () => new NativeReadProbe({ build: "future", path: "/unused" }),
    /UNSUPPORTED_BUILD/,
  );
  const probe = new NativeReadProbe({ build: "26.915.31945", path: "/unused" });
  await assert.rejects(probe.read("send_message_to_thread", {}), /READ_ONLY/);
  await assert.rejects(probe.read("list_threads", {}), /CALLER_REQUIRED/);
});

test("native discovery distinguishes browser sockets and rejects ambiguous or unsafe paths", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-discovery-"));
  const app = join(root, "11111111-1111-4111-8111-111111111111.sock");
  const browser = join(root, "22222222-2222-4222-8222-222222222222.sock");
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  for (const path of [app, browser]) {
    const server = createServer();
    servers.push(server);
    await new Promise((r) => server.listen(path, r));
  }
  await chmod(app, 0o600);
  await chmod(browser, 0o700);
  assert.equal(await discoverSocket(root), app);
  await chmod(browser, 0o600);
  await assert.rejects(discoverSocket(root), /AMBIGUOUS/);
  await chmod(browser, 0o700);
  await chmod(root, 0o755);
  await assert.rejects(discoverSocket(root), /DIRECTORY_UNSAFE/);
  await chmod(root, 0o700);
  await symlink(app, join(root, "33333333-3333-4333-8333-333333333333.sock"));
  await assert.rejects(discoverSocket(root), /SOCKET_UNSAFE/);
});
