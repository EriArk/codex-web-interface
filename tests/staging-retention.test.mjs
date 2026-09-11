import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { maintainMachineStaging } from "../apps/hub/dist/staging-maintenance.js";
import { Store } from "../apps/hub/dist/store.js";
import { stagingProbe } from "../packages/machines/dist/stagingProbe.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "staging-qa-")),
    base = join(root, "CodexWeb"),
    directory = join(base, "attachments", "project", randomUUID());
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const partial = join(directory, ".upload-" + randomUUID() + ".part"),
    complete = join(directory, "upload-file.txt"),
    fresh = join(directory, ".upload-" + randomUUID() + ".part");
  await writeFile(partial, "old incomplete");
  await writeFile(complete, "required by native history");
  await writeFile(fresh, "active transfer");
  const old = new Date(Date.now() - 40 * 86400000);
  await utimes(partial, old, old);
  return { root, base, directory, partial, complete, fresh };
}
test("staging inventory measures actual copies; only aged unfinished transport files can retire", async (t) => {
  const f = await fixture(t),
    report = await stagingProbe(f.base, { op: "inspect" });
  assert.equal(report.files, 3);
  assert.equal(report.temporaryFiles, 2);
  assert.equal(report.partial, false);
  const plan = await stagingProbe(f.base, { op: "plan" });
  assert.equal(plan.candidates.length, 1);
  const bytes = await stagingProbe(f.base, { op: "read", files: plan.candidates });
  assert.equal(Buffer.from(bytes.contents[0].base64, "base64").toString(), "old incomplete");
  assert.equal((await stagingProbe(f.base, { op: "remove", files: plan.candidates })).removed, 1);
  assert.equal(await readFile(f.complete, "utf8"), "required by native history");
  assert.equal(await readFile(f.fresh, "utf8"), "active transfer");
  await assert.rejects(
    stagingProbe(f.base, {
      op: "remove",
      files: [
        {
          ...plan.candidates[0],
          path: plan.candidates[0].path.replace(/\.upload-.+\.part$/, "upload-file.txt"),
        },
      ],
    }),
  );
});
test("staging rejects changed content, escaping paths, hard/symbolic links and young partial copies", async (t) => {
  const f = await fixture(t),
    plan = await stagingProbe(f.base, { op: "plan" }),
    file = plan.candidates[0];
  await writeFile(f.partial, "changed incomplete");
  await assert.rejects(stagingProbe(f.base, { op: "remove", files: [file] }));
  assert.equal(await readFile(f.partial, "utf8"), "changed incomplete");
  for (const patch of [
    { path: "../owner-file" },
    { path: file.path.replace("attachments/", "other/") },
    { mtime: Date.now() },
  ])
    await assert.rejects(stagingProbe(f.base, { op: "remove", files: [{ ...file, ...patch }] }));
  await symlink(f.root, join(f.base, "attachments", "escape"), "dir");
  assert.equal((await stagingProbe(f.base, { op: "inspect" })).partial, true);
});
test("staging maintenance verifies a private backup before deletion and preserves receipts/history", async (t) => {
  const f = await fixture(t),
    config = configSchema.parse({
      hub: {
        publicBaseUrl: "https://qa.test",
        databasePath: join(f.root, "hub.db"),
        resultsPath: join(f.root, "results"),
      },
      auth: {},
      machines: [{ id: "pc", name: "PC", type: "ssh-windows", ssh: { target: "unused" } }],
      projects: [],
    }),
    store = new Store(config.hub.databasePath);
  t.after(() => store.close());
  const result = await maintainMachineStaging(config, "pc", join(f.root, "backups"), (_m, q) =>
    stagingProbe(f.base, q),
  );
  assert.equal(result.removedFiles, 1);
  const manifest = JSON.parse(await readFile(join(result.snapshot, "manifest.json"), "utf8"));
  assert.equal(manifest.machineId, "pc");
  assert.equal(
    await readFile(join(result.snapshot, manifest.files[0].backup), "utf8"),
    "old incomplete",
  );
  assert.equal(await readFile(f.complete, "utf8"), "required by native history");
});
test("invalid backup bytes or new active work never trigger staging deletion", async (t) => {
  const f = await fixture(t),
    config = configSchema.parse({
      hub: {
        publicBaseUrl: "https://qa.test",
        databasePath: join(f.root, "hub.db"),
        resultsPath: join(f.root, "results"),
      },
      auth: {},
      machines: [{ id: "pc", name: "PC", type: "ssh-windows", ssh: { target: "unused" } }],
      projects: [],
    }),
    store = new Store(config.hub.databasePath);
  t.after(() => store.close());
  let removes = 0;
  const probe = async (_m, q) => {
    if (q.op === "remove") removes++;
    const r = await stagingProbe(f.base, q);
    if (q.op === "read") r.contents[0].base64 = "eA==";
    return r;
  };
  await assert.rejects(maintainMachineStaging(config, "pc", join(f.root, "backups"), probe));
  assert.equal(removes, 0);
  assert.equal(await readFile(f.partial, "utf8"), "old incomplete");
  const thread = store.createThread("p", "native", "Task");
  store.setStatus(thread.id, "running", "turn");
  await assert.rejects(
    maintainMachineStaging(config, "pc", join(f.root, "backups"), probe),
    /завершения/,
  );
  assert.equal(removes, 0);
});

test("computer storage inventory requires auth, deduplicates concurrent reads and exposes no paths or native writes", async (t) => {
  let calls = 0,
    release;
  const gate = new Promise((r) => (release = r));
  const f = await handoffFixture(undefined, undefined, {
    stagingProbe: async () => {
      calls++;
      await gate;
      return {
        bytes: 1234,
        files: 3,
        temporaryBytes: 100,
        temporaryFiles: 1,
        previewBytes: 2,
        receipts: 1,
        partial: false,
        checkedAt: Date.now(),
        candidates: [{ path: "private path must not escape" }],
      };
    },
  });
  t.after(() => f.close());
  assert.equal((await f.app.inject({ url: "/api/storage/staging" })).statusCode, 401);
  assert.equal(calls, 0);
  const reads = [1, 2].map(() => f.app.inject({ url: "/api/storage/staging", headers: f.headers }));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const replies = await Promise.all(reads);
  for (const r of replies) {
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().machines[0].inventory.bytes, 1234);
    assert(!r.body.includes("private path"));
    assert(!r.body.includes("candidates"));
  }
  await f.app.inject({ url: "/api/storage/staging", headers: f.headers });
  assert.equal(calls, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
