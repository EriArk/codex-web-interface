import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deliveryProbe } from "../packages/machines/dist/deliveryProbe.js";

const input = (paths) => ({
  kind: "commit",
  paths,
  message: "Reviewed checkpoint",
  title: "",
  body: "",
});
async function fixture(t, initial = true) {
  const root = await mkdtemp(join(tmpdir(), "delivery-test-")),
    repo = join(root, "repo"),
    previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = join(root, "state");
  await mkdir(repo);
  t.after(async () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "feature");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  if (initial) {
    await writeFile(join(repo, "a.txt"), "base A\n");
    await writeFile(join(repo, "b.txt"), "base B\n");
    git("add", "a.txt", "b.txt");
    git("commit", "-qm", "Initial");
  }
  const probe = (req) => deliveryProbe(repo, req),
    prepare = async (paths) => probe({ op: "prepare", id: randomUUID(), input: input(paths) });
  return { root, repo, git, probe, prepare };
}
test("reviewed checkpoint commits only selected bytes and preserves unrelated staged and working changes", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "a.txt"), "reviewed A\n");
  await writeFile(join(f.repo, "b.txt"), "staged B\n");
  f.git("add", "b.txt");
  await writeFile(join(f.repo, "b.txt"), "working B\n");
  const op = await f.prepare(["a.txt"]);
  assert.equal(op.state, "prepared");
  assert.equal(f.git("rev-list", "--count", "HEAD"), "1");
  const complete = await f.probe({ op: "apply", id: op.id, fingerprint: op.fingerprint });
  assert.equal(complete.state, "completed", JSON.stringify(complete));
  assert.equal(f.git("show", "HEAD:a.txt"), "reviewed A");
  assert.equal(f.git("show", "HEAD:b.txt"), "base B");
  assert.equal(f.git("show", ":b.txt"), "staged B");
  assert.equal((await readFile(join(f.repo, "b.txt"), "utf8")).trim(), "working B");
  assert.equal(f.git("diff", "--name-only"), "b.txt");
  assert.equal(f.git("diff", "--cached", "--name-only"), "b.txt");
  assert.deepEqual(
    await f.probe({ op: "apply", id: op.id, fingerprint: op.fingerprint }),
    complete,
  );
  assert.equal(f.git("rev-list", "--count", "HEAD"), "2");
});
test("changed work rejects a stale checkpoint before HEAD/index mutation", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "a.txt"), "reviewed\n");
  const op = await f.prepare(["a.txt"]),
    head = f.git("rev-parse", "HEAD");
  await writeFile(join(f.repo, "a.txt"), "changed after review\n");
  const r = await f.probe({ op: "apply", id: op.id, fingerprint: op.fingerprint });
  assert.equal(r.state, "failed");
  assert.equal(r.code, "DELIVERY_CHANGED");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});
test("first commit, deleted directories, credential paths and repository boundaries remain explicit", async (t) => {
  const f = await fixture(t, false);
  await mkdir(join(f.repo, "folder"));
  await writeFile(join(f.repo, "folder", "file.txt"), "first\n");
  await writeFile(join(f.repo, ".env"), "PRIVATE_FIXTURE=never-commit\n");
  const state = await f.probe({ op: "inspect" });
  assert.equal(state.head, null);
  assert.equal(state.hidden, 1);
  assert.equal(state.paths.length, 1);
  await assert.rejects(() => f.prepare([".env"]), /DELIVERY_REQUEST/);
  const op = await f.prepare(["folder/file.txt"]),
    done = await f.probe({ op: "apply", id: op.id, fingerprint: op.fingerprint });
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(f.git("ls-tree", "-r", "--name-only", "HEAD"), "folder/file.txt");
  await assert.rejects(
    () => deliveryProbe(join(f.repo, "folder"), { op: "inspect" }),
    /DELIVERY_REPOSITORY_BOUNDARY/,
  );
  await rm(join(f.repo, "folder"), { recursive: true });
  const removal = await f.prepare(["folder/file.txt"]);
  assert.equal(
    (await f.probe({ op: "apply", id: removal.id, fingerprint: removal.fingerprint })).state,
    "completed",
  );
  assert.equal(f.git("ls-tree", "-r", "--name-only", "HEAD"), "");
  f.git("checkout", "--detach", "-q");
  await writeFile(join(f.repo, "other.txt"), "other");
  await assert.rejects(() => f.prepare(["other.txt"]), /DELIVERY_DETACHED/);
});
test("verification after a crash between HEAD and index finalizes the same checkpoint without a second commit", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "a.txt"), "reviewed\n");
  const op = await f.prepare(["a.txt"]),
    oldIndex = await readFile(join(f.repo, ".git", "index"));
  const done = await f.probe({ op: "apply", id: op.id, fingerprint: op.fingerprint });
  assert.equal(done.state, "completed");
  const receiptPath = join(f.root, "state", "CodexWeb", "delivery-state", op.id + ".json"),
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.phase = "move-head";
  receipt.pid = 2147483647;
  receipt.public.state = "unknown";
  await writeFile(receipt.indexFile, await readFile(join(f.repo, ".git", "index")));
  await writeFile(receiptPath, JSON.stringify(receipt));
  await writeFile(join(f.repo, ".git", "index"), oldIndex);
  const recovered = await f.probe({ op: "status", id: op.id });
  assert.equal(recovered.state, "completed", JSON.stringify(recovered));
  assert.equal(recovered.commit, done.commit);
  assert.equal(f.git("rev-list", "--count", "HEAD"), "2");
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

