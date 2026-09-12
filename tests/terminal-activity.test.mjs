import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { deploymentBlockers } from "../apps/hub/dist/deployment-status.js";
import { shellTracking, TerminalActivity } from "../apps/hub/dist/terminal-activity.js";
import { terminalProbeScript } from "../apps/hub/dist/terminal-probe.js";
import { devicesFixture } from "./devices-fixture.mjs";

const marker = (a, phase, jobs = 0, pid = 234, birth = "456") =>
  `\x1b]777;codexweb;${a.token};${phase};${pid};${birth};${jobs}\x07`;
const { WebSocket } = createRequire(new URL("../apps/hub/package.json", import.meta.url))("ws");
test("terminal proof requires private shell lifecycle signals; silent commands and editing stay protected", () => {
  const a = new TerminalActivity();
  assert(!a.candidate());
  assert.equal(a.output("looks idle $ "), "looks idle $ ");
  assert(!a.candidate());
  const signal = marker(a, "prompt");
  let output = "";
  for (const char of signal + "shell $ ") output += a.output(char);
  assert.equal(output, "shell $ ");
  assert(a.candidate());
  a.input("sleep 100\r");
  a.output(marker(a, "busy"));
  assert.equal(a.state, "busy");
  assert(!a.candidate(Date.now() + 1000000));
  a.output(marker(a, "prompt"));
  assert(a.candidate(Date.now() + 2000));
  a.input("partly typed command");
  a.output(marker(a, "prompt"));
  assert(!a.candidate(Date.now() + 10000));
});

test("queued lines, background jobs, replaced shell identities and broken notifications cannot prove idle", () => {
  const a = new TerminalActivity();
  a.output(marker(a, "prompt"));
  a.input("one\rtwo\r");
  a.output(marker(a, "busy") + marker(a, "prompt"));
  assert(!a.candidate(Date.now() + 2000));
  a.output(marker(a, "busy") + marker(a, "prompt", 2));
  assert(!a.candidate(Date.now() + 2000));
  a.input("\r");
  a.output(marker(a, "prompt"));
  assert(a.candidate(Date.now() + 2000));
  a.output(marker(a, "prompt", 0, 234, "457"));
  assert(!a.candidate(Date.now() + 2000));
  assert.throws(() => shellTracking("caller text", "linux"));
  assert.throws(() => terminalProbeScript("linux", { pid: 2, birth: "$(unsafe)" }));
});

test("prompt metadata is stripped while bracketed paste remains unsubmitted and visible output stays exact", () => {
  const a = new TerminalActivity();
  assert.equal(a.output("before" + marker(a, "prompt") + "after"), "beforeafter");
  a.input("\x1b[200~first\nsecond\x1b[201~");
  assert(!a.candidate(Date.now() + 2000));
  a.input("\r");
  a.output(marker(a, "busy") + marker(a, "prompt"));
  assert(a.candidate(Date.now() + 2000));
});

test("maintenance distinguishes idle, background work and unknown terminals and reserves input admission", async () => {
  let state = "idle",
    probeCount = 0;
  const f = await devicesFixture("http://127.0.0.1:18873", {
    executionService: true,
    devices: {
      terminalProbe: async () => {
        probeCount++;
        return state;
      },
    },
  });
  const create = () =>
    f.app.inject({
      url: "/api/devices/server/terminals",
      method: "POST",
      headers: { ...f.headers, "idempotency-key": randomUUID() },
      payload: { kind: "shell" },
    });
  try {
    const created = await create();
    assert.equal(created.statusCode, 200, created.body);
    const pty = f.processes[0];
    const blobs = pty.args.join(" ").match(/[A-Za-z0-9+/]{100,}={0,2}/g) ?? [];
    const script = blobs
      .map((v) => Buffer.from(v, "base64").toString())
      .find((v) => v.includes("__cw_token="));
    const token = script.match(/__cw_token='([a-f0-9]{48})'/)[1];
    const status = (method = "GET") =>
      f.app.inject({ url: "/internal/terminals/maintenance", method });
    assert.equal((await status()).json().unknown, 1);
    pty.output(marker({ token }, "prompt"));
    assert.equal((await status()).json().idle, true);
    state = "busy";
    assert.equal((await status("POST")).json().busy, 1);
    assert(!pty.killed);
    state = "unknown";
    assert.equal((await status()).json().unknown, 1);
    state = "idle";
    const blockers = deploymentBlockers(f.store, { busy: 0, unknown: 0 });
    assert(!blockers.some((v) => v.kind.startsWith("terminal")));
    assert(deploymentBlockers(f.store).some((v) => v.kind === "terminal_unknown"));
    assert.equal((await status("POST")).json().reserved, true);
    assert.equal((await create()).statusCode, 503);
    assert.equal(
      Number(
        f.store.db.prepare("SELECT count(*) n FROM commands WHERE state != 'complete'").get().n,
      ),
      0,
    );
    assert.equal(f.processes.length, 1);
    assert(!pty.killed);
    assert(probeCount >= 4);
  } finally {
    await f.close();
  }
});

