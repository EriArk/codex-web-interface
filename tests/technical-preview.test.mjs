import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { convertTechnical } from "../apps/hub/dist/technicalConvert.js";
import { isFileSource } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const cube = await readFile(new URL("./fixtures/technical/cube.stp", import.meta.url));
test("technical sources cannot name arbitrary URLs, paths, queries or other API actions", () => {
  for (const value of [
    "https://evil.test/a.step",
    "file:///etc/passwd",
    "/api/auth/session",
    "/api/artifacts/a?url=/etc/passwd",
    "/api/projects/p/files/content?path=x&evil=1",
    "/api/artifacts/a#x",
  ])
    assert.equal(isFileSource(value), false);
  assert(isFileSource("/api/projects/p/files/content?path=part.step&version=index"));
});
test("STEP uses a disposable bounded converter, preserves coordinates and supports cancellation", async () => {
  const doc = JSON.parse(await convertTechnical(cube, "step", new AbortController().signal));
  assert.equal(doc.unit, "mm");
  assert.equal(doc.triangles, 12);
  assert(doc.meshes.length > 0);
  const p = doc.meshes.flatMap((m) => m.positions);
  assert(p.every(Number.isFinite));
  await assert.rejects(
    convertTechnical(Buffer.from("broken"), "step", new AbortController().signal),
  );
  const c = new AbortController();
  const iges = await readFile(new URL("./fixtures/technical/cube.igs", import.meta.url));
  const imported = JSON.parse(await convertTechnical(iges, "iges", new AbortController().signal));
  assert.equal(imported.triangles, 12);
  c.abort();
  await assert.rejects(convertTechnical(cube, "step", c.signal));
});
test("conversion requires source auth and CSRF, exact bytes, revalidates warm cache and never modifies originals", async () => {
  const f = await handoffFixture();
  try {
    const item = await f.sessions.attachments.put(f.thread.id, "cube.step", cube);
    const payload = {
      source: { kind: "file", download: "/api/attachments/" + item.id },
      format: "step",
      sha256: createHash("sha256").update(cube).digest("hex"),
    };
    const call = (headers = f.headers, body = payload) =>
      f.app.inject({ method: "POST", url: "/api/previews/technical", headers, payload: body });
    assert.equal((await call({})).statusCode, 401);
    assert.equal(
      (await call({ cookie: f.headers.cookie, origin: f.headers.origin })).statusCode,
      403,
    );
    assert.equal(
      (
        await call(f.headers, {
          ...payload,
          source: { kind: "file", download: "http://127.0.0.1/private" },
        })
      ).statusCode,
      400,
    );
    const first = await call();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().triangles, 12);
    assert.equal(first.headers["cache-control"], "private, no-store");
    assert.equal((await call()).body, first.body);
    const path = join(f.sessions.attachments.root, item.id + ".bin");
    assert.deepEqual(await readFile(path), cube);
    await writeFile(path, Buffer.concat([cube, Buffer.from("\n")]));
    assert.equal((await call()).statusCode, 409, "warm cache cannot replace changed bytes");
    f.store.db.prepare("DELETE FROM attachments WHERE id=?").run(item.id);
    assert.equal((await call()).statusCode, 404, "warm cache cannot bypass removed source");
  } finally {
    await f.close();
  }
});
