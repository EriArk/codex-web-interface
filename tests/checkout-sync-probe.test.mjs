import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deliveryProbe } from "../packages/machines/dist/deliveryProbe.js";

const input = {
  kind: "sync",
  syncScope: "c".repeat(64),
  paths: [],
  message: "",
  title: "",
  body: "",
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "checkout-sync-")),
    bin = join(root, "bin"),
    repo = join(root, "copy"),
    writer = join(root, "author"),
    remote = join(root, "remote.git");
  const saved = {
    PATH: process.env.PATH,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    TEST_REMOTE: process.env.TEST_REMOTE,
    TEST_MERGE_FAIL: process.env.TEST_MERGE_FAIL,
  };
  const gitExe = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const git = (cwd, ...args) =>
    execFileSync(gitExe, args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  await mkdir(bin);
  await mkdir(writer);
  git(root, "init", "--bare", "-q", remote);
  git(writer, "init", "-q", "-b", "main");
  for (const cwd of [writer]) {
    git(cwd, "config", "user.name", "Fixture");
    git(cwd, "config", "user.email", "fixture@example.invalid");
  }
  await writeFile(join(writer, "a.txt"), "base A\n");
  await writeFile(join(writer, "b.txt"), "base B\n");
  git(writer, "add", ".");
  git(writer, "commit", "-qm", "initial");
  git(writer, "remote", "add", "origin", remote);
  git(writer, "push", "-q", "origin", "main");
  git(root, "clone", "-q", "-b", "main", remote, repo);
  git(repo, "checkout", "-qb", "participant");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "remote", "set-url", "origin", "https://github.com/Owner/Project.git");
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node
 const cp=require('node:child_process'); const a=process.argv.slice(2); if(a.includes('ls-remote')||a.includes('fetch')) {const i=a.indexOf('origin');if(i>=0)a[i]=process.env.TEST_REMOTE;}
 if(a.includes('merge')&&process.env.TEST_MERGE_FAIL==='1'){require('node:fs').writeFileSync('b.txt','partial checkout\\n');process.exit(1);} const r=cp.spawnSync(${JSON.stringify(gitExe)},a,{stdio:'inherit'});process.exit(r.status??1);`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
 const e=process.argv[process.argv.length-1];let v=e==='user'?{id:42}:e==='repos/Owner/Project'?{id:73,full_name:'Owner/Project',default_branch:'main'}:e.includes('check-runs')?{check_runs:[]}:e.includes('/status')?{statuses:[]}:[];process.stdout.write(JSON.stringify(v));`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + ":" + saved.PATH;
  process.env.LOCALAPPDATA = join(root, "state");
  process.env.TEST_REMOTE = remote;
  t.after(async () => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(root, { recursive: true, force: true });
  });
  const commit = async (cwd, file, text) => {
    await writeFile(join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  const push = () => git(writer, "push", "-q", "origin", "main");
  const probe = (req) => deliveryProbe(repo, req);
  return {
    root,
    repo,
    writer,
    git: (...a) => git(repo, ...a),
    commit,
    push,
    probe,
    inspect: () => probe({ op: "inspect", sync: true }),
    prepare: () => probe({ op: "prepare", id: randomUUID(), input }),
  };
}
test("exact upstream detection, reviewed fast-forward, ignored-file safety and no receipt replay", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).sync.status, "current");
  const before = f.git("rev-parse", "HEAD");
  const sha = await f.commit(f.writer, "a.txt", "upstream\n");
  f.push();
  const s = await f.inspect();
  assert.equal(s.sync.status, "behind");
  assert.equal(s.sync.behind, 1);
  assert.equal(s.sync.githubUserId, 42);
  assert.equal(f.git("rev-parse", "HEAD"), before);
  assert.equal(f.git("status", "--porcelain"), "");
  const r = await f.prepare();
  const done = await f.probe({ op: "apply", id: r.id, fingerprint: r.fingerprint });
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(f.git("rev-parse", "HEAD"), sha);
  assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "upstream\n");
  assert.deepEqual(await f.probe({ op: "apply", id: r.id, fingerprint: r.fingerprint }), done);
  const receipt = join(f.root, "state/CodexWeb/delivery-state", r.id + ".json"),
    saved = JSON.parse(await readFile(receipt, "utf8"));
  saved.public.state = "unknown";
  saved.pid = 2147483647;
  await writeFile(receipt, JSON.stringify(saved));
  assert.equal((await f.probe({ op: "status", id: r.id })).state, "completed");
  assert.equal(f.git("rev-parse", "HEAD"), sha);
});
test("clean divergence preserves both histories in one explicit local merge", async (t) => {
  const f = await fixture(t),
    local = await f.commit(f.repo, "b.txt", "local B\n"),
    upstream = await f.commit(f.writer, "a.txt", "upstream A\n");
  f.push();
  const s = await f.inspect();
  assert.equal(s.sync.status, "local");
  assert.ok(s.sync.tree);
  assert.equal(f.git("rev-parse", "HEAD"), local);
  const r = await f.prepare(),
    done = await f.probe({ op: "apply", id: r.id, fingerprint: r.fingerprint });
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(f.git("show", "-s", "--format=%P", "HEAD"), local + " " + upstream);
  assert.equal(f.git("show", "HEAD:b.txt"), "local B");
  assert.equal(f.git("show", "HEAD:a.txt"), "upstream A");
  assert.equal(f.git("status", "--porcelain"), "");
});
test("conflict preview never starts a merge or changes local bytes", async (t) => {
  const f = await fixture(t),
    local = await f.commit(f.repo, "a.txt", "local A\n");
  await f.commit(f.writer, "a.txt", "upstream A\n");
  f.push();
  const s = await f.inspect();
  assert.equal(s.sync.status, "conflict");
  assert.equal(s.sync.conflictsTotal, 1);
  assert.equal(s.sync.conflicts[0].path, "a.txt");
  assert.match(s.sync.conflicts[0].preview, /local A/);
  assert.match(s.sync.conflicts[0].preview, /upstream A/);
  await assert.rejects(f.prepare, /DELIVERY_SYNC_BLOCKED/);
  assert.equal(f.git("rev-parse", "HEAD"), local);
  assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "local A\n");
  assert.equal(f.git("ls-files", "--unmerged"), "");
});
test("dirty files, remote advance and local changes invalidate prepared updates", async (t) => {
  const f = await fixture(t);
  await f.commit(f.writer, "a.txt", "one\n");
  f.push();
  await writeFile(join(f.repo, "b.txt"), "unsaved\n");
  assert.equal((await f.inspect()).sync.status, "dirty");
  await assert.rejects(f.prepare, /DELIVERY_SYNC_BLOCKED/);
  await writeFile(join(f.repo, "b.txt"), "base B\n");
  const r = await f.prepare();
  await f.commit(f.writer, "a.txt", "two\n");
  f.push();
  const failed = await f.probe({ op: "apply", id: r.id, fingerprint: r.fingerprint });
  assert.equal(failed.state, "failed");
  assert.equal(failed.code, "DELIVERY_REMOTE_CHANGED");
  const next = await f.prepare();
  await writeFile(join(f.repo, "a.txt"), "new draft\n");
  assert.equal(
    (await f.probe({ op: "apply", id: next.id, fingerprint: next.fingerprint })).state,
    "failed",
  );
  assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "new draft\n");
});
test("ignored files are not overwritten and custom merge drivers are not executed by inspection", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, ".git/info/exclude"), "ignored.txt\n");
  await writeFile(join(f.repo, "ignored.txt"), "private local\n");
  await f.commit(f.writer, "ignored.txt", "remote\n");
  f.push();
  const r = await f.prepare(),
    done = await f.probe({ op: "apply", id: r.id, fingerprint: r.fingerprint });
  assert.equal(done.state, "failed");
  assert.equal(await readFile(join(f.repo, "ignored.txt"), "utf8"), "private local\n");
  await f.commit(f.repo, "b.txt", "local B\n");
  f.git("config", "merge.danger.driver", "exit 88");
  assert.equal((await f.inspect()).sync.status, "unavailable");
});

