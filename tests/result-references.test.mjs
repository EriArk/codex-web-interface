import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { deploymentBlockers } from "../apps/hub/dist/deployment-status.js";
import { Store } from "../apps/hub/dist/store.js";
import {
  ARTIFACT_FILE_LIMIT,
  copyProjectFile,
} from "../packages/machines/dist/projectFileTransfer.js";
import { handoffFixture } from "./handoff-fixture.mjs";

test("exact message references reveal the captured version, never another thread/turn/project or filename", async () => {
  const f = await handoffFixture();
  try {
    const capture = f.sessions.catalog.artifacts;
    capture.read = async () => Buffer.from("first version");
    capture.observe(f.thread, "turn-a", {
      type: "agentMessage",
      id: "answer-a",
      text: "[file](report.md)",
    });
    await capture.close();
    const first = f.store.results(f.thread.id).items[0];
    capture.read = async () => Buffer.from("new version");
    capture.observe(f.thread, "turn-b", {
      type: "agentMessage",
      id: "answer-b",
      text: "[file](report.md)",
    });
    await capture.close();
    const reveal = (body, headers = f.headers) =>
      f.app.inject({
        method: "POST",
        url: `/api/threads/${f.thread.id}/results/reveal`,
        headers,
        payload: body,
      });
    const reference = { source: "report.md", messageId: "answer-a", turnId: "turn-a" };
    assert.equal((await reveal(reference)).json().id, first.id);
    assert.equal(
      (await reveal({ ...reference, source: "C:/Project/report.md:8" })).json().id,
      first.id,
    );
    assert.equal((await reveal(reference, {})).statusCode, 401);
    for (const override of [
      { messageId: "other-answer" },
      { turnId: "turn-b" },
      { source: "../other/report.md" },
      { source: "C:/Another/report.md" },
      { source: "https://external.invalid/report.md" },
    ])
      assert.equal((await reveal({ ...reference, ...override })).statusCode, 404);
    const other = f.store.createThread("project", "other-native", "Other");
    const isolated = f.store.result(other.id, "turn-a", "artifact:alien", "artifact", "report.md", {
      url: "/api/artifacts/alien",
    });
    assert(isolated);
    assert.equal((await reveal({ ...reference, source: "/api/artifacts/alien" })).statusCode, 404);
    const images = f.sessions.catalog.observeImages(f.thread, "turn-a", {
      id: "answer-a",
      type: "agentMessage",
      text: "![Exact](C:/Project/exact.png) ![Second](C:/Project/second.png)",
    });
    assert.equal(images.length, 2);
    assert.equal(
      (await reveal({ ...reference, source: "C:/Project/second.png" })).json().id,
      images[1],
    );
    const hash = createHash("sha256").update("C:/Project/exact.png").digest("hex");
    assert.equal(
      (await reveal({ ...reference, source: "", sourceHash: hash })).json().id,
      images[0],
    );
    f.store.db.prepare("DELETE FROM results WHERE id=?").run(first.id);
    assert.equal((await reveal(reference)).statusCode, 404);
    f.store.db
      .prepare("UPDATE artifact_captures SET status='capturing' WHERE threadId=?")
      .run(f.thread.id);
    assert(deploymentBlockers(f.store).some((blocker) => blocker.kind === "artifact"));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("GPT reveal binds a canonical visible message and sandbox path, including denied and absent references", async () => {
  const raw = {
    current_node: "answer",
    mapping: {
      answer: {
        message: {
          id: "answer",
          author: { role: "assistant" },
          channel: "final",
          content: { content_type: "text", parts: ["[Export](sandbox:/mnt/data/report.md)"] },
        },
      },
    },
  };
  const native = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(path === "/conversation" ? raw : {}));
  });
  native.listen(0, "127.0.0.1");
  await once(native, "listening");
  process.env.GPT_REVEAL_FIXTURE_TOKEN = "fixture-only";
  const f = await handoffFixture(undefined, undefined, {
    configure(config) {
      config.gpt = {
        endpoint: `http://127.0.0.1:${native.address().port}`,
        tokenSecret: "GPT_REVEAL_FIXTURE_TOKEN",
      };
    },
  });
  try {
    const url = "/api/gpt/conversations/conversation/results/reveal";
    const ref = { source: "sandbox:/mnt/data/report.md", messageId: "answer" };
    const reveal = (payload, headers = f.headers) =>
      f.app.inject({ method: "POST", url, headers, payload });
    const result = await reveal(ref);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().title, "report.md");
    const exact = result.json().payload.url;
    assert.equal((await reveal({ ...ref, source: exact })).json().id, result.json().id);
    assert.equal((await reveal(ref, {})).statusCode, 401);
    for (const change of [
      { messageId: "other" },
      { source: "sandbox:/mnt/data/other.md" },
      { source: exact.replace("conversation", "other") },
      { source: "sandbox:/mnt/data/../private.md" },
    ])
      assert.equal((await reveal({ ...ref, ...change })).statusCode, 404);
  } finally {
    await f.close();
    await new Promise((resolve) => native.close(resolve));
    delete process.env.GPT_REVEAL_FIXTURE_TOKEN;
  }
});

