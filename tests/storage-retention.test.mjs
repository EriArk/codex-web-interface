import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { GptService } from "../apps/hub/dist/gpt.js";
import { restoreSnapshot, verifySnapshot } from "../apps/hub/dist/maintenance.js";
import { compactStorage, storageReport } from "../apps/hub/dist/storage.js";
import { Store } from "../apps/hub/dist/store.js";
import { retainedFileStore } from "../ops/gpt/retained-files.mjs";
import { configSchema } from "../packages/shared/dist/index.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "storage-test-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://qa.example",
      databasePath: join(root, "hub.db"),
      resultsPath: join(root, "results"),
    },
    auth: {},
    machines: [],
    projects: [],
  });
  await mkdir(config.hub.resultsPath, { mode: 0o700 });
  return { root, config, store: new Store(config.hub.databasePath) };
}
test("compaction keeps full replies, results, receipts and staged uploads, and backs up retired orphans", async () => {
  const { root, config, store } = await fixture(),
    now = Date.now(),
    old = new Date(now - 40 * 86400000);
  try {
    const thread = store.createThread("p", "native", "History"),
      turn = "turn";
    store.append(thread.id, "user.message", { id: "u", text: "Question" }, turn);
    for (let n = 0; n < 5; n++)
      store.append(thread.id, "assistant.delta", { id: "a", text: "part" }, turn);
    store.append(
      thread.id,
      "assistant.completed",
      { id: "a", text: "Complete reply", phase: "final_answer" },
      turn,
    );
    store.append(thread.id, "turn.completed", { status: "completed" }, turn);
    store.setStatus(thread.id, "completed", null);
    // A delta without a matching complete item is never eligible.
    store.append(
      thread.id,
      "assistant.delta",
      { id: "partial", text: "Preserve me" },
      "incomplete",
    );
    store.db.prepare("UPDATE events SET createdAt=?").run(old.toISOString());
    const artifact = new Artifacts(config.hub.resultsPath, store).putPng(thread.id, png);
    store.result(thread.id, turn, "image", "image", "Saved", { url: artifact.url });
    const upload = randomUUID();
    await mkdir(join(config.hub.resultsPath, "uploads", "staged"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(config.hub.resultsPath, "uploads", upload + ".bin"), "kept", {
      mode: 0o600,
    });
    await writeFile(
      join(config.hub.resultsPath, "uploads", "staged", "native-reference"),
      "native history still needs this",
      { mode: 0o600 },
    );
    store.db
      .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)")
      .run(upload, thread.id, "file.txt", "text/plain", 4, 0, "u", old.toISOString());
    let actions = 0;
    await store.once("command", "key", {}, async () => {
      actions++;
      return { receipt: "kept" };
    });
    const orphan = randomUUID() + ".png";
    await writeFile(join(config.hub.resultsPath, orphan), "old orphan", { mode: 0o600 });
    await utimes(join(config.hub.resultsPath, orphan), old, old);
    const before = store.history(thread.id),
      report = await storageReport(config, store.db, now);
    assert.equal(report.transientEvents, 5);
    assert.equal(report.orphanFiles, 1);
    assert.equal(report.missingFiles, 0);
    const result = await compactStorage(config, { backupDirectory: join(root, "backups"), now });
    assert.equal(result.removedEvents, 5);
    assert.equal(result.removedFiles, 1);
    assert.deepEqual(store.history(thread.id), before);
    assert(
      store
        .events(thread.id)
        .some(
          (event) =>
            event.type === "assistant.completed" && event.payload.text === "Complete reply",
        ),
    );
    assert(store.events(thread.id).some((event) => event.payload.id === "partial"));
    assert.equal(
      await readFile(join(config.hub.resultsPath, "uploads", upload + ".bin"), "utf8"),
      "kept",
    );
    assert.equal(store.results(thread.id).items.length, 1);
    assert.deepEqual(
      await store.once("command", "key", {}, async () => {
        actions++;
        return null;
      }),
      { receipt: "kept" },
    );
    assert.equal(actions, 1);
    await verifySnapshot(result.snapshot);
    const restored = join(root, "restored");
    await restoreSnapshot(result.snapshot, restored);
    assert.equal(await readFile(join(restored, "results", orphan), "utf8"), "old orphan");
    assert.equal(
      await readFile(join(restored, "results", "uploads", "staged", "native-reference"), "utf8"),
      "native history still needs this",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("active and unknown outcomes block sweeping; referenced missing bytes and symlinks require review", async () => {
  const { root, config, store } = await fixture();
  try {
    const thread = store.createThread("p", "native", "Active");
    store.setStatus(thread.id, "running", "t");
    await assert.rejects(compactStorage(config, { backupDirectory: join(root, "backups") }), {
      code: "STORAGE_BUSY",
    });
    store.setStatus(thread.id, "idle", null);
    store.db
      .prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)")
      .run("send", "key", "digest", "unknown", null, "2020-01-01");
    await assert.rejects(compactStorage(config, { backupDirectory: join(root, "backups") }), {
      code: "STORAGE_BUSY",
    });
    store.db.prepare("UPDATE commands SET state='complete',response='{}'").run();
    const id = randomUUID();
    store.db
      .prepare("INSERT INTO gpt_jobs VALUES(?,?,?,?,?,?,?,'unknown','',?,?,?,'',NULL,1)")
      .run(id, "fingerprint", null, "Question", "[]", "Latest", "2", "[]", 1, 1);
    await assert.rejects(compactStorage(config, { backupDirectory: join(root, "backups") }), {
      code: "STORAGE_BUSY",
    });
    assert.equal(
      store.db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(id).status,
      "unknown",
    );
    store.db.prepare("UPDATE gpt_jobs SET status='cancelled' WHERE id=?").run(id);
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "owner-file"), "Keep");
    await symlink(outside, join(config.hub.resultsPath, "gpt"));
    assert.equal((await storageReport(config, store.db)).partial, true);
    await assert.rejects(compactStorage(config, { backupDirectory: join(root, "backups") }), {
      code: "STORAGE_NEEDS_REVIEW",
    });
    assert.equal(await readFile(join(outside, "owner-file"), "utf8"), "Keep");
    await rm(join(config.hub.resultsPath, "gpt"));
    store.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
      .run(randomUUID(), thread.id, "image/png", 10, new Date().toISOString());
    assert.equal((await storageReport(config, store.db)).missingFiles, 1);
    await assert.rejects(compactStorage(config, { backupDirectory: join(root, "backups") }), {
      code: "STORAGE_NEEDS_REVIEW",
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("artifact quota rejects only new bytes and keeps prior images readable", async () => {
  const { root, config, store } = await fixture();
  try {
    const thread = store.createThread("p", "native", "Images"),
      bytes = Buffer.from(png, "base64").length;
    const artifacts = new Artifacts(config.hub.resultsPath, store, bytes);
    const saved = artifacts.putPng(thread.id, png);
    assert.throws(() => artifacts.putPng(thread.id, png), { code: "ARTIFACT_STORAGE_FULL" });
    assert.equal(artifacts.get(saved.artifactId).data.toString("base64"), png);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("GPT adapter retains more than ten referenced artifacts and serializes storage quotas", async () => {
  class Files {
    ready = Promise.resolve();
    index = { files: {}, artifacts: {} };
    async putUpload(input) {
      const id = randomUUID();
      await new Promise((r) => setTimeout(r, 5));
      this.index.files[id] = { size: Buffer.byteLength(input.content) };
      return { id };
    }
    async putArtifact(input) {
      const id = input.artifactId ?? randomUUID();
      this.index.artifacts[id] = { size: Buffer.byteLength(input.content) };
      return { id };
    }
    async remove(id) {
      await new Promise((r) => setTimeout(r, 5));
      delete this.index.files[id];
      return true;
    }
    async pruneArtifacts() {
      this.index.artifacts = {};
      return ["lost"];
    }
  }
  const Retained = retainedFileStore(Files, { uploadBytes: 4, artifactBytes: 1000 }),
    files = new Retained();
  for (let n = 0; n < 15; n++) await files.putArtifact({ content: "saved" });
  assert.deepEqual(await files.pruneArtifacts(), []);
  assert.equal(Object.keys(files.index.artifacts).length, 15);
  const uploads = await Promise.allSettled([
    files.putUpload({ content: "1234" }),
    files.putUpload({ content: "1234" }),
  ]);
  assert.equal(uploads.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(uploads.filter((r) => r.status === "rejected").length, 1);
  // A completed transport retirement and the next upload must serialize index writes.
  const first = uploads.find((r) => r.status === "fulfilled").value;
  await Promise.all([files.remove(first.id), files.putUpload({ content: "next" })]);
  assert.equal(Object.keys(files.index.files).length, 1);
});

test("GPT transport retirement retries after restart without replaying prompts or retiring uncertain jobs", async () => {
  const { root, config, store } = await fixture();
  let service = new GptService(config, store);
  const completed = randomUUID(),
    uncertain = randomUUID(),
    doneFile = "file_" + "a".repeat(20),
    unknownFile = "file_" + "b".repeat(20);
  try {
    for (const [id, status, file] of [
      [completed, "completed", doneFile],
      [uncertain, "unknown", unknownFile],
    ]) {
      store.db
        .prepare(
          "INSERT INTO gpt_jobs(id,fingerprint,text,files,model,effort,status,answer,assets,createdAt,updatedAt,error,submitted) VALUES(?,?,'Saved','[]','model','0',?,'Answer','[]',1,1,'',1)",
        )
        .run(id, id, status);
      store.db.prepare("INSERT INTO gpt_staged_uploads VALUES(?,?,1)").run(id, file);
    }
    service.available = () => true;
    service.json = async (path, body) => {
      assert.equal(path, "/uploads/release");
      assert.deepEqual(body.ids, [doneFile]);
      throw Error("Bridge is busy");
    };
    await service.releaseCompletedUploads();
    assert.equal(store.db.prepare("SELECT count(*) n FROM gpt_staged_uploads").get().n, 2);
    await service.close();
    service = new GptService(config, store);
    service.available = () => true;
    const requests = [];
    service.json = async (path, body) => {
      requests.push({ path, body });
      return { ok: true };
    };
    await service.releaseCompletedUploads();
    assert.deepEqual(requests, [{ path: "/uploads/release", body: { ids: [doneFile] } }]);
    assert.deepEqual(
      store.db
        .prepare("SELECT fileId FROM gpt_staged_uploads")
        .all()
        .map((r) => r.fileId),
      [unknownFile],
    );
    assert.equal(
      store.db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(uncertain).status,
      "unknown",
    );
    assert.equal(
      store.db.prepare("SELECT text FROM gpt_jobs WHERE id=?").get(completed).text,
      "Saved",
    );
  } finally {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