test("a linked worktree updates its own branch while retaining the other working tree", async (t) => {
  const f = await fixture(t),
    linked = join(f.root, "linked");
  f.git("worktree", "add", "-q", "-b", "other", linked);
  await writeFile(join(f.repo, "a.txt"), "private unfinished work\n");
  const sha = await f.commit(f.writer, "b.txt", "new upstream B\n");
  f.push();
  const before = f.git("rev-parse", "HEAD"),
    seen = await deliveryProbe(linked, { op: "inspect", sync: true });
  assert.equal(seen.sync.status, "behind");
  assert.notEqual(seen.sync.gitDirectory, seen.sync.commonDirectory);
  const r = await deliveryProbe(linked, { op: "prepare", id: randomUUID(), input }),
    done = await deliveryProbe(linked, { op: "apply", id: r.id, fingerprint: r.fingerprint });
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(done.commit, sha);
  assert.equal(f.git("rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(f.repo, "a.txt"), "utf8"), "private unfinished work\n");
});

test("partial checkout failure remains uncertain and is not replayed", async (t) => {
  const f = await fixture(t);
  await f.commit(f.writer, "a.txt", "upstream\n");
  f.push();
  const r = await f.prepare();
  process.env.TEST_MERGE_FAIL = "1";
  const result = await f.probe({ op: "apply", id: r.id, fingerprint: r.fingerprint });
  assert.equal(result.state, "unknown");
  delete process.env.TEST_MERGE_FAIL;
  const head = f.git("rev-parse", "HEAD");
  assert.equal(
    (await f.probe({ op: "apply", id: r.id, fingerprint: r.fingerprint })).state,
    "unknown",
  );
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(f.repo, "b.txt"), "utf8"), "partial checkout\n");
});