test("a command arriving during an asynchronous process probe invalidates its idle result", async () => {
  let duringProbe;
  const f = await devicesFixture("http://127.0.0.1:18873", {
    executionService: true,
    devices: {
      terminalProbe: async () => {
        duringProbe();
        return "idle";
      },
    },
  });
  try {
    await f.app.inject({
      url: "/api/devices/server/terminals",
      method: "POST",
      headers: { ...f.headers, "idempotency-key": randomUUID() },
      payload: { kind: "shell" },
    });
    const pty = f.processes[0];
    const script = (pty.args.join(" ").match(/[A-Za-z0-9+/]{100,}={0,2}/g) ?? [])
      .map((v) => Buffer.from(v, "base64").toString())
      .find((v) => v.includes("__cw_token="));
    const token = script.match(/__cw_token='([a-f0-9]{48})'/)[1];
    pty.output(marker({ token }, "prompt"));
    duringProbe = () => pty.output(marker({ token }, "busy"));
    const result = (
      await f.app.inject({ url: "/internal/terminals/maintenance", method: "POST" })
    ).json();
    assert.equal(result.unknown, 1);
    assert.equal(result.reserved, false);
    assert(!pty.killed);
  } finally {
    await f.close();
  }
});

test("reserved maintenance rejects WebSocket input without forwarding or replaying it", async () => {
  const f = await devicesFixture("http://127.0.0.1:18873", {
    executionService: true,
    devices: { terminalProbe: async () => "idle" },
  });
  let socket;
  try {
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const info = (
      await f.app.inject({
        url: "/api/devices/server/terminals",
        method: "POST",
        headers: { ...f.headers, "idempotency-key": randomUUID() },
        payload: { kind: "shell" },
      })
    ).json();
    const pty = f.processes[0];
    const script = (pty.args.join(" ").match(/[A-Za-z0-9+/]{100,}={0,2}/g) ?? [])
      .map((v) => Buffer.from(v, "base64").toString())
      .find((v) => v.includes("__cw_token="));
    const token = script.match(/__cw_token='([a-f0-9]{48})'/)[1];
    pty.output(marker({ token }, "prompt"));
    const ticket = (
      await f.app.inject({
        url: `/api/device-terminals/${info.id}/ticket`,
        method: "POST",
        headers: f.headers,
      })
    ).json().ticket;
    socket = new WebSocket(
      `ws://127.0.0.1:${f.app.server.address().port}/api/device-terminals/${info.id}/socket`,
      { headers: { cookie: f.headers.cookie, origin: "http://127.0.0.1:18873" } },
    );
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ ticket }));
    await ready;
    assert.equal(
      (await f.app.inject({ url: "/internal/terminals/maintenance", method: "POST" })).json()
        .reserved,
      true,
    );
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "input", data: "must not execute\r" }));
    await closed;
    assert.deepEqual(pty.writes, []);
    assert(!pty.killed);
  } finally {
    socket?.terminate();
    await f.close();
  }
});

test("startup input, interrupts and alternate jobs remain bounded by real completion", () => {
  const a = new TerminalActivity();
  a.input("sleep 100\r");
  a.output(marker(a, "prompt"));
  assert(!a.candidate(Date.now() + 2000));
  a.output(marker(a, "busy"));
  a.input("\x03");
  a.output(marker(a, "prompt"));
  assert(a.candidate(Date.now() + 2000));
  a.input("background threaded job\r");
  a.output(marker(a, "busy") + marker(a, "prompt", 2));
  assert(!a.candidate(Date.now() + 2000));
  a.input("\r");
  a.output(marker(a, "prompt", 0));
  assert(a.candidate(Date.now() + 2000));
});
