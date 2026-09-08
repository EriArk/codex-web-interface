import assert from "node:assert/strict";
import test from "node:test";
import { MachineHealthService, probeMachine } from "../apps/hub/dist/machineHealth.js";
import { readMachineResources } from "../packages/machines/dist/resources.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const windows = {
  id: "pc",
  name: "PC",
  type: "ssh-windows",
  ssh: { target: "private-user@private-host" },
  codex: { launcher: "C:/private/launcher.ps1" },
  remote: {
    host: "private-remote",
    port: 5900,
    provider: "vnc",
    passwordSecret: "PRIVATE_PASSWORD",
  },
};
const fixture = () => {
  const calls = [];
  return {
    calls,
    dependencies: {
      ssh: async () => {
        calls.push("ssh");
        return "SSH_OK";
      },
      codex: async () => ({ available: true, version: "codex-cli 0.153.4 secret-ignored" }),
      resources: async () => ({ memoryTotal: 16000000000, memoryAvailable: 8000000000 }),
      remote: async () => true,
      rpc: () => ({
        initialize: async () => {
          calls.push("initialize");
          return {};
        },
        request: async (method) => {
          calls.push(method);
          return method === "account/read"
            ? {
                requiresOpenaiAuth: true,
                account: { type: "chatgpt", privateToken: "never return" },
              }
            : { data: [{ id: "test" }] };
        },
        close: () => calls.push("close"),
      }),
    },
  };
};
test("diagnostics normalize independent transport/Codex/Companion/login/model/Remote layers without acquiring a thread", async () => {
  const { calls, dependencies } = fixture();
  const probe = await probeMachine(windows, "C:/private/project", dependencies);
  assert(probe.online);
  assert.equal(probe.codexVersion, "0.153.4");
  assert(probe.checks.every((c) => c.state === "ok"));
  assert.deepEqual(calls, ["ssh", "initialize", "account/read", "model/list", "close"]);
  const json = JSON.stringify(probe);
  for (const value of [
    "private-user",
    "private-host",
    "private/project",
    "private-remote",
    "PRIVATE_PASSWORD",
    "never return",
    "secret-ignored",
  ])
    assert(!json.includes(value));
});
test("offline SSH keeps a distinct failure and does not attempt Codex, Companion or system metrics", async () => {
  const { calls, dependencies } = fixture();
  dependencies.ssh = async () => "SSH_AUTH_FAILED";
  dependencies.resources = async () => {
    throw Error("must not read metrics");
  };
  dependencies.codex = async () => {
    throw Error("must not launch");
  };
  dependencies.remote = async () => false;
  const probe = await probeMachine(windows, "C:/private/project", dependencies);
  assert.equal(probe.online, false);
  assert.equal(probe.checks[0].code, "SSH_AUTH_FAILED");
  assert(probe.checks.some((c) => c.code === "REMOTE_UNREACHABLE"));
  assert.equal(calls.length, 0);
});
test("unavailable Companion and malformed/login-required accounts remain truthful; probe clients always close", async () => {
  const { calls, dependencies } = fixture();
  dependencies.rpc = () => ({
    initialize: async () => {
      throw Error("private pipe path");
    },
    request: async () => ({}),
    close: () => calls.push("close"),
  });
  const failed = await probeMachine(windows, "C:/private/project", dependencies);
  assert(failed.checks.some((c) => c.code === "COMPANION_LAUNCH_UNCONFIRMED"));
  assert(failed.checks.some((c) => c.code === "CODEX_PROTOCOL_UNAVAILABLE"));
  assert(calls.includes("close"));
  for (const [account, code] of [
    [{ requiresOpenaiAuth: true, account: null }, "CODEX_LOGIN_REQUIRED"],
    [{}, "CODEX_ACCOUNT_UNKNOWN"],
  ]) {
    dependencies.rpc = () => ({
      initialize: async () => ({}),
      request: async (method) => (method === "account/read" ? account : { broken: true }),
      close: () => {},
    });
    const probe = await probeMachine(windows, "C:/private/project", dependencies);
    assert(probe.checks.some((c) => c.code === code));
    assert(probe.checks.some((c) => c.code === "CODEX_MODELS_UNAVAILABLE"));
  }
});
test("overview is cached and cheap, deduplicates concurrent checks, retains last seen and marks stale data", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { calls, dependencies } = fixture();
  let now = 100000;
  dependencies.now = () => now;
  const service = new MachineHealthService(f.sessions, dependencies);
  for (let i = 0; i < 10; i++) assert(service.overview().machines[0].stale);
  assert.equal(calls.length, 0);
  await Promise.all([service.check("pc"), service.check("pc"), service.check("pc")]);
  assert.equal(calls.filter((c) => c === "ssh").length, 1);
  await service.check("pc");
  assert.equal(calls.filter((c) => c === "ssh").length, 1);
  assert.equal(service.overview().machines[0].lastSeenAt, 100000);
  assert(!service.overview().machines[0].stale);
  now += 61000;
  assert(service.overview().machines[0].stale);
  dependencies.ssh = async () => "SSH_UNREACHABLE";
  await service.check("pc");
  const card = service.overview().machines[0];
  assert(!card.probe.online);
  assert.equal(card.lastSeenAt, 100000);
  assert.equal(card.probe.checkedAt, 161000);
  const recreated = new MachineHealthService(f.sessions, dependencies);
  assert.equal(recreated.overview().machines[0].lastSeenAt, 100000);
});
test("machine routes enforce auth/CSRF and reject host/command overrides", async (t) => {
  const { calls, dependencies } = fixture(),
    f = await handoffFixture(undefined, undefined, { machineDiagnostics: dependencies });
  t.after(() => f.close());
  assert.equal((await f.app.inject({ url: "/api/machines/overview" })).statusCode, 401);
  assert.equal(
    (await f.app.inject({ url: "/api/machines/overview", headers: f.headers })).statusCode,
    200,
  );
  assert.equal(calls.length, 0);
  const url = "/api/machines/pc/diagnostics";
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url,
        headers: { cookie: f.headers.cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  for (const payload of [{ host: "evil" }, { command: "kill" }])
    assert.equal(
      (await f.app.inject({ method: "POST", url, headers: f.headers, payload })).statusCode,
      400,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/machines/missing/diagnostics",
        headers: f.headers,
        payload: {},
      })
    ).statusCode,
    404,
  );
  const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().machines[0].probe.online, true);
  assert(!response.body.includes("C:/"));
  assert.equal(f.calls.filter((c) => ["turn/start", "thread/resume"].includes(c.method)).length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
test("local Linux resource metrics are cheap, bounded numeric data and need no SSH", async () => {
  const metrics = await readMachineResources({ type: "local-linux" }, process.cwd());
  assert(metrics.memoryTotal > 0);
  assert(metrics.memoryAvailable >= 0);
  assert(metrics.diskAvailable >= 0);
  assert(metrics.bootedAt < Date.now());
  const { dependencies } = fixture();
  dependencies.ssh = async () => {
    throw Error("not used");
  };
  const probe = await probeMachine(
    { id: "linux", name: "Hub", type: "local-linux", codex: {} },
    process.cwd(),
    dependencies,
  );
  assert.equal(probe.checks[0].code, "LOCAL");
  assert(probe.checks.some((c) => c.code === "REMOTE_NOT_CONFIGURED"));
});
