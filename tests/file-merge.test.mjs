import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileToolsProbe } from "../packages/machines/dist/fileToolsProbe.js";
import { handoffFixture } from "./handoff-fixture.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(join(os.tmpdir(), "folder-merge-"));
  const root = join(temp, "project");
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const probe = (request) => fileToolsProbe(root, request, join(temp, "receipts"));
  const write = async (path, data = "content") => {
    await fs.mkdir(join(root, path, ".."), { recursive: true });
    await fs.writeFile(join(root, path), data);
  };
  const dir = (path) => fs.mkdir(join(root, path), { recursive: true });
  const stat = (path) => probe({ op: "stat", path });
  const plan = async (transfer = "copy") =>
    probe({
      op: "merge-plan",
      path: "source",
      target: "target",
      transfer,
      fingerprint: (await stat("source")).fingerprint,
      targetFingerprint: (await stat("target")).fingerprint,
    });
  const run = (request) => probe({ ...request, id: request.id ?? randomUUID() });
  return { root, probe, write, dir, stat, plan, run };
}

test("recursive merge keeps target-only files, carries empty/new folders and preserves skipped sources", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "source/nested",
    "target/nested",
    "source/new/empty",
    "source/empty",
    "target/empty",
  ])
    await f.dir(name);
  await f.write("source/nested/replace.txt", "new bytes");
  await f.write("target/nested/replace.txt", "old bytes");
  await f.write("source/nested/keep.txt", "keep source");
  await f.write("target/nested/keep.txt", "keep target");
  await f.write("source/new/data.bin", "binary bytes");
  await f.write("target/only.txt", "untouched");
  const plan = await f.plan("move");
  const copied = plan.merge.find((e) => e.request.path === "source/new");
  assert.equal(copied.request.op, "move");
  for (const entry of plan.merge) {
    if (entry.request.path === "source/nested/keep.txt") continue;
    const request = {
      ...entry.request,
      ...(entry.destination ? { targetFingerprint: entry.destination.fingerprint } : {}),
    };
    const result = await f.run(request);
    if (["source", "source/nested"].includes(request.path)) assert.equal(result.retained, true);
  }
  assert.equal(await fs.readFile(join(f.root, "source/nested/keep.txt"), "utf8"), "keep source");
  assert.equal(await fs.readFile(join(f.root, "target/nested/keep.txt"), "utf8"), "keep target");
  assert.equal(await fs.readFile(join(f.root, "target/nested/replace.txt"), "utf8"), "new bytes");
  assert.equal(await fs.readFile(join(f.root, "target/only.txt"), "utf8"), "untouched");
  assert((await fs.stat(join(f.root, "target/new/empty"))).isDirectory());
  await assert.rejects(fs.stat(join(f.root, "source/empty")), { code: "ENOENT" });
  await assert.rejects(fs.stat(join(f.root, "source/new")), { code: "ENOENT" });
});

test("copy merge is read-only until executed, never overwrites collisions, keep-both retains nested destination", async (t) => {
  const f = await fixture(t);
  await f.write("source/nested/a.txt", "incoming");
  await f.write("target/nested/a.txt", "old");
  await f.dir("source/new-empty");
  const plan = await f.plan();
  assert(plan.merge.every((e) => e.request.op === "copy"));
  assert.equal(await fs.readFile(join(f.root, "target/nested/a.txt"), "utf8"), "old");
  const entry = plan.merge.find((e) => e.destination);
  await assert.rejects(f.run(entry.request), /FILE_EXISTS/);
  await f.run({ ...entry.request, target: "target/nested/a (copy).txt" });
  assert.equal(await fs.readFile(join(f.root, "target/nested/a (copy).txt"), "utf8"), "incoming");
  assert.equal(await fs.readFile(join(f.root, "source/nested/a.txt"), "utf8"), "incoming");
  const version = entry.destination.fingerprint;
  await f.write("target/nested/a.txt", "external edit");
  await assert.rejects(
    f.run({ ...entry.request, targetFingerprint: version }),
    /FILE_TARGET_CHANGED/,
  );
});

test("completed children are recovered after all source ancestors were pruned, check-only never sends", async (t) => {
  const f = await fixture(t);
  await f.write("source/nested/a.txt", "move once");
  await f.dir("target/nested");
  const plan = await f.plan("move"),
    completed = [];
  for (const entry of plan.merge) {
    const request = { ...entry.request, id: randomUUID() };
    await assert.rejects(f.probe({ ...request, checkOnly: true }), /FILE_NOT_STARTED/);
    completed.push([request, await f.run(request)]);
  }
  await assert.rejects(fs.stat(join(f.root, "source")), { code: "ENOENT" });
  for (const [request, result] of completed) {
    assert.deepEqual(await f.probe({ ...request, checkOnly: true }), result);
    assert.deepEqual(await f.probe(request), result);
  }
  assert.equal(await fs.readFile(join(f.root, "target/nested/a.txt"), "utf8"), "move once");
});