test("concurrent preparation preserves the winning receipt and commit mode respects core.filemode", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "a.txt"), "new\n");
  f.git("config", "core.filemode", "false");
  await chmod(join(f.repo, "a.txt"), 0o755);
  const id = randomUUID(),
    results = await Promise.allSettled([
      f.probe({ op: "prepare", id, input: input(["a.txt"]) }),
      f.probe({ op: "prepare", id, input: { ...input(["a.txt"]), message: "Other" } }),
    ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const op = results.find((r) => r.status === "fulfilled").value;
  assert.equal(
    (await f.probe({ op: "apply", id, fingerprint: op.fingerprint })).state,
    "completed",
  );
  assert.match(f.git("ls-tree", "HEAD", "a.txt"), /^100644/);
});

test("separate Git worktree keeps its own branch and index", async (t) => {
  const f = await fixture(t),
    other = join(f.root, "worktree");
  f.git("worktree", "add", "-b", "other", other);
  await writeFile(join(other, "a.txt"), "worktree change\n");
  const op = await deliveryProbe(other, {
    op: "prepare",
    id: randomUUID(),
    input: input(["a.txt"]),
  });
  assert.equal(
    (await deliveryProbe(other, { op: "apply", id: op.id, fingerprint: op.fingerprint })).state,
    "completed",
  );
  assert.equal(f.git("show", "HEAD:a.txt"), "base A");
  assert.equal(f.git("show", "other:a.txt"), "worktree change");
});

