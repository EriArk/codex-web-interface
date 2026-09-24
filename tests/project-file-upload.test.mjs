import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileToolsProbe } from "../packages/machines/dist/fileToolsProbe.js";
import { UPLOAD_CHUNK_BYTES } from "../packages/shared/dist/file-limits.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "project-file-upload-")),
    project = join(root, "project"),
    receipts = join(root, "receipts");
  await fs.mkdir(project);
  await fs.mkdir(join(project, "folder"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const probe = (request, upload) => fileToolsProbe(project, request, receipts, upload);
  const stage = async (bytes) => {
    const path = join(root, randomUUID());
    await fs.writeFile(path, bytes);
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  return { root, project, probe, stage };
}
test("binary import is exclusive, replacement requires exact chosen version, and empty files work", async (t) => {
  const f = await fixture(t),
    content = Buffer.from([0, 255, 17, 18]),
    request = { op: "import", path: "folder/model.bin", id: randomUUID() };
  const first = await f.probe(request, await f.stage(content));
  assert.equal(first.size, 4);
  assert.deepEqual(await fs.readFile(join(f.project, request.path)), content);
  await assert.rejects(
    f.probe({ ...request, id: randomUUID() }, await f.stage(Buffer.from("new"))),
    /FILE_EXISTS/,
  );
  const next = { ...request, id: randomUUID(), fingerprint: first.fingerprint };
  await fs.writeFile(join(f.project, request.path), "external");
  await assert.rejects(f.probe(next, await f.stage(Buffer.from("replacement"))), /FILE_CHANGED/);
  assert.equal(await fs.readFile(join(f.project, request.path), "utf8"), "external");
  const latest = await f.probe({ op: "stat", path: request.path });
  await f.probe(
    { ...next, fingerprint: latest.fingerprint },
    await f.stage(Buffer.from("replacement")),
  );
  assert.equal(await fs.readFile(join(f.project, request.path), "utf8"), "replacement");
  await f.probe(
    { op: "import", path: "empty.bin", id: randomUUID() },
    await f.stage(Buffer.alloc(0)),
  );
  assert.equal((await fs.stat(join(f.project, "empty.bin"))).size, 0);
});
test("hash mismatch, unsafe paths, symlinks and stale replacement preflights do not change targets", async (t) => {
  const f = await fixture(t);
  for (const path of ["../escape.bin", ".env", "folder/NUL.bin", "folder/a:stream", "/outside.bin"])
    await assert.rejects(f.probe({ op: "import-check", path }), /FILE_PATH/);
  await fs.symlink(f.root, join(f.project, "link"));
  await assert.rejects(f.probe({ op: "import-check", path: "link/escape.bin" }), /FILE_PATH/);
  const source = await f.stage(Buffer.from("valid"));
  await assert.rejects(
    f.probe(
      { op: "import", path: "new.bin", id: randomUUID() },
      { ...source, sha256: "0".repeat(64) },
    ),
    /FILE_INTEGRITY/,
  );
  await assert.rejects(fs.stat(join(f.project, "new.bin")), { code: "ENOENT" });
  await fs.writeFile(join(f.project, "old.bin"), "old");
  await assert.rejects(f.probe({ op: "import-check", path: "old.bin" }), /FILE_EXISTS/);
  await assert.rejects(
    f.probe({ op: "import-check", path: "old.bin", fingerprint: "0".repeat(64) }),
    /FILE_CHANGED/,
  );
});
test("lost import receipt confirmation reconciles exact bytes without another write", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("snapshot"),
    request = { op: "import", path: "new.bin", id: randomUUID() },
    rename = fs.rename;
  fs.rename = async (a, b) => {
    if (b.endsWith(".json")) throw Error("lost completion");
    return rename(a, b);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.probe(request, await f.stage(bytes)), /FILE_UNKNOWN/);
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  const before = await fs.stat(join(f.project, request.path));
  assert.equal((await f.probe(request, await f.stage(bytes))).size, bytes.length);
  assert.equal((await fs.stat(join(f.project, request.path))).mtimeMs, before.mtimeMs);
  await assert.rejects(f.probe(request, await f.stage(Buffer.from("different"))), /FILE_REQUEST/);
});
test("Hub project chunks, reselected prefix, cancel, exact completion, replacement and grant boundaries", async (t) => {
  const f = await fixture(t),
    h = await handoffFixture();
  t.after(() => h.close());
  h.sessions.config.machines[0].type = "local-linux";
  h.sessions.config.projects[0].workingDirectory = f.project;
  h.store.setPreferences({ machineClients: { pc: "web" } });
  const access = await h.app.inject({
    method: "POST",
    url: "/api/projects/project/file-tools/access",
    headers: h.headers,
    payload: { unlock: true },
  });
  assert.equal(access.statusCode, 200, access.body);
  const { capability, checkout } = access.json();
  const headers = { ...h.headers, "x-file-capability": capability },
    id = randomUUID(),
    bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES + 9, 27);
  const call = (method, suffix = "", payload, custom = headers) =>
    h.app.inject({
      method,
      url: `/api/projects/project/file-uploads/${id}${suffix}`,
      headers: custom,
      payload,
    });
  const spec = { name: "large.bin", bytes: bytes.length, folder: "folder", checkout };
  assert.equal(
    (await call("POST", "", spec, { ...headers, "x-file-capability": randomUUID() })).statusCode,
    403,
  );
  assert.equal((await call("POST", "", spec)).statusCode, 200);
  assert.equal((await call("POST", "", { ...spec, name: "other.bin" })).statusCode, 409);
  const chunkHeaders = { ...headers, "content-type": "application/octet-stream" };
  assert.equal(
    (await call("PUT", "?offset=0", bytes.subarray(0, UPLOAD_CHUNK_BYTES), chunkHeaders))
      .statusCode,
    200,
  );
  assert.equal(
    (await call("PUT", "?offset=0", Buffer.alloc(UPLOAD_CHUNK_BYTES, 99), chunkHeaders)).json()
      .error.code,
    "UPLOAD_CHANGED",
  );
  assert.equal(
    (await call("PUT", "?offset=0", bytes.subarray(0, UPLOAD_CHUNK_BYTES), chunkHeaders))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "PUT",
        `?offset=${UPLOAD_CHUNK_BYTES}`,
        bytes.subarray(UPLOAD_CHUNK_BYTES),
        chunkHeaders,
      )
    ).statusCode,
    200,
  );
  h.store.db.prepare("UPDATE threads SET status='running' WHERE id=?").run(h.thread.id);
  assert.equal((await call("POST", "/complete", {})).statusCode, 200);
  h.store.db.prepare("UPDATE threads SET status='idle' WHERE id=?").run(h.thread.id);
  const result = await call("POST", "/complete", {});
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().sha256, hash(bytes));
  assert.deepEqual(await fs.readFile(join(f.project, "folder/large.bin")), bytes);
  assert.deepEqual((await call("POST", "/complete", {})).json(), result.json());
  assert.deepEqual((await call("POST", "", spec)).json().result, result.json());
  h.sessions.config.projects[0].workingDirectory = f.root;
  assert.equal((await call("GET")).statusCode, 403);
  h.sessions.config.projects[0].workingDirectory = f.project;
  const other = randomUUID(),
    cancelPath = `/api/projects/project/file-uploads/${other}`;
  assert.equal(
    (
      await h.app.inject({
        method: "POST",
        url: cancelPath,
        headers,
        payload: { ...spec, name: "cancel.bin" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await h.app.inject({ method: "DELETE", url: cancelPath, headers })).json().result.cancelled,
    true,
  );
  assert.equal(
    (
      await h.app.inject({ method: "POST", url: cancelPath + "/complete", headers, payload: {} })
    ).json().cancelled,
    true,
  );
  await assert.rejects(fs.stat(join(f.project, "folder/cancel.bin")), { code: "ENOENT" });
  const replacePath = `/api/projects/project/file-uploads/${randomUUID()}`;
  const replacement = { ...spec, bytes: 0, replace: result.json().file.fingerprint };
  assert.equal(
    (await h.app.inject({ method: "POST", url: replacePath, headers, payload: replacement }))
      .statusCode,
    200,
  );
  await fs.writeFile(join(f.project, "folder/large.bin"), "changed after approval");
  const changed = await h.app.inject({
    method: "POST",
    url: replacePath + "/complete",
    headers,
    payload: {},
  });
  assert.equal(changed.json().error.code, "FILE_CHANGED");
  assert.equal(
    await fs.readFile(join(f.project, "folder/large.bin"), "utf8"),
    "changed after approval",
  );
  await h.app.inject({
    method: "POST",
    url: "/api/projects/project/file-tools/access",
    headers: h.headers,
    payload: { unlock: false, capability },
  });
  assert.equal((await call("GET")).statusCode, 403);
});
