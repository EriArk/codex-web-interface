import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { parseDeviceSnapshot, terminalCommand } from "../apps/hub/dist/device-transport.js";
import { devicesFixture } from "./devices-fixture.mjs";

const require = createRequire(new URL("../apps/hub/package.json", import.meta.url));
const { WebSocket } = require("ws");
test("device terminals require auth/origin, submit once, retain independent output and revoke on logout", async () => {
  const f = await devicesFixture();
  await f.app.listen({ port: 18873, host: "127.0.0.1" });
  const sockets = [];
  try {
    assert.equal((await f.app.inject({ url: "/api/devices" })).statusCode, 401);
    const list = await f.app.inject({ url: "/api/devices", headers: f.headers });
    assert.equal(list.json().devices.length, 2);
    assert(!list.body.includes("private"));
    const create = (id, key, body = { kind: "shell" }, headers = f.headers) =>
      f.app.inject({
        url: `/api/devices/${id}/terminals`,
        method: "POST",
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      });
    assert.equal(
      (await create("server", randomUUID(), { kind: "shell" }, { cookie: f.headers.cookie }))
        .statusCode,
      403,
    );
    assert.equal(
      (await create("server", randomUUID(), { kind: "restart", confirmation: "ПК" })).statusCode,
      409,
    );
    const key = randomUUID(),
      first = await create("server", key);
    assert.equal(first.statusCode, 200, first.body);
    const info = first.json();
    assert.equal((await create("server", key)).json().id, info.id);
    assert.equal(f.processes.length, 1);
    assert.equal(
      (await create("server", key, { kind: "shutdown", confirmation: "Сервер" })).statusCode,
      409,
    );
    const ticket = async () =>
      (
        await f.app.inject({
          url: `/api/device-terminals/${info.id}/ticket`,
          method: "POST",
          headers: f.headers,
        })
      ).json().ticket;
    const attach = async (token, origin = "http://127.0.0.1:18873") => {
      const socket = new WebSocket(`ws://127.0.0.1:18873/api/device-terminals/${info.id}/socket`, {
        headers: { cookie: f.headers.cookie, origin },
      });
      sockets.push(socket);
      const messages = [];
      socket.on("message", (m) => messages.push(JSON.parse(m)));
      await once(socket, "open");
      socket.send(JSON.stringify({ ticket: token }));
      return { socket, messages };
    };
    const token = await ticket(),
      a = await attach(token);
    await new Promise((r) => setTimeout(r, 100));
    assert(a.messages.some((m) => m.type === "ready"));
    a.socket.send(JSON.stringify({ type: "input", data: "hello\r" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(f.processes[0].writes, ["hello\r"]);
    a.socket.close();
    await once(a.socket, "close");
    assert(!f.processes[0].killed);
    const b = await attach(await ticket());
    await new Promise((r) => setTimeout(r, 60));
    assert(b.messages.some((m) => m.data?.includes("hello")));
    const replay = await attach(token);
    await once(replay.socket, "close");
    assert.equal(replay.messages.length, 0);
    const pc = await create("pc", randomUUID());
    assert.equal(pc.statusCode, 200);
    assert(f.processes[1].args.includes("powershell.exe"));
    assert(!f.processes[0].args.includes("powershell.exe"));
    const snaps = await Promise.all(
      [1, 2, 3].map(() =>
        f.app.inject({ url: "/api/devices/server/snapshot", headers: f.headers }),
      ),
    );
    assert(snaps.every((r) => r.json().online));
    assert.deepEqual(f.probes, ["server"]);
    await f.app.inject({
      url: "/api/device-terminals/" + info.id,
      method: "DELETE",
      headers: f.headers,
    });
    assert(f.processes[0].killed);
    assert(!f.processes[1].killed);
    assert.equal(f.calls.length, 0);
    assert.equal(f.desktopCalls.length, 0);
    const revoked = once(b.socket, "close");
    await f.app.inject({ url: "/api/auth/logout", method: "POST", headers: f.headers });
    await revoked;
    assert(f.processes[1].killed);
    assert(!f.processes[0].writes.includes("after logout"));
  } finally {
    for (const s of sockets) s.terminate();
    await f.close();
  }
});
test("device scripts quote mount paths, reject credential URLs and normalize unavailable/invalid sensors", () => {
  const d = {
    id: "server",
    name: "Сервер",
    platform: "linux",
    ssh: { target: "private", configFile: "/private/config" },
    shell: "powershell",
    power: true,
    mounts: true,
  };
  assert.throws(() =>
    terminalCommand(d, {
      kind: "mount",
      confirmation: d.name,
      protocol: "smb",
      name: "share",
      credentials: true,
      source: "//user:password@host/share",
    }),
  );
  const command = terminalCommand(d, {
    kind: "mount",
    confirmation: d.name,
    protocol: "smb",
    name: "share",
    credentials: true,
    source: "//host/share'$(touch /tmp/unsafe)",
  }).join(" ");
  assert(command.includes("'\\''"));
  assert(!command.includes("password="));
  const mounted = terminalCommand(
    { ...d, platform: "windows" },
    {
      kind: "mount",
      confirmation: d.name,
      protocol: "smb",
      name: "Z",
      credentials: true,
      source: "//host/share",
    },
  );
  assert(mounted.includes("-NoExit"));
  const script = Buffer.from(mounted[mounted.indexOf("-EncodedCommand") + 1], "base64").toString(
    "utf16le",
  );
  assert(script.includes("Set-Location -LiteralPath"));
  assert(!script.includes("Press Enter to close"));
  const snap = parseDeviceSnapshot(
    "windows",
    JSON.stringify({
      os: "Windows",
      cpu: "CPU",
      disks: [{ name: "x", mount: "C:", total: 10, available: 20 }],
      temperatures: [
        { name: "bad", celsius: 999 },
        { name: "ok", celsius: 42 },
      ],
    }),
  );
  assert.equal(snap.disks[0].available, 10);
  assert.equal(snap.temperatures.length, 1);
});
test("stored command output is bound to exact result, thread and native command", async () => {
  const f = await devicesFixture();
  try {
    const turn = "turn-output",
      source = "command-id";
    f.store.append(
      f.thread.id,
      "activity.command",
      { itemId: source, output: "\u001b[32mOK\u001b[0m\n  exact whitespace\n" },
      turn,
    );
    f.store.result(f.thread.id, turn, source, "check", "Check", {
      command: "pnpm test",
      exitCode: 0,
    });
    const row = f.store.db.prepare("SELECT id FROM results WHERE sourceKey=?").get(source);
    const url = `/api/threads/${f.thread.id}/results/${row.id}/output`;
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    const value = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(value.text, "OK\n  exact whitespace\n");
    assert(value.available);
    const other = f.store.createThread("project", randomUUID(), "Other");
    assert.equal(
      (await f.app.inject({ url: url.replace(f.thread.id, other.id), headers: f.headers }))
        .statusCode,
      404,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("slow terminal readers stay bounded and reconnect to the saved tail without replaying input", async () => {
  const f = await devicesFixture();
  await f.app.listen({ port: 18873, host: "127.0.0.1" });
  const sockets = [];
  try {
    const info = (
      await f.app.inject({
        url: "/api/devices/server/terminals",
        method: "POST",
        headers: { ...f.headers, "idempotency-key": randomUUID() },
        payload: { kind: "shell" },
      })
    ).json();
    const connect = async (ack) => {
      const token = (
        await f.app.inject({
          url: `/api/device-terminals/${info.id}/ticket`,
          method: "POST",
          headers: f.headers,
        })
      ).json().ticket;
      const socket = new WebSocket(`ws://127.0.0.1:18873/api/device-terminals/${info.id}/socket`, {
        headers: { cookie: f.headers.cookie, origin: "http://127.0.0.1:18873" },
      });
      sockets.push(socket);
      let text = "";
      let ready;
      const started = new Promise((r) => (ready = r));
      socket.on("message", (v) => {
        const m = JSON.parse(v);
        if (m.type === "ready") ready();
        if (m.type === "output") {
          text += m.data;
          if (ack) socket.send(JSON.stringify({ type: "ack", length: m.data.length }));
        }
      });
      await once(socket, "open");
      socket.send(JSON.stringify({ ticket: token }));
      await started;
      return { socket, text: () => text };
    };
    const slow = await connect(false),
      closed = once(slow.socket, "close");
    // The fixture emits its startup prompt asynchronously. Finish that phase before
    // defining the final output marker; otherwise a late prompt follows TAIL-END.
    const startupDeadline = Date.now() + 5000;
    while (Date.now() < startupDeadline && !slow.text().includes("Device ready"))
      await new Promise((r) => setTimeout(r, 20));
    assert(slow.text().includes("Device ready"));
    for (let i = 0; i < 40; i++) f.processes[0].output("x".repeat(4096));
    f.processes[0].output("TAIL-END");
    await closed;
    assert(slow.text().length <= 32768);
    assert(!f.processes[0].killed);
    const recovered = await connect(true);
    // A full parallel suite can delay WebSocket ACK/flush cycles beyond one second.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !recovered.text().endsWith("TAIL-END"))
      await new Promise((r) => setTimeout(r, 20));
    assert(recovered.text().endsWith("TAIL-END"));
    assert(recovered.text().length <= 65536);
    assert.equal(f.processes.length, 1);
    assert.deepEqual(f.processes[0].writes, []);
  } finally {
    for (const s of sockets) s.terminate();
    await f.close();
  }
});
