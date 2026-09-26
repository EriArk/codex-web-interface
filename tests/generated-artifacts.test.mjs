import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { artifactSources, GeneratedArtifacts } from "../apps/hub/dist/generatedArtifacts.js";
import { createSnapshot, verifySnapshot } from "../apps/hub/dist/maintenance.js";
import { resolveResultReference } from "../apps/hub/dist/result-references.js";
import { storageReport } from "../apps/hub/dist/storage.js";
import { Store } from "../apps/hub/dist/store.js";
import {
  PROJECT_FILE_LIMIT,
  projectFilePath,
  readProjectFile,
} from "../packages/machines/dist/projectFile.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const machine = { id: "local", type: "local-linux" };
test("Codex exports long blocks once, keeps short blocks inline and binds exact source bytes", async () => {
  const f = await fixture();
  try {
    const short = "```md\n" + "short\n".repeat(20) + "```\n\n",
      body = "long\r\n".repeat(21);
    const item = {
      id: "block-answer",
      type: "agentMessage",
      text: short + "```md\r\n" + body + "```",
    };
    f.generated.observe(f.thread, "turn", item);
    f.generated.observe(f.thread, "turn", item);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM artifacts").get().n, 1);
    const ref = {
      source: `text-block:${short.length}:${createHash("sha256").update(body).digest("hex")}`,
      messageId: item.id,
      turnId: "turn",
    };
    const result = resolveResultReference(f.store, f.thread, machine, f.source, ref);
    assert.equal(f.artifacts.get(result.payload.url.split("/").at(-1)).data.toString(), body);
    assert.throws(() =>
      resolveResultReference(f.store, f.thread, machine, f.source, { ...ref, messageId: "other" }),
    );
    assert.throws(() =>
      resolveResultReference(f.store, f.thread, machine, f.source, { ...ref, turnId: "other" }),
    );
  } finally {
    await f.close();
  }
});
test("native export outside the checkout is captured, revealed and kept private to its message", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "export with spaces.md");
    await writeFile(source, "# Export outside the repository\n");
    const item = { id: "outside-answer", type: "agentMessage", text: `[Export](<${source}>)` };
    f.generated.observe(f.thread, "turn", item);
    await f.generated.close();
    const result = resolveResultReference(f.store, f.thread, machine, f.source, {
      source,
      messageId: item.id,
      turnId: "turn",
    });
    const capture = f.store.db.prepare("SELECT * FROM artifact_captures").get();
    assert.equal(capture.status, "captured");
    assert.equal(result.type, "artifact");
    assert.equal(
      f.artifacts.get(capture.artifactId).data.toString(),
      "# Export outside the repository\n",
    );
    assert.throws(() =>
      resolveResultReference(f.store, f.thread, machine, f.source, {
        source,
        messageId: "different-answer",
        turnId: "turn",
      }),
    );
    await assert.rejects(readProjectFile(machine, f.source, source));
    f.generated.observe(f.thread, "turn", item);
    await f.generated.close();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM artifacts").get().n, 1);
  } finally {
    await f.close();
  }
});

