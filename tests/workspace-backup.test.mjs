import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { Library } from "../apps/hub/dist/library.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../apps/hub/dist/maintenance.js";
import { Previews } from "../apps/hub/dist/previews.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";

function fixtureConfig(root) {
  return configSchema.parse({
    hub: {
      publicBaseUrl: "http://127.0.0.1:8981",
      secureCookies: false,
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "fixture" },
    machines: [],
    projects: [],
  });
}
test("workspace backup restores GPT bytes, saved HTML and pins without replaying old queued jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workspace-backup-")),
    config = fixtureConfig(root);
  const source = new Store(config.hub.databasePath),
    gpt = new GptService(config, source);
  let restored, restoredGpt;
  try {
    const bytes = Buffer.from("Uploaded UTF-8: пример"),
      upload = await gpt.put("example.txt", bytes);
    const thread = source.createThread("p", "native-id", "History");
    new Library(source, "codex").save("thread", thread.id, { name: "History", pinned: true });
    const path = join(root, "design.html"),
      original = "<button>Original interactive design</button>";
    await writeFile(path, original);
    const previews = new Previews(join(config.hub.resultsPath, "previews"), source, () => ({
      machine: { type: "local-linux" },
      root,
    }));
    previews.observe(thread, null, {
      id: "saved",
      type: "fileChange",
      changes: [{ path, kind: { type: "add" } }],
    });
    const cached = source.db.prepare("SELECT id FROM html_previews").get().id;
    await previews.document(cached);
    previews.observe(thread, null, {
      id: "unopened",
      type: "fileChange",
      changes: [{ path: join(root, "unopened.html"), kind: { type: "add" } }],
    });
    const states = [
      "queued",
      "preparing",
      "running",
      "unknown",
      "completed",
      "cancelled",
      "failed",
    ];
    for (const status of states) {
      source.db
        .prepare(
          "INSERT INTO gpt_jobs(id,fingerprint,nativeId,text,files,model,effort,status,answer,assets,createdAt,updatedAt,error,submitted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          "fixture-" + status,
          "native-" + status,
          "Keep this request",
          JSON.stringify([upload.id]),
          "fixture",
          "0",
          status,
          "Saved answer",
          "[]",
          1,
          1,
          "",
          Number(status === "running"),
        );
    }
    // Neither unreferenced files nor a browser profile placed beside uploads are sweep targets.
    await mkdir(join(config.hub.resultsPath, "gpt", "profile"), { mode: 0o700 });
    await writeFile(
      join(config.hub.resultsPath, "gpt", "profile", "fixture-secret"),
      "not an upload",
    );
    const snapshot = await createSnapshot(config, join(root, "backups"));
    const manifest = await verifySnapshot(snapshot);
    assert.equal(manifest.format, 2);
    assert.deepEqual(manifest.cachedPreviews, [cached]);
    assert(manifest.files.some((f) => f.path === "results/gpt/" + upload.id));
    assert(manifest.files.some((f) => f.path === "results/previews/" + cached + ".html"));
    assert(!manifest.files.some((f) => f.path.includes("profile") || f.path.includes("unopened")));
    // Restored preview must use captured bytes even when the original machine is unavailable.
    await writeFile(path, "Changed after snapshot");
    const target = join(root, "restore");
    await restoreSnapshot(snapshot, target);
    restored = new Store(join(target, "app.db"));
    restoredGpt = new GptService(
      {
        ...config,
        hub: {
          ...config.hub,
          databasePath: join(target, "app.db"),
          resultsPath: join(target, "results"),
        },
      },
      restored,
    );
    assert.deepEqual(await readFile(join(target, "results", "gpt", upload.id)), bytes);
    assert.equal(restoredGpt.upload(upload.id).name, "example.txt");
    const restoredPreview = new Previews(join(target, "results", "previews"), restored, () => {
      throw Error("Machine unavailable");
    });
    assert((await restoredPreview.document(cached)).includes(original));
    assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM html_previews").get().n, 2);
    assert.equal(new Library(restored, "codex").get("thread", thread.id).pinned, true);
    const actual = restored.db
      .prepare("SELECT nativeId,status,text,files,submitted FROM gpt_jobs ORDER BY nativeId")
      .all();
    for (const row of actual) {
      const status = row.nativeId.slice("native-".length);
      assert.equal(
        row.status,
        ["queued", "preparing", "running"].includes(status) ? "unknown" : status,
      );
      assert.equal(row.text, "Keep this request");
      assert.deepEqual(JSON.parse(row.files), [upload.id]);
      assert.equal(row.submitted, Number(status === "running"));
    }
    assert.deepEqual(
      source.db
        .prepare("SELECT status FROM gpt_jobs")
        .all()
        .map((r) => r.status),
      states,
    );
  } finally {
    await restoredGpt?.close();
    restored?.close();
    await gpt.close();
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup verification rejects missing GPT bytes and captured HTML even if removed from file list", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-backup-coverage-")),
    config = fixtureConfig(root);
  const store = new Store(config.hub.databasePath),
    gpt = new GptService(config, store);
  try {
    const upload = await gpt.put("test.txt", Buffer.from("keep"));
    const t = store.createThread("p", "native", "Preview"),
      previews = new Previews(join(config.hub.resultsPath, "previews"), store, () => ({
        machine: { type: "local-linux" },
        root,
      }));
    previews.observe(t, null, {
      id: "p",
      type: "mcpToolCall",
      result: {
        content: [
          { type: "resource", resource: { mimeType: "text/html", text: "<button>Go</button>" } },
        ],
      },
    });
    const id = store.db.prepare("SELECT id FROM html_previews").get().id;
    await previews.document(id);
    for (const missing of ["results/gpt/" + upload.id, "results/previews/" + id + ".html"]) {
      const snapshot = await createSnapshot(config, join(root, "backups"));
      const manifest = JSON.parse(await readFile(join(snapshot, "manifest.json"), "utf8"));
      await rm(join(snapshot, missing));
      manifest.files = manifest.files.filter((f) => f.path !== missing);
      await writeFile(join(snapshot, "manifest.json"), JSON.stringify(manifest));
      await assert.rejects(verifySnapshot(snapshot), { code: "SNAPSHOT_INCOMPLETE" });
      await assert.rejects(restoreSnapshot(snapshot, join(root, "cannot-restore")), {
        code: "SNAPSHOT_INCOMPLETE",
      });
    }
    await rm(join(config.hub.resultsPath, "gpt", upload.id));
    const target = join(root, "missing-upload");
    await assert.rejects(createSnapshot(config, target));
    assert.deepEqual(await readdir(target), []);
  } finally {
    await gpt.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy backups remain readable and GPT/preview paths never follow symlinks outside storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-backup-legacy-")),
    config = fixtureConfig(root);
  const store = new Store(config.hub.databasePath),
    gpt = new GptService(config, store);
  try {
    const old = await createSnapshot(config, join(root, "legacy"));
    const manifest = JSON.parse(await readFile(join(old, "manifest.json"), "utf8"));
    manifest.format = 1;
    delete manifest.cachedPreviews;
    await writeFile(join(old, "manifest.json"), JSON.stringify(manifest));
    assert.equal((await verifySnapshot(old)).format, 1);
    await restoreSnapshot(old, join(root, "restored-legacy"));
    const upload = await gpt.put("link.txt", Buffer.from("safe"));
    await rm(join(config.hub.resultsPath, "gpt", upload.id));
    const outside = join(root, "outside");
    await writeFile(outside, "not an upload");
    await symlink(outside, join(config.hub.resultsPath, "gpt", upload.id));
    await assert.rejects(createSnapshot(config, join(root, "unsafe")), { code: "UNSAFE_FILE" });
    assert.equal(await readFile(outside, "utf8"), "not an upload");
  } finally {
    await gpt.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
