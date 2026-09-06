import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectDiagnostics, safeVersion, sshFailure } from "../apps/hub/dist/doctor.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";

test("doctor preserves active state and emits no source, credential or RPC payload fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-doctor-")),
    secret = "DO_NOT_DISCLOSE_987654321";
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://qa.example.test",
      port: 1,
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "owner" },
    machines: [
      {
        id: "private-host",
        name: secret,
        type: "ssh-windows",
        ssh: { target: secret },
        codex: { command: secret, launcher: secret },
      },
    ],
    projects: [
      {
        id: "p",
        name: secret,
        machineId: "private-host",
        workingDirectory: "D:\\Private\\" + secret,
      },
    ],
  });
  const store = new Store(config.hub.databasePath);
  await mkdir(config.hub.resultsPath, { mode: 0o700 });
  const thread = store.createThread("p", "native", secret);
  store.setStatus(thread.id, "running", "turn");
  store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", secret);
  store.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(secret, secret, 9999999999999);
  const before = store.thread(thread.id);
  let closed = false;
  try {
    const report = await collectDiagnostics(
      config,
      {},
      {
        ssh: async () => "SSH_OK",
        codex: async () => ({ available: true, version: "codex-cli 0.153.4\n" + secret }),
        rpc: () => ({
          initialize: async () => ({ private: secret }),
          request: async (method) =>
            method === "account/read"
              ? { account: { token: secret, email: secret } }
              : { data: [{ name: secret, path: secret }] },
          close: () => {
            closed = true;
          },
        }),
      },
    );
    assert(!JSON.stringify(report).includes(secret));
    assert(!JSON.stringify(report).includes("private-host"));
    assert.equal(report.machines[0].codexVersion, "0.153.4");
    assert(report.checks.some((c) => c.code === "CODEX_AUTHENTICATED"));
    assert(report.checks.some((c) => c.boundary.endsWith("/companion-stdio") && c.state === "ok"));
    assert.deepEqual(store.thread(thread.id), before);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
    assert(closed);
    const offline = await collectDiagnostics(
      config,
      { offline: true },
      {
        ssh: async () => {
          throw Error("must not run");
        },
      },
    );
    assert(offline.checks.some((c) => c.code === "NETWORK_PROBES_SKIPPED"));
    const failed = await collectDiagnostics(
      config,
      {},
      {
        ssh: async () => "SSH_AUTH_FAILED",
        codex: async () => {
          throw Error("must not run");
        },
      },
    );
    assert(failed.checks.some((c) => c.boundary.endsWith("/ssh") && c.code === "SSH_AUTH_FAILED"));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("diagnostic classifiers produce only bounded recognized version and failure codes", () => {
  assert.equal(safeVersion("secret arbitrary text"), undefined);
  assert.equal(safeVersion("codex-cli 0.153.4 secret"), "0.153.4");
  assert.equal(sshFailure("sensitive-path: Permission denied (publickey)"), "SSH_AUTH_FAILED");
  assert.equal(sshFailure("SECRET REMOTE HOST IDENTIFICATION HAS CHANGED"), "SSH_HOST_KEY_FAILED");
  assert.equal(sshFailure("unexpected private detail"), "SSH_UNREACHABLE");
});