test("changed source, replaced target directory and stale merge approval stop before changing bytes", async (t) => {
  const f = await fixture(t);
  await f.write("source/nested/a.txt", "before");
  await f.dir("target/nested");
  const captured = await f.stat("source"),
    target = await f.stat("target");
  const plan = await f.plan();
  await f.write("source/nested/a.txt", "after");
  await assert.rejects(f.run(plan.merge[0].request), /FILE_CHANGED/);
  await assert.rejects(
    f.probe({
      op: "merge-plan",
      path: "source",
      target: "target",
      transfer: "copy",
      fingerprint: captured.fingerprint,
      targetFingerprint: target.fingerprint,
    }),
    /FILE_CHANGED/,
  );
  const fresh = await f.plan();
  await fs.rename(join(f.root, "target/nested"), join(f.root, "old-target"));
  await f.dir("target/nested");
  await assert.rejects(f.run(fresh.merge[0].request), /FILE_CHANGED/);
  await f.write("target/new.txt");
  await assert.rejects(
    f.probe({
      op: "merge-plan",
      path: "source",
      target: "target",
      transfer: "copy",
      fingerprint: (await f.stat("source")).fingerprint,
      targetFingerprint: target.fingerprint,
    }),
    /FILE_TARGET_CHANGED/,
  );
});

test("pruning never removes newly arrived files or a replacement directory", async (t) => {
  const f = await fixture(t);
  await f.dir("source");
  await f.dir("target");
  const plan = await f.plan("move");
  await f.write("source/arrived.txt", "do not delete");
  assert.equal((await f.run(plan.merge[0].request)).retained, true);
  assert.equal(await fs.readFile(join(f.root, "source/arrived.txt"), "utf8"), "do not delete");
  await fs.rename(join(f.root, "source"), join(f.root, "old-source"));
  await f.dir("source");
  await assert.rejects(f.run(plan.merge[0].request), /FILE_CHANGED/);
});

test("uncertain merge leaf has a durable receipt and never repeats copy or deletion", async (t) => {
  const f = await fixture(t);
  await f.write("source/a.txt", "data");
  await f.dir("target");
  const plan = await f.plan("move"),
    request = { ...plan.merge[0].request, id: randomUUID() };
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to.endsWith(request.id + ".json") && JSON.parse(await fs.readFile(from, "utf8")).result)
      throw Error("lost receipt commit");
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.run(request), /FILE_UNKNOWN/);
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  const timestamp = (await fs.stat(join(f.root, "target/a.txt"))).mtimeMs;
  await assert.rejects(f.probe({ ...request, checkOnly: true }), /FILE_UNKNOWN/);
  await assert.rejects(f.run(request), /FILE_UNKNOWN/);
  assert.equal((await fs.stat(join(f.root, "target/a.txt"))).mtimeMs, timestamp);
  await assert.rejects(fs.stat(join(f.root, "source/a.txt")), { code: "ENOENT" });
});

test("file/directory mismatches stay explicit, overlapping roots and symlink/private trees are rejected", async (t) => {
  const f = await fixture(t);
  await f.write("source/file", "file");
  await f.dir("source/folder");
  await f.dir("target/file");
  await f.write("target/folder", "file");
  const plan = await f.plan();
  assert.equal(plan.merge.length, 2);
  for (const entry of plan.merge) await assert.rejects(f.run(entry.request), /FILE_EXISTS/);
  for (const target of ["source", "source/folder"]) {
    await assert.rejects(
      f.probe({ op: "merge-plan", path: "source", target, transfer: "copy" }),
      /FILE_PATH/,
    );
    await assert.rejects(
      f.probe({ op: "merge-plan", path: target, target: "source", transfer: "move" }),
      /FILE_PATH/,
    );
  }
  await f.write("source/.env", "private");
  await assert.rejects(f.plan(), /FILE_PATH/);
});

test("Hub plans and executes nested merges with exact capabilities, and receipt checks do not dispatch", async (t) => {
  const f = await fixture(t),
    hub = await handoffFixture();
  t.after(() => hub.close());
  hub.sessions.config.machines[0].type = "local-linux";
  hub.sessions.config.projects[0].workingDirectory = f.root;
  hub.store.setPreferences({ machineClients: { pc: "web" } });
  await f.write("source/a.txt", "via hub");
  await f.dir("target");
  const base = "/api/projects/project/file-tools";
  const post = (url, payload) =>
    hub.app.inject({ method: "POST", url: base + url, headers: hub.headers, payload });
  const access = (await post("/access", { unlock: true })).json();
  const query = new URLSearchParams({
    op: "merge-plan",
    path: "source",
    target: "target",
    transfer: "move",
    fingerprint: (await f.stat("source")).fingerprint,
    targetFingerprint: (await f.stat("target")).fingerprint,
  });
  const response = await hub.app.inject({ url: base + "?" + query, headers: hub.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().checkout, access.checkout);
  for (const entry of response.json().merge) {
    const body = { ...entry.request, id: randomUUID(), capability: access.capability };
    assert.equal((await post("", { ...body, capability: randomUUID() })).statusCode, 403);
    assert.equal(
      (await post("", { ...body, checkOnly: true })).json().error.code,
      "FILE_NOT_STARTED",
    );
    const done = await post("", body);
    assert.equal(done.statusCode, 200, done.body);
    assert.deepEqual((await post("", { ...body, checkOnly: true })).json(), done.json());
  }
});
