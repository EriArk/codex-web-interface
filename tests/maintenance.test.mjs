import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { Attachments } from "../apps/hub/dist/attachments.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../apps/hub/dist/maintenance.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";

test("online backup restores login, native IDs, projections and file bytes; old sessions are revoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-backup-test-"));
  let originalApp, restoredApp;
  try {
    const config = configSchema.parse({
      hub: {
        publicBaseUrl: "https://qa.example.test",
        databasePath: join(root, "source", "app.db"),
        resultsPath: join(root, "source", "results"),
      },
      auth: { username: "owner" },
      machines: [{ id: "pc", name: "PC", type: "local-linux", codex: { command: "unused" } }],
      projects: [{ id: "project", name: "Project", machineId: "pc", workingDirectory: root }],
    });
    const token = randomBytes(32).toString("base64url"),
      password = randomBytes(24).toString("hex");
    const source = new Store(config.hub.databasePath);
    originalApp = (await createApp(config, { store: source, setupToken: token })).app;
    const enrollment = await originalApp.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { origin: config.hub.publicBaseUrl },
      payload: { token, password },
    });
    assert.equal(enrollment.statusCode, 200);
    const oldCookie = enrollment.headers["set-cookie"].split(";")[0];
    const t = source.createThread("project", "same-native-thread", "History");
    source.append(t.id, "user.message", { id: "m", text: "Retained conversation" });
    source.db
      .prepare("INSERT INTO catalog_projects VALUES(?,?,?,?)")
      .run("project", "pc", "native-project", "{}");
    const files = new Attachments(join(config.hub.resultsPath, "uploads"), source);
    const upload = await files.put(t.id, "keep.txt", Buffer.from("uploaded content"));
    source.db.prepare("UPDATE attachments SET messageId='m' WHERE id=?").run(upload.id);
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const artifact = new Artifacts(config.hub.resultsPath, source).putPng(
      t.id,
      png.toString("base64"),
    );
    source.db
      .prepare("INSERT INTO results VALUES(?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        t.id,
        null,
        "image",
        "image",
        "Screenshot",
        JSON.stringify(artifact),
        "now",
      );
    source.db
      .prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)")
      .run("scope", "key", "digest", "pending", null, "now");
    source.setStatus(t.id, "running", "native-turn");
    const extra = join(root, "remote.env");
    await writeFile(extra, "SECRET=fixture-only", { mode: 0o600 });
    const snapshots = join(root, "backups");
    const snapshot = await createSnapshot(config, snapshots, {
      keep: 2,
      revision: "abcdef1",
      privateFiles: [{ name: "remote.env", path: extra }],
    });
    const manifest = await verifySnapshot(snapshot);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.revision, "abcdef1");
    assert(manifest.files.some((file) => file.path === "private/remote.env"));
    assert(manifest.files.every((file) => !file.path.includes("repository")));
    const target = join(root, "restored");
    await restoreSnapshot(snapshot, target);
    const restored = new Store(join(target, "app.db"));
    const restoredConfig = {
      ...config,
      hub: {
        ...config.hub,
        databasePath: join(target, "app.db"),
        resultsPath: join(target, "results"),
      },
    };
    restoredApp = (await createApp(restoredConfig, { store: restored })).app;
    assert.equal(restored.thread(t.id).codexThreadId, "same-native-thread");
    assert.equal(restored.thread(t.id).status, "unknown");
    assert.equal(restored.history(t.id).messages[0].text, "Retained conversation");
    assert.equal(restored.db.prepare("SELECT state FROM commands").get().state, "unknown");
    assert.equal(restored.db.prepare("SELECT count(*) AS n FROM catalog_projects").get().n, 1);
    assert.equal(
      (
        await restoredApp.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie: oldCookie },
        })
      ).statusCode,
      401,
    );
    const login = await restoredApp.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: config.hub.publicBaseUrl },
      payload: { password },
    });
    assert.equal(login.statusCode, 200);
    const image = await restoredApp.inject({
      method: "GET",
      url: "/api/artifacts/" + artifact.artifactId,
      headers: { cookie: login.headers["set-cookie"].split(";")[0] },
    });
    assert.equal(image.statusCode, 200);
    assert.deepEqual(image.rawPayload, png);
    assert.equal(
      (await readFile(join(target, "results", "uploads", upload.id + ".bin"))).toString(),
      "uploaded content",
    );
    assert.equal(
      source.thread(t.id).status,
      "running",
      "Online backup must not mutate live session state",
    );
    await assert.rejects(restoreSnapshot(snapshot, target), { code: "RESTORE_TARGET_EXISTS" });
    await writeFile(join(snapshots, "unrelated.txt"), "keep");
    await createSnapshot(config, snapshots, { keep: 2 });
    await createSnapshot(config, snapshots, { keep: 2 });
    assert.equal(
      (await readdir(snapshots)).filter((name) => name.startsWith("codex-backup-")).length,
      2,
    );
    assert.equal((await readFile(join(snapshots, "unrelated.txt"))).toString(), "keep");
  } finally {
    await restoredApp?.close();
    await originalApp?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete, tampered and symlink snapshots fail without publishing or overwriting state", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-backup-boundary-"));
  const config = {
    hub: { databasePath: join(root, "app.db"), resultsPath: join(root, "results") },
  };
  const store = new Store(config.hub.databasePath);
  try {
    const t = store.createThread("p", "native", "test"),
      id = randomUUID();
    await mkdir(config.hub.resultsPath, { mode: 0o700 });
    store.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
      .run(id, t.id, "image/png", 4, "now");
    const destination = join(root, "backups");
    await assert.rejects(createSnapshot(config, destination));
    assert.deepEqual(await readdir(destination), []);
    const secret = join(root, "outside");
    await writeFile(secret, "must not copy");
    await symlink(secret, join(config.hub.resultsPath, id + ".png"));
    await assert.rejects(createSnapshot(config, destination), { code: "UNSAFE_FILE" });
    await rm(join(config.hub.resultsPath, id + ".png"));
    await writeFile(join(config.hub.resultsPath, id + ".png"), "safe");
    const snapshot = await createSnapshot(config, destination);
    await assert.rejects(
      createSnapshot(config, destination, {
        privateFiles: [{ name: "ssh/key", path: join(root, "auth.json") }],
      }),
      { code: "INVALID_PRIVATE_FILE" },
    );
    await writeFile(join(snapshot, "results", id + ".png"), "tampered");
    await assert.rejects(restoreSnapshot(snapshot, join(root, "target")), {
      code: "SNAPSHOT_MISMATCH",
    });
    const publicDir = join(root, "public");
    await mkdir(publicDir, { mode: 0o755 });
    await chmod(publicDir, 0o755);
    await assert.rejects(createSnapshot(config, publicDir), { code: "UNSAFE_DIRECTORY" });
    assert.deepEqual(await readdir(publicDir), []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
