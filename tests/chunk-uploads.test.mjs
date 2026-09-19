import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ChunkUploads } from "../apps/hub/dist/chunk-uploads.js";
import {
  GPT_FILE_BYTES,
  GPT_IMAGE_BYTES,
  gptFileLimit,
  UPLOAD_CHUNK_BYTES,
} from "../packages/shared/dist/file-limits.js";

const hash = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t, limit = 64 * 1024 ** 2) {
  const root = await mkdtemp(join(tmpdir(), "chunk-upload-")),
    db = new DatabaseSync(":memory:");
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const state = { used: 0, allowed: true, commits: 0, throwAfterCommit: false },
    files = new Map();
  const build = () =>
    new ChunkUploads(
      root,
      { db },
      () => ({ limit, used: state.used }),
      () => {
        if (!state.allowed) throw Error("REVOKED");
      },
      async (id, spec, path) => {
        if (files.has(id)) return files.get(id);
        const bytes = await readFile(path);
        assert.equal(bytes.length, spec.bytes);
        const file = { id, name: spec.name, bytes: bytes.length, sha256: hash(bytes) };
        files.set(id, file);
        state.used += bytes.length;
        state.commits++;
        if (state.throwAfterCommit) {
          state.throwAfterCommit = false;
          throw Error("CRASH_AFTER_ATTACHMENT");
        }
        return file;
      },
    );
  return {
    root,
    db,
    state,
    build,
    uploads: build(),
    spec: { kind: "codex", threadId: randomUUID(), name: "large.zip", bytes: 32 * 1024 ** 2 },
  };
}
test("32 MiB passes in bounded chunks; exact retry, restart and lost completion acknowledgement keep one attachment", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    piece = Buffer.alloc(UPLOAD_CHUNK_BYTES, 43),
    expected = createHash("sha256");
  await f.uploads.begin(id, f.spec);
  await assert.rejects(f.uploads.complete(id), { code: "UPLOAD_INCOMPLETE" });
  for (let offset = 0; offset < f.spec.bytes; offset += piece.length) {
    const s = await f.uploads.append(id, offset, piece);
    assert.equal(s.offset, offset + piece.length);
    expected.update(piece);
    if (offset === 0) {
      assert.equal((await f.uploads.append(id, offset, piece)).offset, piece.length);
      await assert.rejects(f.uploads.append(id, 0, Buffer.alloc(piece.length, 44)), {
        code: "UPLOAD_CHANGED",
      });
      // A crash can leave uncommitted bytes. The next writer discards only that tail.
      await appendFile(join(f.root, id + ".part"), "uncommitted");
      f.uploads = f.build();
    }
  }
  f.state.throwAfterCommit = true;
  await assert.rejects(f.uploads.complete(id), /CRASH_AFTER_ATTACHMENT/);
  f.uploads = f.build();
  const result = await f.uploads.complete(id);
  assert.equal(result.sha256, expected.digest("hex"));
  assert.equal(result.file.sha256, result.sha256);
  assert.deepEqual(await f.uploads.complete(id), result);
  assert.equal(f.state.commits, 1);
  await assert.rejects(stat(join(f.root, id + ".part")), { code: "ENOENT" });
});
test("simultaneous admission reserves quota atomically and exact begin retries are idempotent", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const both = await Promise.all([f.uploads.begin(id, f.spec), f.uploads.begin(id, f.spec)]);
  assert.deepEqual(...both);
  const two = await Promise.allSettled([
    f.uploads.begin(randomUUID(), f.spec),
    f.uploads.begin(randomUUID(), f.spec),
  ]);
  assert.equal(two.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(two.find((x) => x.status === "rejected").reason.code, "ATTACHMENT_STORAGE_FULL");
  await assert.rejects(f.uploads.begin(id, { ...f.spec, name: "different.zip" }), {
    code: "UPLOAD_CHANGED",
  });
});
test("private staging rechecks access, byte limits and target before every write", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.uploads.begin(id, { ...f.spec, bytes: 10 });
  await assert.rejects(f.uploads.append(id, 0, Buffer.alloc(11)), { code: "UPLOAD_CHUNK" });
  await assert.rejects(f.uploads.append(id, 2, Buffer.alloc(2)), { code: "UPLOAD_OFFSET" });
  f.state.allowed = false;
  await assert.rejects(f.uploads.append(id, 0, Buffer.alloc(10)), /REVOKED/);
  assert.throws(() => f.uploads.state(id), /REVOKED/);
  await assert.rejects(f.uploads.complete(id), /REVOKED/);
  assert.equal(f.state.commits, 0);
});
test("ChatGPT enforces 512 MiB documents / 20 MiB images; approximate spreadsheet size is native-authoritative", async (t) => {
  const f = await fixture(t, 2 * 1024 ** 3);
  assert.equal(gptFileLimit("book.pdf"), GPT_FILE_BYTES);
  assert.equal(gptFileLimit("photo.PNG"), GPT_IMAGE_BYTES);
  assert.equal(gptFileLimit("rows.csv"), GPT_FILE_BYTES);
  for (const [name, bytes] of [
    ["photo.png", GPT_IMAGE_BYTES + 1],
    ["book.pdf", GPT_FILE_BYTES + 1],
  ]) {
    await assert.rejects(f.uploads.begin(randomUUID(), { kind: "gpt", name, bytes }), {
      code: "FILE_TOO_LARGE",
    });
  }
  await f.uploads.begin(randomUUID(), { kind: "gpt", name: "book.pdf", bytes: GPT_FILE_BYTES });
  await f.uploads.begin(randomUUID(), { kind: "gpt", name: "photo.png", bytes: GPT_IMAGE_BYTES });
});
