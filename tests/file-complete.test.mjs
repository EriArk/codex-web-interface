import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "../apps/hub/node_modules/fflate/esm/index.mjs";
import { fileToolsProbe as probe } from "../packages/machines/dist/fileToolsProbe.js";
import { handoffFixture } from "./handoff-fixture.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "files-complete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = join(root, "project"),
    receipts = join(root, "receipts");
  await fs.mkdir(project);
  return { root, project, run: (r) => probe(project, r, receipts) };
}
test("ZIP capture retains nested/empty/binary paths and rejects links, private paths, size overflow and duplicate archive names", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.project, "dir/empty"), { recursive: true });
  await fs.writeFile(join(f.project, "dir/файл.bin"), Buffer.from([0, 255, 17]));
  await fs.writeFile(join(f.project, "zero.bin"), "");
  const capture = await f.run({
    op: "archive",
    path: "",
    paths: ["dir", "dir/файл.bin", "zero.bin"],
  });
  assert.equal(capture.size, 3);
  assert.equal(capture.entries.length, 4);
  assert.deepEqual(
    Buffer.from(capture.entries.find((e) => e.path === "dir/файл.bin").data, "base64"),
    Buffer.from([0, 255, 17]),
  );
  assert(capture.entries.some((e) => e.path === "dir/empty/"));
  await fs.symlink(f.root, join(f.project, "link"));
  for (const path of ["../x", ".env", "link", "dir/../zero.bin"])
    await assert.rejects(f.run({ op: "archive", path: "", paths: [path] }), /FILE_PATH/);
  await fs.writeFile(join(f.project, "dir/.env"), "PRIVATE");
  await assert.rejects(f.run({ op: "archive", path: "", paths: ["dir"] }), /FILE_PATH/);
  const large = await fs.open(join(f.project, "large.bin"), "w");
  await large.truncate(33 * 1024 * 1024);
  await large.close();
  await assert.rejects(
    f.run({ op: "archive", path: "", paths: ["large.bin"] }),
    /FILE_ARCHIVE_LARGE/,
  );
  await fs.writeFile(join(f.project, "Case.txt"), "a");
  await fs.writeFile(join(f.project, "case.txt"), "b");
  await assert.rejects(
    f.run({ op: "archive", path: "", paths: ["Case.txt", "case.txt"] }),
    /FILE_PATH/,
  );
});
test("copy and move replace only the approved target fingerprint, reject changed versions, and keep receipts", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.project, "target"));
  await fs.writeFile(join(f.project, "source.bin"), Buffer.from([0, 255]));
  await fs.writeFile(join(f.project, "target/file.bin"), "old");
  const source = await f.run({ op: "stat", path: "source.bin" }),
    old = await f.run({ op: "stat", path: "target/file.bin" });
  const request = {
    op: "copy",
    path: source.path,
    fingerprint: source.fingerprint,
    target: old.path,
    targetFingerprint: old.fingerprint,
    id: randomUUID(),
  };
  await fs.writeFile(join(f.project, old.path), "changed");
  await assert.rejects(f.run(request), /FILE_TARGET_CHANGED/);
  assert.equal(await fs.readFile(join(f.project, old.path), "utf8"), "changed");
  request.targetFingerprint = (await f.run({ op: "stat", path: old.path })).fingerprint;
  const sibling = join(f.project, "target/.codexweb-file-replace-" + request.id);
  await fs.writeFile(sibling, "recovery bytes");
  await assert.rejects(f.run(request), /FILE_EXISTS/);
  assert.equal(await fs.readFile(sibling, "utf8"), "recovery bytes");
  await fs.unlink(sibling);
  const copied = await f.run(request);
  assert.deepEqual(await f.run(request), copied);
  assert.deepEqual(await fs.readFile(join(f.project, old.path)), Buffer.from([0, 255]));
  const move = { ...request, op: "move", id: randomUUID(), targetFingerprint: copied.fingerprint };
  const moved = await f.run(move);
  await assert.rejects(fs.stat(join(f.project, source.path)), { code: "ENOENT" });
  assert.deepEqual(await f.run(move), moved);
  await fs.mkdir(join(f.project, "folder"));
  await assert.rejects(
    f.run({
      ...request,
      id: randomUUID(),
      path: "folder",
      fingerprint: (await f.run({ op: "stat", path: "folder" })).fingerprint,
    }),
    /FILE_REQUEST/,
  );
});
test("private ZIP lifecycle: exact request replay, immutable ready bytes, cancellation, expiry, checkout and cache bounds", async (t) => {
  const f = await fixture(t),
    h = await handoffFixture();
  t.after(() => h.close());
  h.sessions.config.machines[0].type = "local-linux";
  h.sessions.config.projects[0].workingDirectory = f.project;
  h.store.setPreferences({ machineClients: { pc: "web" } });
  await fs.writeFile(join(f.project, "a.txt"), "alpha");
  const grant = (
    await h.app.inject({
      method: "POST",
      url: "/api/projects/project/file-tools/access",
      headers: h.headers,
      payload: { unlock: true },
    })
  ).json();
  const id = randomUUID(),
    url = `/api/projects/project/file-archives/${id}`,
    body = { checkout: grant.checkout, paths: ["a.txt"] };
  const call = (method, suffix = "", payload) =>
    h.app.inject({ method, url: url + suffix, headers: h.headers, payload });
  const first = await call("POST", "", body);
  assert.equal(first.statusCode, 200, first.body);
  const result = first.json();
  assert.equal(result.state, "ready");
  const download = await call("GET", "/content");
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "application/zip");
  assert.equal(Buffer.from(unzipSync(download.rawPayload)["a.txt"]).toString(), "alpha");
  await fs.writeFile(join(f.project, "a.txt"), "new");
  assert.deepEqual((await call("POST", "", body)).json(), result);
  assert.deepEqual((await call("GET", "/content")).rawPayload, download.rawPayload);
  assert.equal((await call("POST", "", { ...body, paths: ["other"] })).statusCode, 409);
  h.sessions.config.projects[0].workingDirectory = f.root;
  assert.equal((await call("GET", "/content")).statusCode, 404);
  h.sessions.config.projects[0].workingDirectory = f.project;
  assert.equal((await call("DELETE")).json().state, "cancelled");
  assert.equal((await call("POST", "", body)).json().state, "cancelled");
  assert.equal((await call("GET", "/content")).statusCode, 404);
  for (let n = 0; n < 6; n++) {
    const response = await h.app.inject({
      method: "POST",
      url: `/api/projects/project/file-archives/${randomUUID()}`,
      headers: h.headers,
      payload: body,
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert(Number(h.store.db.prepare("SELECT count(*) n FROM project_file_archives").get().n) <= 4);
  const cancelId = randomUUID(),
    cancelUrl = `/api/projects/project/file-archives/${cancelId}`;
  const preparing = h.app
    .inject({ method: "POST", url: cancelUrl, headers: h.headers, payload: body })
    .then((value) => value);
  const deadline = Date.now() + 5000;
  while (!h.store.db.prepare("SELECT id FROM project_file_archives WHERE id=?").get(cancelId)) {
    assert(Date.now() < deadline, "archive admission timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    h.store.db.prepare("SELECT state FROM project_file_archives WHERE id=?").get(cancelId).state,
    "building",
  );
  const cancelled = await h.app.inject({ method: "DELETE", url: cancelUrl, headers: h.headers });
  assert.equal(cancelled.json().state, "cancelled");
  assert.equal((await preparing).json().state, "cancelled");
  assert.equal(
    (await h.app.inject({ method: "GET", url: cancelUrl + "/content", headers: h.headers }))
      .statusCode,
    404,
  );
  h.store.db.exec("UPDATE project_file_archives SET updatedAt=0");
  assert.equal((await call("GET")).statusCode, 404);
});
