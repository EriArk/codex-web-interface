import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileToolsProbe as probe } from "../packages/machines/dist/fileToolsProbe.js";
import { handoffFixture } from "./handoff-fixture.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(join(os.tmpdir(), "file-tools-")),
    home = os.homedir;
  os.homedir = () => root;
  syncBuiltinESMExports();
  const project = join(root, "project");
  await fs.mkdir(project);
  t.after(async () => {
    os.homedir = home;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  return project;
}
const mutate = (root, request) => probe(root, { id: randomUUID(), ...request });

test("UTF8 save preserves BOM, CRLF, permissions, complete bytes and completed receipt", async (t) => {
  const root = await fixture(t),
    file = join(root, "code.ts");
  await fs.writeFile(file, "\ufeffconst n = 1;\r\n");
  await fs.chmod(file, 0o664);
  const s = await probe(root, { op: "read", path: "code.ts" }),
    request = {
      op: "save",
      path: s.path,
      fingerprint: s.fingerprint,
      bom: s.bom,
      text: "const n = 2;\r\n",
      id: randomUUID(),
    };
  const result = await probe(root, request);
  assert.deepEqual(await probe(root, request), result);
  assert.equal(await fs.readFile(file, "utf8"), "\ufeffconst n = 2;\r\n");
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o664);
  await assert.rejects(probe(root, { ...request, text: "different" }), /FILE_REQUEST/);
});
test("move and delete recover completed receipts after source disappears", async (t) => {
  const root = await fixture(t);
  for (const op of ["move", "delete"]) {
    await fs.writeFile(join(root, op + ".txt"), "source");
    const s = await probe(root, { op: "stat", path: op + ".txt" });
    const request = {
      op,
      path: s.path,
      fingerprint: s.fingerprint,
      id: randomUUID(),
      ...(op === "move" ? { target: "moved.txt" } : {}),
    };
    const result = await probe(root, request);
    assert.deepEqual(await probe(root, request), result);
    await assert.rejects(fs.stat(join(root, s.path)), { code: "ENOENT" });
  }
});
test("directory copies and moves preserve bytes and refuse collisions", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(join(root, "src"));
  await fs.writeFile(join(root, "src/a.txt"), "hello");
  const s = await probe(root, { op: "stat", path: "src" });
  await mutate(root, { op: "copy", path: "src", target: "copy", fingerprint: s.fingerprint });
  assert.equal(await fs.readFile(join(root, "copy/a.txt"), "utf8"), "hello");
  await assert.rejects(
    mutate(root, { op: "move", path: "src", target: "copy", fingerprint: s.fingerprint }),
    /FILE_EXISTS/,
  );
  await mutate(root, { op: "move", path: "src", target: "moved", fingerprint: s.fingerprint });
  assert.equal(await fs.readFile(join(root, "moved/a.txt"), "utf8"), "hello");
  await assert.rejects(fs.stat(join(root, "src")), { code: "ENOENT" });
});
test("destination race cannot overwrite external bytes or remove source", async (t) => {
  const root = await fixture(t),
    from = join(root, "source.txt"),
    to = join(root, "target.txt");
  await fs.writeFile(from, "source");
  const s = await probe(root, { op: "stat", path: "source.txt" }),
    copy = fs.copyFile;
  fs.copyFile = async (a, b, flags) => {
    if (a === from && b === to) await fs.writeFile(to, "external", { flag: "wx" });
    return copy(a, b, flags);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.copyFile = copy;
    syncBuiltinESMExports();
  });
  const request = {
    op: "move",
    path: s.path,
    target: "target.txt",
    fingerprint: s.fingerprint,
    id: randomUUID(),
  };
  await assert.rejects(probe(root, request), /FILE_UNKNOWN/);
  assert.equal(await fs.readFile(to, "utf8"), "external");
  assert.equal(await fs.readFile(from, "utf8"), "source");
  await assert.rejects(probe(root, request), /FILE_UNKNOWN/);
});
test("stale saves, binary, oversized files and unsafe paths are refused", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "a.txt"), "old");
  const s = await probe(root, { op: "read", path: "a.txt" });
  await fs.writeFile(join(root, "a.txt"), "external");
  await assert.rejects(
    mutate(root, { op: "save", path: "a.txt", fingerprint: s.fingerprint, text: "mine" }),
    /FILE_CHANGED/,
  );
  assert.equal(await fs.readFile(join(root, "a.txt"), "utf8"), "external");
  for (const path of [
    "../a.txt",
    "/a.txt",
    "a.txt:stream",
    ".git/config",
    ".env",
    "NUL.txt",
    "a./b",
    "a\\b",
  ])
    await assert.rejects(probe(root, { op: "read", path }), /FILE_PATH/);
  await fs.writeFile(join(root, "binary.txt"), Buffer.from([0, 1]));
  await assert.rejects(probe(root, { op: "read", path: "binary.txt" }), /FILE_ENCODING/);
  await fs.writeFile(join(root, "huge.txt"), "");
  await fs.truncate(join(root, "huge.txt"), 2 * 1024 * 1024 + 1);
  await assert.rejects(probe(root, { op: "read", path: "huge.txt" }), /FILE_TEXT_SIZE/);
  await fs.truncate(join(root, "huge.txt"), 128 * 1024 * 1024 + 1);
  await assert.rejects(probe(root, { op: "stat", path: "huge.txt" }), /FILE_TREE_LARGE/);
  await fs.symlink(join(root, "a.txt"), join(root, "link.txt"));
  await assert.rejects(probe(root, { op: "read", path: "link.txt" }), /FILE_PATH/);
});
test("lost save receipt acknowledgement reconciles exact saved content without another write", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "a.txt"), "before");
  const s = await probe(root, { op: "read", path: "a.txt" }),
    rename = fs.rename;
  fs.rename = async (a, b) => {
    if (b.endsWith(".json")) throw Error("connection lost");
    return rename(a, b);
  };
  syncBuiltinESMExports();
  const request = {
    op: "save",
    path: "a.txt",
    fingerprint: s.fingerprint,
    text: "after",
    id: randomUUID(),
  };
  try {
    await assert.rejects(probe(root, request), /FILE_UNKNOWN/);
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  const stat = await fs.stat(join(root, "a.txt"));
  assert.equal((await probe(root, request)).text, "after");
  assert.equal((await fs.stat(join(root, "a.txt"))).mtimeMs, stat.mtimeMs);
});
test("source changed during delete capture is retained and restored, never recursively erased", async (t) => {
  const root = await fixture(t),
    file = join(root, "changed.txt");
  await fs.writeFile(file, "before");
  const s = await probe(root, { op: "stat", path: "changed.txt" }),
    rename = fs.rename;
  fs.rename = async (a, b) => {
    if (a === file) await fs.writeFile(file, "external edit");
    return rename(a, b);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      mutate(root, { op: "delete", path: s.path, fingerprint: s.fingerprint }),
      /FILE_UNKNOWN/,
    );
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  assert.equal(await fs.readFile(file, "utf8"), "external edit");
});
test("Hub write grants bind session, project, root, relock and active work", async (t) => {
  const root = await fixture(t),
    f = await handoffFixture();
  t.after(() => f.close());
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  f.store.setPreferences({ machineClients: { pc: "web" } });
  const post = (suffix, body, headers = f.headers) =>
    f.app.inject({
      method: "POST",
      url: "/api/projects/project/file-tools" + suffix,
      headers,
      payload: body,
    });
  const unlocked = await post("/access", { unlock: true });
  assert.equal(unlocked.statusCode, 200, unlocked.body);
  const { capability } = unlocked.json();
  const body = { op: "create", path: "new.txt", text: "created", id: randomUUID(), capability };
  assert.equal((await post("", { ...body, capability: randomUUID() })).statusCode, 403);
  assert.equal((await post("", body)).statusCode, 200);
  assert((await fs.readdir(join(f.sessions.config.hub.resultsPath, "file-operations"))).length > 0);
  await assert.rejects(fs.stat(join(root, "..", ".codex-web")), { code: "ENOENT" });
  f.store.db.prepare("UPDATE threads SET status='running' WHERE id=?").run(f.thread.id);
  assert.equal((await post("", { ...body, id: randomUUID(), path: "busy.txt" })).statusCode, 409);
  f.store.db.prepare("UPDATE threads SET status='idle' WHERE id=?").run(f.thread.id);
  f.sessions.config.projects[0].workingDirectory = root + "/different";
  assert.equal((await post("", body)).statusCode, 403);
  f.sessions.config.projects[0].workingDirectory = root;
  const login = await f.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: f.headers.origin },
    payload: { password: f.password },
  });
  const cookie = login.headers["set-cookie"].split(";")[0],
    session = await f.app.inject({ url: "/api/auth/session", headers: { cookie } });
  assert.equal(
    (
      await post("", body, {
        origin: f.headers.origin,
        cookie,
        "x-csrf-token": session.json().csrf,
      })
    ).statusCode,
    403,
  );
  assert.equal((await post("/access", { unlock: false, capability })).statusCode, 200);
  assert.equal((await post("", body)).statusCode, 403);
  assert.equal(await fs.readFile(join(root, "new.txt"), "utf8"), "created");
});