test("large captured files stream through authenticated HEAD/GET/ranges and remain exact", async () => {
  const f = await handoffFixture();
  try {
    const artifacts = f.sessions.catalog.artifacts.artifacts;
    const bytes = Buffer.from("0123456789abcdef");
    const file = await artifacts.putStream(
      f.thread.id,
      "turn",
      "case.zip",
      "C:/Project/case.zip",
      "application/zip",
      async (path) => {
        await writeFile(path, bytes);
        return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      },
    );
    const get = (method, headers = {}) =>
      f.app.inject({ method, url: file.url, headers: { ...f.headers, ...headers } });
    const head = await get("HEAD");
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], "16");
    assert.equal(head.headers["accept-ranges"], "bytes");
    assert.match(head.headers["content-disposition"], /attachment.*case.zip/);
    assert.equal((await get("GET")).body, bytes.toString());
    const chunk = await get("GET", { range: "bytes=3-7" });
    assert.equal(chunk.statusCode, 206);
    assert.equal(chunk.body, "34567");
    assert.equal(chunk.headers["content-range"], "bytes 3-7/16");
    assert.equal((await get("GET", { range: "bytes=-4" })).body, "cdef");
    for (const range of ["bytes=80-", "bytes=3-1", "bytes=0-1,3-5", "bytes=-0"])
      assert.equal((await get("GET", { range })).statusCode, 416);
    assert.equal((await f.app.inject({ method: "HEAD", url: file.url })).statusCode, 401);
    await rm(join(artifacts.root, file.artifactId + ".bin"));
    assert.equal((await get("HEAD")).statusCode, 404);
  } finally {
    await f.close();
  }
});

test("400 MiB export transfers to disk with bounded memory; limits, escaping links and partial failures leave no artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "large-export-")),
    project = join(root, "project"),
    resultRoot = join(root, "results");
  await mkdir(project);
  const store = new Store(":memory:"),
    artifacts = new Artifacts(resultRoot, store);
  const thread = store.createThread("p", "n", "Export"),
    machine = { id: "local", type: "local-linux" };
  try {
    const source = join(project, "case.zip");
    await writeFile(source, "PK archive fixture");
    const size = 400 * 1024 * 1024;
    await truncate(source, size);
    const before = process.memoryUsage().arrayBuffers;
    const saved = await artifacts.putStream(
      thread.id,
      "t",
      "case.zip",
      source,
      "application/zip",
      (destination, limit) => copyProjectFile(machine, project, source, destination, limit),
    );
    assert.equal(saved.bytes, size);
    assert(
      process.memoryUsage().arrayBuffers - before < 100 * 1024 * 1024,
      "transfer must not retain a file-sized Buffer",
    );
    const hash = createHash("sha256");
    for await (const chunk of artifacts.stream(saved.artifactId)) hash.update(chunk);
    assert.equal(hash.digest("hex"), saved.sha256);
    await truncate(source, ARTIFACT_FILE_LIMIT + 1);
    await assert.rejects(
      copyProjectFile(machine, project, source, join(resultRoot, "too-large.part")),
    );
    await writeFile(join(root, "private.txt"), "private");
    await symlink(join(root, "private.txt"), join(project, "escape.txt"));
    await assert.rejects(
      copyProjectFile(machine, project, "escape.txt", join(resultRoot, "escape.part")),
    );
    await assert.rejects(
      artifacts.putStream(thread.id, "t", "broken.zip", source, "application/zip", async (path) => {
        await writeFile(path, "partial");
        throw new Error("connection lost");
      }),
    );
    assert.deepEqual(await readdir(resultRoot), [saved.artifactId + ".bin"]);
    assert.equal(store.db.prepare("SELECT count(*) n FROM artifacts").get().n, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