test("opening old native history discovers file links without requiring a new response", async () => {
  const f = await handoffFixture();
  try {
    const collector = f.sessions.catalog.artifacts;
    collector.read = async () => Buffer.from("existing export");
    const entry = {
      turnId: "old-turn",
      item: {
        id: "old-answer",
        type: "agentMessage",
        text: "[Export](C:/Users/Test/AppData/Local/export.md)",
      },
    };
    f.sessions.catalog.message(f.thread, entry, 0);
    await collector.close();
    const response = await f.app.inject({
      method: "POST",
      url: `/api/threads/${f.thread.id}/results/reveal`,
      headers: f.headers,
      payload: {
        source: "C:/Users/Test/AppData/Local/export.md",
        messageId: "old-answer",
        turnId: "old-turn",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().type, "artifact");
    f.sessions.catalog.message(f.thread, entry, 0);
    await collector.close();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM artifact_captures").get().n, 1);
  } finally {
    await f.close();
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "artifact-test-"));
  const source = join(root, "project");
  await mkdir(source);
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://qa.test",
      databasePath: join(root, "hub.db"),
      resultsPath: join(root, "results"),
    },
    auth: {},
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath),
    artifacts = new Artifacts(config.hub.resultsPath, store);
  const thread = store.createThread("p", "native", "Export");
  const generated = new GeneratedArtifacts(store, artifacts, () => ({ machine, root: source }));
  return {
    root,
    source,
    config,
    store,
    artifacts,
    thread,
    generated,
    close: async () => {
      await generated.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("explicit file links are location-independent; automatic discovery remains conservative", () => {
  assert.deepEqual(
    artifactSources({
      type: "agentMessage",
      text: "[Build](Dockerfile) [Section](#build) [Email](mailto:test@example.com)",
    }),
    ["Dockerfile"],
  );
  assert.deepEqual(
    artifactSources({
      type: "agentMessage",
      text: "[report](report.md) [model](thing.custom) [secret](credentials.json) [env](.env) [auth](auth.json) [web](https://qa.test/file.pdf) ![img](inline.png)",
    }),
    ["report.md", "thing.custom", "credentials.json", ".env", "auth.json"],
  );
  assert.deepEqual(
    artifactSources({
      type: "fileChange",
      changes: [
        { path: "config.json" },
        { path: "output.pdf" },
        { path: "old.pdf", kind: "delete" },
      ],
    }),
    ["output.pdf"],
  );
  assert.deepEqual(artifactSources({ type: "userMessage", text: "[mine](private.pdf)" }), []);
});
test("project file boundary rejects traversal, sibling prefixes, UNC and native link escapes", async () => {
  const f = await fixture();
  try {
    const win = { type: "ssh-windows" };
    assert.equal(
      projectFilePath(win, "C:/Project", "c:/project/output.pdf"),
      "c:\\project\\output.pdf",
    );
    for (const path of [
      "../other.pdf",
      "C:/Project2/other.pdf",
      "C:/Project/file.txt:secret",
      "\\\\server\\share\\x.pdf",
      "%2e%2e/other.pdf",
      "file.pdf\nignored",
    ])
      assert.throws(() => projectFilePath(win, "C:/Project", path));
    await writeFile(join(f.source, "small.txt"), "original");
    assert.equal((await readProjectFile(machine, f.source, "small.txt")).toString(), "original");
    const outside = join(f.root, "outside.txt");
    await writeFile(outside, "private");
    await symlink(outside, join(f.source, "escape.txt"));
    await assert.rejects(() => readProjectFile(machine, f.source, "escape.txt"));
    await truncate(join(f.source, "small.txt"), PROJECT_FILE_LIMIT + 1);
    await assert.rejects(() => readProjectFile(machine, f.source, "small.txt"));
  } finally {
    await f.close();
  }
});
test("captured artifacts preserve bytes/checksum, dedupe retries, remain private storage references and enter backups", async () => {
  const f = await fixture();
  try {
    const source = join(f.source, "report.md");
    await writeFile(source, "# First version\n");
    const item = { id: "answer", type: "agentMessage", text: "[Отчёт](report.md)" };
    f.generated.observe(f.thread, "turn", item);
    await f.generated.close();
    const captured = f.store.db.prepare("SELECT * FROM artifact_captures").get();
    assert.equal(captured.status, "captured");
    const file = f.artifacts.get(captured.artifactId);
    assert.equal(file.name, "report.md");
    assert.equal(file.data.toString(), "# First version\n");
    assert.equal(f.store.db.prepare("SELECT sha256 FROM artifact_files").get().sha256.length, 64);
    await writeFile(source, "# Changed later");
    f.generated.observe(f.thread, "turn", item);
    await f.generated.capture(captured.id);
    assert.equal(f.artifacts.get(captured.artifactId).data.toString(), "# First version\n");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM artifacts").get().n, 1);
    const report = await storageReport(f.config, f.store.db);
    assert.equal(report.missingFiles, 0);
    assert.equal(report.orphanFiles, 0);
    const snapshot = await createSnapshot(f.config, join(f.root, "backup"));
    await verifySnapshot(snapshot);
    const backupFile = await readFile(join(snapshot, "results", captured.artifactId + ".bin"));
    assert.deepEqual(backupFile, file.data);
    const limited = new Artifacts(f.config.hub.resultsPath, f.store, 1);
    assert.throws(
      () =>
        limited.putFile(f.thread.id, null, "next.txt", source, "text/plain", Buffer.from("full")),
      { code: "ARTIFACT_STORAGE_FULL" },
    );
  } finally {
    await f.close();
  }
});
test("capture failure and interrupted capture are visible and explicitly retryable without duplicating result", async () => {
  const f = await fixture();
  try {
    const item = { id: "answer", type: "agentMessage", text: "[File](missing.txt)" };
    f.generated.observe(f.thread, "turn", item);
    await f.generated.close();
    const c = f.store.db.prepare("SELECT * FROM artifact_captures").get();
    assert.equal(c.status, "failed");
    f.store.db.prepare("UPDATE artifact_captures SET status='capturing'").run();
    const restarted = new GeneratedArtifacts(f.store, f.artifacts, () => ({
      machine,
      root: f.source,
    }));
    assert.equal(restarted.get(c.id).status, "failed");
    await writeFile(join(f.source, "missing.txt"), "now available");
    await restarted.capture(c.id);
    assert.equal(restarted.get(c.id).status, "captured");
    assert.equal(f.store.results(f.thread.id).items.length, 1);
  } finally {
    await f.close();
  }
});
test("raster artifacts display inline while active formats remain downloads", async () => {
  const f = await handoffFixture();
  try {
    const artifacts = new Artifacts(f.sessions.config.hub.resultsPath, f.store);
    for (const mime of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/svg+xml",
      "text/html",
    ]) {
      const file = artifacts.putFile(
        f.thread.id,
        null,
        "example",
        "fixture",
        mime,
        Buffer.from("fixture"),
      );
      assert.equal((await f.app.inject({ url: file.url })).statusCode, 401);
      const response = await f.app.inject({ url: file.url, headers: f.headers });
      const raster = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
      assert.equal(response.statusCode, 200);
      assert.ok(
        response.headers["content-disposition"].startsWith(raster ? "inline;" : "attachment;"),
      );
      assert.equal(response.headers["content-type"], raster ? mime : "application/octet-stream");
      assert.equal(response.body, "fixture");
    }
  } finally {
    await f.close();
  }
});

test("Codex links reuse public Markdown parsing, deduplicate and remain thread-scoped", async () => {
  const f = await handoffFixture();
  try {
    const item = {
      type: "agentMessage",
      text: "[Docs](https://example.org/docs) and https://example.org/docs\n\n`https://hidden.test/code`\n\n[File](/api/artifacts/example)\n\n![Image](https://hidden.test/image.png)",
    };
    f.sessions.catalog.observeLinks(f.thread, "turn", item);
    f.sessions.catalog.observeLinks(f.thread, "turn", item);
    f.sessions.catalog.observeLinks(f.thread, "turn", {
      type: "reasoning",
      text: "https://hidden.test/reasoning",
    });
    const result = await f.app.inject({
      url: "/api/projects/project/results?category=links",
      headers: f.headers,
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().items.length, 1);
    assert.equal(result.json().items[0].payload.url, "https://example.org/docs");
    assert.equal(result.json().counts.links, 1);
  } finally {
    await f.close();
  }
});

test("project library filters before paging, scopes results and artifact downloads require authentication", async () => {
  const f = await handoffFixture();
  try {
    f.sessions.catalog.artifacts.read = async () => Buffer.from("private result\n");
    f.sessions.catalog.artifacts.observe(f.thread, "turn", {
      id: "answer",
      type: "agentMessage",
      text: "[Report](report.md)",
    });
    await f.sessions.catalog.artifacts.close();
    const artifact = f.store.db.prepare("SELECT * FROM artifacts").get();
    const url = "/api/artifacts/" + artifact.id;
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    const download = await f.app.inject({ url, headers: f.headers });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, "private result\n");
    assert.match(download.headers["content-disposition"], /report.md/);
    assert.equal(download.headers["content-type"], "application/octet-stream");
    const second = f.store.createThread("project", randomUUID(), "Second chat"),
      other = f.store.createThread("other", randomUUID(), "Other project");
    for (let n = 0; n < 24; n++)
      f.store.result(second.id, "turn" + n, "file" + n, "artifact", "File " + n, {});
    for (let n = 0; n < 50; n++)
      f.store.result(f.thread.id, "check" + n, "check" + n, "check", "Build", {});
    const alien = f.store.result(other.id, null, "alien", "artifact", "Alien", {});
    const list = await f.app.inject({
      url: "/api/projects/project/results?category=files",
      headers: f.headers,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 20);
    assert.equal(list.json().counts.files, 25);
    assert.equal(list.json().counts.work, 50);
    const page2 = await f.app.inject({
      url: "/api/projects/project/results?category=files&before=" + list.json().nextBefore,
      headers: f.headers,
    });
    assert.equal(page2.json().items.length, 5);
    assert.equal(
      (await f.app.inject({ url: "/api/projects/project/results/" + alien, headers: f.headers }))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test("artifact retry acknowledges a slow transfer without blocking HTTP and shares concurrent retries", async () => {
  const f = await handoffFixture();
  let release = () => {};
  try {
    const captures = f.sessions.catalog.artifacts;
    captures.read = async () => {
      throw new Error("missing");
    };
    captures.observe(f.thread, "turn", {
      id: "retryable",
      type: "agentMessage",
      text: "[Retry](retry.txt)",
    });
    await captures.close();
    const c = f.store.db.prepare("SELECT id FROM artifact_captures").get();
    let reads = 0;
    captures.read = async () => {
      reads++;
      return new Promise((resolve) => {
        release = () => resolve(Buffer.from("retained bytes"));
      });
    };
    const url = "/api/artifact-captures/" + c.id + "/retry";
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url,
          headers: { cookie: f.headers.cookie, origin: f.headers.origin },
        })
      ).statusCode,
      403,
    );
    const first = await f.app.inject({ method: "POST", url, headers: f.headers });
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().status, "capturing");
    assert.equal((await f.app.inject({ method: "POST", url, headers: f.headers })).statusCode, 202);
    assert.equal(reads, 1);
    release();
    await captures.close();
    assert.equal(captures.get(c.id).status, "captured");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM artifacts").get().n, 1);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  } finally {
    release();
    await f.close();
  }
});

test("explicit checkout cache export survives old-history discovery, exact reveal and authenticated download", async () => {
  const f = await handoffFixture();
  try {
    const captures = f.sessions.catalog.artifacts;
    const bytes = Buffer.from("PK fixture archive bytes");
    const paths = [];
    captures.read = async (_machine, _root, path) => {
      paths.push(path);
      return bytes;
    };
    const item = {
      id: "cache-export",
      type: "agentMessage",
      text: "[ZIP](C:/Project/.cache/member-support/diagnostic.zip)",
    };
    f.sessions.catalog.message(f.thread, { turnId: "cache-turn", item }, 0);
    await captures.close();
    const row = f.store.db
      .prepare("SELECT * FROM artifact_captures WHERE name='diagnostic.zip'")
      .get();
    assert.equal(row.status, "captured");
    assert.equal(paths.length, 1);
    const reveal = await f.app.inject({
      method: "POST",
      url: `/api/threads/${f.thread.id}/results/reveal`,
      headers: f.headers,
      payload: {
        source: "C:/Project/.cache/member-support/diagnostic.zip",
        messageId: item.id,
        turnId: "cache-turn",
      },
    });
    assert.equal(reveal.statusCode, 200);
    const url = reveal.json().payload.url;
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    const download = await f.app.inject({ url, headers: f.headers });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, bytes);
    assert.match(download.headers["content-disposition"], /attachment;.*diagnostic.zip/);
    f.sessions.catalog.message(f.thread, { turnId: "cache-turn", item }, 0);
    await captures.close();
    assert.equal(paths.length, 1);
    const wrong = await f.app.inject({
      method: "POST",
      url: `/api/threads/${f.thread.id}/results/reveal`,
      headers: f.headers,
      payload: {
        source: "C:/Project/.cache/member-support/diagnostic.zip",
        messageId: "other",
        turnId: "cache-turn",
      },
    });
    assert.equal(wrong.statusCode, 404);
  } finally {
    await f.close();
  }
});

test("explicit hidden and external exports preserve exact bytes; user text and implicit changes do not export them", async () => {
  const f = await fixture();
  try {
    const files = [
      join(f.source, ".cache", "report.zip"),
      join(f.root, ".outside", "report.zip"),
      join(f.source, ".env"),
      join(f.source, "credentials.json"),
    ];
    for (const [i, source] of files.entries()) {
      await mkdir(join(source, ".."), { recursive: true });
      const bytes = Buffer.from("synthetic export fixture " + i);
      await writeFile(source, bytes);
      f.generated.observe(f.thread, "turn", {
        id: "implicit-" + i,
        type: "fileChange",
        changes: [{ path: source }],
      });
      f.generated.observe(f.thread, "turn", {
        id: "user-" + i,
        type: "userMessage",
        text: `[File](${source})`,
      });
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM artifact_captures").get().n, i);
      const link = source.replace(".cache", "%2Ecache");
      f.generated.observe(f.thread, "turn", {
        id: "explicit-" + i,
        type: "agentMessage",
        text: `[File](${link})`,
      });
      await f.generated.close();
      const result = resolveResultReference(f.store, f.thread, machine, f.source, {
        source: link,
        messageId: "explicit-" + i,
        turnId: "turn",
      });
      assert.deepEqual(f.artifacts.get(result.payload.url.split("/").at(-1)).data, bytes);
    }
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM artifact_captures").get().n,
      files.length,
    );
    assert.deepEqual(
      artifactSources({
        type: "fileChange",
        changes: [{ path: ".cache/image.png" }, { path: ".private/report.pdf" }],
      }),
      [],
    );
  } finally {
    await f.close();
  }
});
