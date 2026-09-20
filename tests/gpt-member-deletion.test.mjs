import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeEnrollment } from "../ops/gpt-native/enrollment.mjs";
import { NativeReadService, listenNative } from "../ops/gpt-native/service.mjs";
import { NativeDispatchReceipts } from "../ops/gpt-native/dispatch-receipts.mjs";
import { NativeLibraryReceipts } from "../ops/gpt-native/library-receipts.mjs";
import { Store } from "../apps/hub/dist/store.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import { TeamGpt } from "../apps/hub/dist/team-gpt.js";
import { privateConfig } from "../apps/hub/dist/team-hub.js";
import { Library } from "../apps/hub/dist/library.js";
import { GptDeletions } from "../apps/hub/dist/gpt-deletions.js";
import { configSchema } from "../packages/shared/dist/index.js";

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "cw-member-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("member activation binds own account, survives restart, refuses another identity", async (t) => {
  const root = temp(t),
    userId = randomUUID();
  let fingerprint = "a".repeat(64);
  writeFileSync(join(root, "enrollment.json"), JSON.stringify({ userId }), { mode: 0o600 });
  const reader = {
    inspectAccount: async () => ({ build: "26.915.31945", accountFingerprint: fingerprint }),
  };
  const create = (b) =>
    new NativeReadService({ ...b, reader, statePath: join(root, "manual.json") });
  let enrollment = new NativeEnrollment(root, reader, create);
  const call = (operation, extra = {}) => enrollment.request({ userId, operation, ...extra });
  await assert.rejects(call("readModels"), /LOGIN_REQUIRED/);
  const leaseId = randomUUID();
  await call("beginManual", { leaseId });
  await call("activate");
  assert.equal((await call("status")).manual, true);
  await call("endManual", { leaseId });
  enrollment = new NativeEnrollment(root, reader, create);
  await call("activate");
  assert.equal((await call("status")).manual, false);
  fingerprint = "b".repeat(64);
  await assert.rejects(call("activate"), /ACCOUNT_MISMATCH/);
  await assert.rejects(call("status", { userId: randomUUID() }), /WRONG_OWNER/);
  assert.equal(
    JSON.parse(readFileSync(join(root, "binding.json"))).accountFingerprint,
    "a".repeat(64),
  );
});
test("two members activate separate sockets and private configurations; owner remains unchanged", async (t) => {
  const root = temp(t);
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://fixture.invalid",
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "owner" },
    team: {
      enabled: true,
      root: join(root, "team"),
      gptProfiles: { enabled: true, runtime: "native", maxProfiles: 3 },
    },
    machines: [],
    projects: [],
  });
  const owner = new Store(config.hub.databasePath);
  owner.db.prepare("INSERT INTO users VALUES('owner','unused')").run();
  const registry = new TeamStore(join(config.team.root, "team.db"), config, owner);
  t.after(() => {
    registry.close();
    owner.close();
  });
  config.nativeGpt = {
    userId: registry.ownerId,
    accountFingerprint: "c".repeat(64),
    socketPath: join(root, "owner.sock"),
  };
  const gpt = new TeamGpt(config, registry),
    ids = [];
  for (const [index, fp] of ["a", "b"].entries()) {
    const id = randomUUID();
    ids.push(id);
    const original = registry.db
      .prepare("SELECT * FROM team_users WHERE id=?")
      .get(registry.ownerId);
    const columns = Object.keys(original),
      values = columns.map((k) =>
        k === "id"
          ? id
          : k === "login"
            ? "member" + index
            : k === "role"
              ? "member"
              : k === "legacy"
                ? 0
                : original[k],
      );
    registry.db
      .prepare(
        `INSERT INTO team_users(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      )
      .run(...values);
    gpt.request(id);
    registry.db.prepare("UPDATE team_gpt_profiles SET state='ready' WHERE userId=?").run(id);
    const adapter = join(config.team.root, "users", id, "gpt", "native-adapter");
    mkdirSync(adapter, { recursive: true, mode: 0o700 });
    writeFileSync(join(adapter, "enrollment.json"), JSON.stringify({ userId: id }), {
      mode: 0o600,
    });
    const reader = {
      inspectAccount: async () => ({ build: "26.915.31945", accountFingerprint: fp.repeat(64) }),
    };
    const server = await listenNative(
      new NativeEnrollment(
        adapter,
        reader,
        (b) => new NativeReadService({ ...b, reader, statePath: join(adapter, "manual.json") }),
      ),
      join(adapter, "adapter.sock"),
    );
    t.after(() => new Promise((resolve) => server.close(resolve)));
    assert.equal(privateConfig(config, registry, id).nativeGpt, undefined);
    await gpt.activate(id);
    const personal = privateConfig(config, registry, id);
    assert.equal(personal.gpt, undefined);
    assert.equal(personal.nativeGpt.userId, id);
    assert.equal(personal.nativeGpt.accountFingerprint, fp.repeat(64));
    assert.equal(gpt.connection(id).native, true);
  }
  assert.notEqual(gpt.nativeRuntime(ids[0]).socketPath, gpt.nativeRuntime(ids[1]).socketPath);
  assert.deepEqual(privateConfig(config, registry, registry.ownerId).nativeGpt, config.nativeGpt);
});
test("deletion is immediate locally, waits while busy, and reconciles after restart without resending", async (t) => {
  const store = new Store(join(temp(t), "app.db"));
  t.after(() => store.close());
  const library = new Library(store, "gpt"),
    id = randomUUID(),
    key = randomUUID();
  let calls = [];
  const workspace = {
    client: {
      libraryMutation: async (r, checkOnly) => {
        calls.push({ r, checkOnly });
        return { state: checkOnly ? "completed" : "unknown" };
      },
    },
  };
  let queue = new GptDeletions(store, library, workspace);
  assert.equal(queue.enqueue(key, id).pending, true);
  assert.equal(library.get("thread", id).deleted, true);
  await queue.tick(
    () => {},
    () => false,
  );
  assert.equal(calls.length, 0);
  await queue.tick(
    () => {},
    () => true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].checkOnly, false);
  queue = new GptDeletions(store, library, workspace);
  queue.enqueue(key, id);
  store.db.prepare("UPDATE gpt_deletions SET nextAt=0").run();
  await queue.tick(
    () => {},
    () => true,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].checkOnly, true);
  assert.equal(calls[0].r.key, calls[1].r.key);
  assert.equal(store.db.prepare("SELECT done FROM gpt_deletions").get().done, 1);
  assert.throws(() => queue.enqueue(key, randomUUID()), /Ключ/);
});
test("unknown deletion blocks only its own chat and absent native chats finish without a write", async (t) => {
  const root = temp(t),
    id = randomUUID(),
    other = randomUUID();
  const dispatch = new NativeDispatchReceipts({
    path: join(root, "dispatch.sqlite"),
    userId: randomUUID(),
    accountFingerprint: "a".repeat(64),
    conversationIds: [id, other],
  });
  t.after(() => dispatch.close());
  const library = new NativeLibraryReceipts(dispatch),
    r = { key: randomUUID(), kind: "thread", id, action: "delete", confirm: true };
  let reads = 0;
  const reader = {
    readLibrary: async () => {
      if (reads++) throw Error("offline");
      return { exists: true, canWrite: true, name: "test", projectId: null };
    },
    mutateLibrary: async () => {
      throw Error("lost ack");
    },
  };
  assert.equal((await library.run(r, reader)).state, "unknown");
  assert.equal(dispatch.blocksDispatch(id), true);
  assert.equal(dispatch.blocksDispatch(other), false);
  assert.equal(
    (
      await library.run(
        r,
        { readLibrary: async () => ({ exists: false, name: "", projectId: null }) },
        true,
      )
    ).state,
    "completed",
  );
  assert.equal(
    (
      await library.run(
        { ...r, key: randomUUID() },
        {
          readLibrary: async () => ({ exists: false, name: "", projectId: null }),
          mutateLibrary: async () => assert.fail("already absent"),
        },
      )
    ).state,
    "completed",
  );
});