async function githubFixture(t) {
  const f = await fixture(t),
    bin = join(f.root, "bin"),
    data = join(f.root, "github.json"),
    real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await mkdir(bin);
  f.git("remote", "add", "origin", "https://github.com/Owner/Project.git");
  const state = {
    head: f.git("rev-parse", "HEAD"),
    remote: null,
    pr: null,
    pushes: 0,
    creates: 0,
    reject: false,
    offline: false,
    blockAfterPush: false,
    blockAfterCreate: false,
    checksFail: false,
  };
  await writeFile(data, JSON.stringify(state));
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process'),file=process.env.DELIVERY_TEST_STATE,s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2),save=()=>fs.writeFileSync(file,JSON.stringify(s));
if(a.includes('ls-remote')){if(s.offline)process.exit(1);if(s.remote)process.stdout.write(s.remote+'\\trefs/heads/feature\\n');process.exit(0)}
if(a.includes('push')&&!a.includes('get-url')){if(a.includes('--force')||a.includes('--force-with-lease')||a.some(v=>v.startsWith('+')))throw Error('unsafe push');s.pushes++;if(s.reject){save();process.stderr.write('! [rejected] feature -> feature (non-fast-forward)');process.exit(1)}s.remote=s.head;s.offline=s.blockAfterPush;save();process.exit(0)}
const r=cp.spawnSync(${JSON.stringify(real)},a,{cwd:process.cwd(),env:process.env,input:fs.readFileSync(0)});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs=require('fs'),file=process.env.DELIVERY_TEST_STATE,s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2),url=a[5],post=a.includes('POST'),out=v=>process.stdout.write(JSON.stringify(v)),save=()=>fs.writeFileSync(file,JSON.stringify(s));
if(s.offline)process.exit(1);
if(post){if(url!=='repos/Owner/Project/pulls')throw Error('unexpected mutation');const b=JSON.parse(fs.readFileSync(0,'utf8'));s.creates++;s.pr={number:7,title:b.title,body:b.body,head:{ref:b.head,sha:s.head,repo:{full_name:'Owner/Project'}},base:{ref:b.base},mergeable:true};s.offline=s.blockAfterCreate;save();out(s.pr);process.exit(0)}
if(url==='repos/Owner/Project')out({full_name:'Owner/Project',default_branch:'main'});
else if(url.includes('/pulls?'))out(s.pr?[s.pr]:[]);
else if(url.includes('/check-runs')){if(s.checksFail)process.exit(1);out({check_runs:[{name:'Build',status:'completed',conclusion:'failure',html_url:'https://github.com/Owner/Project/actions/runs/1'}]})}
else if(url.includes('/status?'))out({statuses:[]});else throw Error('unexpected API');
`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH,
    oldState = process.env.DELIVERY_TEST_STATE;
  process.env.PATH = bin + ":" + oldPath;
  process.env.DELIVERY_TEST_STATE = data;
  t.after(() => {
    process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.DELIVERY_TEST_STATE;
    else process.env.DELIVERY_TEST_STATE = oldState;
  });
  const read = async () => JSON.parse(await readFile(data, "utf8")),
    save = async (patch) => writeFile(data, JSON.stringify({ ...(await read()), ...patch }));
  return {
    ...f,
    read,
    save,
    prepareKind: (kind) =>
      f.probe({
        op: "prepare",
        id: randomUUID(),
        input: { ...input([]), kind, title: "Reviewed PR", body: "Exact PR body" },
      }),
  };
}
test("push rejection and remote divergence stop without force, pull or retry", async (t) => {
  const f = await githubFixture(t);
  await f.save({ remote: "c".repeat(40), reject: true });
  const op = await f.prepareKind("push"),
    result = await f.probe({ op: "apply", id: op.id, fingerprint: op.fingerprint });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "DELIVERY_PUSH_REJECTED");
  assert.equal((await f.read()).pushes, 1);
  await f.save({ reject: false });
  const next = await f.prepareKind("push");
  await f.save({ remote: "d".repeat(40) });
  assert.equal(
    (await f.probe({ op: "apply", id: next.id, fingerprint: next.fingerprint })).code,
    "DELIVERY_REMOTE_CHANGED",
  );
  assert.equal((await f.read()).pushes, 1);
});
test("unknown push and PR outcomes reconcile exact remote identity without duplicate mutations", async (t) => {
  const f = await githubFixture(t);
  await f.save({ blockAfterPush: true });
  const push = await f.prepareKind("push");
  assert.equal(
    (await f.probe({ op: "apply", id: push.id, fingerprint: push.fingerprint })).state,
    "unknown",
  );
  await f.save({ offline: false });
  assert.equal((await f.probe({ op: "status", id: push.id })).state, "completed");
  assert.equal((await f.read()).pushes, 1);
  await f.save({ blockAfterCreate: true });
  const pr = await f.prepareKind("pr");
  assert.equal(
    (await f.probe({ op: "apply", id: pr.id, fingerprint: pr.fingerprint })).state,
    "unknown",
  );
  await f.save({ offline: false });
  const done = await f.probe({ op: "status", id: pr.id });
  assert.equal(done.state, "completed");
  assert.equal(done.pr.number, 7);
  const again = await f.prepareKind("pr");
  assert.equal(
    (await f.probe({ op: "apply", id: again.id, fingerprint: again.fingerprint })).state,
    "completed",
  );
  assert.equal((await f.read()).creates, 1);
  const seen = await f.probe({ op: "inspect" });
  assert.equal(seen.github.checksSha, (await f.read()).head);
  assert.equal(seen.github.checks[0].state, "failed");
  await f.save({ checksFail: true });
  const limited = await f.probe({ op: "inspect" });
  assert.equal(limited.github.state, "ok");
  assert(!limited.github.checksKnown);
  assert.equal(limited.github.pr.number, 7);
});
test("multiple or unrelated origin URLs cannot become a push destination", async (t) => {
  const f = await githubFixture(t);
  f.git("remote", "set-url", "--add", "--push", "origin", "https://github.com/Owner/Other.git");
  assert.equal((await f.probe({ op: "inspect" })).github.state, "no-remote");
  await assert.rejects(() => f.prepareKind("push"), /DELIVERY_REMOTE/);
  f.git("config", "--unset-all", "remote.origin.pushurl");
  f.git("remote", "set-url", "--add", "origin", "https://github.com/Owner/Other.git");
  assert.equal((await f.probe({ op: "inspect" })).github.state, "no-remote");
  assert.equal((await f.read()).pushes, 0);
});
