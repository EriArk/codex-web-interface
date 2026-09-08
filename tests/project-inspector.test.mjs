import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectorProbe } from "../packages/machines/dist/inspectorProbe.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const command = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Test",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "test@example.invalid",
    },
  }).toString();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "project-inspector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const list = (root, path = "", offset = 0, search = "") =>
  inspectorProbe(root, { op: "directory", path, offset, search });
test("project browsing bounds pages, hides credentials, rejects parent paths and symbolic links", async (t) => {
  const root = await fixture(t),
    project = join(root, "project");
  await mkdir(project);
  await mkdir(join(project, ".github"));
  await mkdir(join(project, ".codex"));
  await writeFile(join(project, ".env"), "private");
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(root, join(project, "escape"));
  for (let i = 0; i < 105; i++)
    await writeFile(join(project, `file-${String(i).padStart(3, "0")}.txt`), "content");
  const first = await list(project);
  assert.equal(first.entries.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.entries[0].name, ".github");
  assert(!first.entries.some((e) => [".codex", ".env", "escape"].includes(e.name)));
  assert.equal((await list(project, "", 100)).entries.length, 6);
  assert.equal((await list(project, "", 0, "104")).entries[0].name, "file-104.txt");
  for (const path of [
    "../outside.txt",
    "a/../../outside.txt",
    "escape/outside.txt",
    ".env",
    ".codex/auth.json",
    "file-000.txt:stream",
    root,
  ])
    await assert.rejects(inspectorProbe(project, { op: "file", path }));
  await writeFile(join(project, "large.bin"), "");
  await truncate(join(project, "large.bin"), 33554433);
  await assert.rejects(inspectorProbe(project, { op: "file", path: "large.bin" }));
  const linked = join(root, "linked");
  await symlink(project, linked);
  await assert.rejects(list(linked));
});
test("read-only Git handles unborn, staged, working, Unicode, rename, hidden paths and scoped subprojects", async (t) => {
  const root = await fixture(t);
  command(root, "init", "-b", "main");
  await writeFile(join(root, "файл с пробелами.txt"), "one\n");
  command(root, "add", ".");
  let state = await inspectorProbe(root, { op: "git" });
  assert.equal(state.branch, "main");
  assert.equal(state.stagedCount, 1);
  assert.equal(state.commits.length, 0);
  assert.match(
    (await inspectorProbe(root, { op: "diff", path: "файл с пробелами.txt", staged: true })).text,
    /\+one/,
  );
  command(root, "commit", "-m", "Первый коммит");
  command(root, "mv", "файл с пробелами.txt", "новое имя.txt");
  await writeFile(join(root, "новое имя.txt"), "one\ntwo\n");
  await writeFile(join(root, "new.txt"), "new");
  await writeFile(join(root, ".env"), "SECRET");
  const before = await readFile(join(root, ".git/index"));
  state = await inspectorProbe(root, { op: "git" });
  const rename = state.changes.find((c) => c.path === "новое имя.txt");
  assert.equal(rename.previousPath, "файл с пробелами.txt");
  assert.equal(rename.index, "R");
  assert.equal(rename.working, "M");
  assert.equal(state.stagedCount, 1);
  assert.equal(state.workingCount, 1);
  assert.equal(state.untrackedCount, 2);
  assert.equal(state.hiddenCount, 1);
  assert.equal(state.commits[0].subject, "Первый коммит");
  assert.equal(state.summary.working.added, 1);
  assert.deepEqual(await readFile(join(root, ".git/index")), before);
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub/inside.txt"), "sub");
  const nested = await inspectorProbe(join(root, "sub"), { op: "git" });
  assert.equal(nested.changes.length, 1);
  assert(nested.changes[0].path.startsWith("inside"));
  command(root, "checkout", "--detach");
  assert.equal((await inspectorProbe(root, { op: "git" })).detached, true);
});
test("Git does not execute configured fsmonitor, external diff or text conversion; large and binary diffs stay bounded", async (t) => {
  const root = await fixture(t);
  command(root, "init", "-b", "main");
  await writeFile(join(root, "file.txt"), "initial\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  command(root, "add", ".");
  command(root, "commit", "-m", "baseline");
  const marker = join(root, "executed");
  const script = join(root, "trap.sh");
  await writeFile(script, `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o700 });
  command(root, "config", "core.fsmonitor", script);
  command(root, "config", "diff.external", script);
  command(root, "config", "diff.trap.textconv", script);
  await writeFile(join(root, ".gitattributes"), "*.txt diff=trap\n");
  await writeFile(join(root, "file.txt"), "line with enough content\n".repeat(30000));
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 3, 4]));
  const state = await inspectorProbe(root, { op: "git" });
  assert(state.dirty);
  const diff = await inspectorProbe(root, { op: "diff", path: "file.txt", staged: false });
  assert(diff.truncated);
  assert(Buffer.byteLength(diff.text) <= 262144);
  const binary = await inspectorProbe(root, { op: "diff", path: "binary.bin", staged: false });
  assert.match(binary.text, /Binary files/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const plain = join(root, "plain");
  await mkdir(plain);
  await writeFile(join(plain, ".git"), "gitdir: /unavailable");
  await assert.rejects(inspectorProbe(plain, { op: "git" }));
});
test("non-repository folders remain browsable and expose an honest Git state", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await inspectorProbe(root, { op: "git" }), {
    repository: false,
    changes: [],
    commits: [],
  });
});
test("project inspection routes require auth, restrict paths and return exact binary download without acquiring a writer", async (t) => {
  const root = await fixture(t),
    f = await handoffFixture();
  t.after(() => f.close());
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  const filename = "тест 100%25.bin",
    bytes = Buffer.from([0, 255, 12, 66]);
  await writeFile(join(root, filename), bytes);
  const url = "/api/projects/project/files/content?path=" + encodeURIComponent(filename);
  assert.equal((await f.app.inject({ url })).statusCode, 401);
  const simultaneous = await Promise.all(
    Array.from({ length: 5 }, () => f.app.inject({ url, headers: f.headers })),
  );
  assert(simultaneous.every((r) => r.statusCode === 200));
  const response = await f.app.inject({ url, headers: f.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, bytes);
  assert.match(response.headers["content-disposition"], /attachment;.*UTF-8''/);
  assert.equal(response.headers["cache-control"], "no-store");
  for (const path of ["../outside.txt", ".env", "/etc/passwd", ".git/config"])
    assert.notEqual(
      (
        await f.app.inject({
          url: "/api/projects/project/files/content?path=" + encodeURIComponent(path),
          headers: f.headers,
        })
      ).statusCode,
      200,
    );
  assert.equal(
    (await f.app.inject({ url: "/api/projects/missing/files", headers: f.headers })).statusCode,
    404,
  );
  assert.equal(
    (await f.app.inject({ url: "/api/projects/project/files?host=evil", headers: f.headers }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/projects/project/git",
        headers: f.headers,
        payload: { command: "fetch" },
      })
    ).statusCode,
    404,
  );
  assert.equal(f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length, 0);
});
