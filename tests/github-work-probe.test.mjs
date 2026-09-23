import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubWorkProbe } from "../packages/machines/dist/githubWorkProbe.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "github-work-")),
    repo = join(root, "repo"),
    bin = join(root, "bin"),
    statePath = join(root, "github.json"),
    log = join(root, "calls.jsonl");
  const previous = {
    PATH: process.env.PATH,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    GH_WORK_FIXTURE: process.env.GH_WORK_FIXTURE,
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(repo);
  await mkdir(bin);
  await writeFile(log, "");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/Owner/Project.git");
  const account = { id: 11, login: "Owner" },
    sha = "a".repeat(40);
  const issue = (n, type = "issue") => ({
    number: n,
    title: "Work " + n,
    body: "Exact original text",
    state: "open",
    user: account,
    created_at: "2026-09-13T00:00:00Z",
    updated_at: "2026-09-13T00:00:00Z",
    comments: 0,
    labels: [{ name: "bug" }],
    assignees: [account],
    repository_url: "https://api.github.com/repos/Owner/Project",
    ...(type === "pr"
      ? {
          pull_request: {},
          head: { ref: "feature", sha, repo: { full_name: "Owner/Project" } },
          base: { ref: "main" },
          requested_reviewers: [],
          merged: false,
        }
      : {}),
  });
  let state = {
    identity: account,
    access: "admin",
    repositoryId: 51,
    issues: [issue(1)],
    prs: [issue(2, "pr")],
    comments: [],
    collaborators: [],
    invitations: [],
    unavailable: false,
    drop: false,
    reject: 0,
  };
  const save = async (changes = {}) => {
    state = {
      ...JSON.parse(await readFile(statePath, "utf8").catch(() => JSON.stringify(state))),
      ...changes,
    };
    await writeFile(statePath, JSON.stringify(state));
  };
  await save();
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs=require('node:fs'),p=process.env.GH_WORK_FIXTURE,s=JSON.parse(fs.readFileSync(p,'utf8')),args=process.argv.slice(2),method=args[args.indexOf('--method')+1],endpoint=args.find(x=>x==='user'||x.startsWith('repos/')||x.startsWith('search/issues')),body=args.includes('--input')?JSON.parse(fs.readFileSync(0,'utf8')):undefined;
fs.appendFileSync(p.replace('github.json','calls.jsonl'),JSON.stringify({method,endpoint,body})+'\\n');
const answer=(status,value)=>{process.stdout.write('HTTP/2.0 '+status+' Test\\r\\nContent-Type: application/json\\r\\n\\r\\n'+(value==null?'':JSON.stringify(value)));if(status>=400)process.exitCode=1;};
const persist=()=>fs.writeFileSync(p,JSON.stringify(s));
const changed=value=>{persist();if(s.drop){s.unavailable=true;s.drop=false;persist();process.exitCode=1;return;}answer(value==null?204:201,value);};
const base='repos/Owner/Project',raw=endpoint?.split('?')[0],parts=raw?.split('/')||[],n=Number(parts[4]);
if(method!=='GET'&&s.reject){answer(s.reject,{});return;}
if(s.unavailable){answer(503,{});return;}
if(endpoint==='user'){answer(200,s.identity);return;}
if(raw===base){answer(s.access==='unavailable'?404:200,{id:s.repositoryId,full_name:'Owner/Project',has_issues:true,permissions:{admin:s.access==='admin',maintain:s.access==='maintain',push:s.access==='write',triage:s.access==='triage',pull:true}});return;}
if(endpoint?.startsWith('search/issues')){const q=new URLSearchParams(endpoint.split('?')[1]);answer(200,{items:q.get('q').includes('is:pr')?s.prs:s.issues});return;}
if(parts[3]==='commits'&&parts.length===4){answer(200,[{sha:'b'.repeat(40),commit:{message:'Exact commit\\nPrivate body not indexed',author:{name:'Unlinked author'},committer:{date:'2026-09-23T10:00:00Z'}},author:null}]);return;}
if(parts[3]==='pulls'&&parts.length===4){answer(200,s.prs);return;}
if(parts[3]==='issues'&&parts.length===4){if(method==='POST'){const value={...s.issues[0],number:100+s.issues.length,title:body.title,body:body.body,user:s.identity};s.issues.unshift(value);changed(value);}else answer(200,s.issues);return;}
if(parts[3]==='issues'&&parts[5]==='comments'){if(method==='POST'){const value={id:3000000000+s.comments.length,body:body.body,user:s.identity,created_at:'2026-09-13T01:00:00Z'};s.comments.push(value);changed(value);}else answer(200,s.comments);return;}
if(parts[3]==='issues'&&parts.length===5){const value=s.issues.find(x=>x.number===n)||s.prs.find(x=>x.number===n);if(!value){answer(404,{});return;}if(method==='PATCH'){value.state=body.state;changed(value);}else answer(200,value);return;}
if(parts[3]==='pulls'&&parts.length===5){answer(200,s.prs.find(x=>x.number===n));return;}
if(parts[3]==='pulls'&&parts[5]==='reviews'){answer(200,[{user:{login:'Friend'},state:'COMMENTED',commit_id:'a'.repeat(40)}]);return;}
if(parts[3]==='pulls'&&parts[5]==='requested_reviewers'){s.prs[0].requested_reviewers=body.reviewers.map(login=>({login}));changed(s.prs[0]);return;}
if(parts[3]==='commits'){answer(200,parts[5]==='check-runs'?{check_runs:[{name:'Local verification',head_sha:parts[4],conclusion:'success'}]}:{statuses:[]});return;}
if(parts[3]==='collaborators'&&parts.length===4){answer(200,s.collaborators);return;}
if(parts[3]==='collaborators'&&parts[5]==='permission'){const found=s.collaborators.find(v=>v.login.toLowerCase()===parts[4].toLowerCase());answer(found?200:404,found?{permission:found.permission,user:found}:{});return;}
if(parts[3]==='collaborators'&&method==='PUT'){const value={id:201,invitee:{id:12,login:parts[4]},permissions:body.permission};s.invitations.push(value);changed(value);return;}
if(parts[3]==='collaborators'&&method==='DELETE'){s.collaborators=s.collaborators.filter(v=>v.login!==parts[4]);changed(null);return;}
if(parts[3]==='invitations'){if(method==='DELETE'){s.invitations=s.invitations.filter(v=>v.id!==n);changed(null);}else answer(200,s.invitations);return;}
answer(400,{unexpected:endpoint});
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = bin + ":" + previous.PATH;
  process.env.LOCALAPPDATA = join(root, "private");
  process.env.GH_WORK_FIXTURE = statePath;
  const probe = (request) => githubWorkProbe(repo, { repository: "Owner/Project", ...request });
  const prepare = (input) => probe({ op: "prepare", id: randomUUID(), input });
  const apply = (v) => probe({ op: "apply", id: v.id, fingerprint: v.fingerprint });
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((v) => JSON.parse(v));
  return {
    root,
    repo,
    git,
    probe,
    prepare,
    apply,
    save,
    calls,
    issue,
    sha,
    get: async () => JSON.parse(await readFile(statePath, "utf8")),
  };
}
test("activity reads exact commits and Issue/PR status without bodies or mutations", async (t) => {
  const f = await fixture(t);
  const data = await f.probe({ op: "observe", query: { kind: "activity" } });
  assert.deepEqual(
    data.activity.map((v) => v.kind),
    ["commit", "issue", "pr"],
  );
  assert.equal(data.activity[0].author, null);
  assert.equal(data.activity[0].url, "https://github.com/Owner/Project/commit/" + "b".repeat(40));
  assert.equal(data.activity[0].title, "Exact commit");
  assert(!JSON.stringify(data.activity).includes("Private body"));
  assert(!JSON.stringify(data.activity).includes("Exact original text"));
  assert((await f.calls()).every((v) => v.method === "GET"));
  await f.save({ access: "unavailable" });
  await assert.rejects(
    f.probe({ op: "observe", query: { kind: "activity" } }),
    /GITHUB_WORK_ACCESS/,
  );
});
test("machine-local GitHub identity, bounded issue search and exact PR SHA/reviews/checks are normalized", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.probe({ op: "observe", query: { kind: "identity" } })).identity.login,
    "Owner",
  );
  const list = await f.probe({
    op: "observe",
    query: {
      kind: "list",
      type: "issue",
      state: "open",
      query: "repo:Other/Secret OR is:pr",
      page: 1,
    },
  });
  assert.equal(list.items[0].type, "issue");
  const query = (await f.calls()).find((v) => v.endpoint.startsWith("search/"));
  assert(!decodeURIComponent(query.endpoint).includes("repo:Other"));
  const pr = await f.probe({
    op: "observe",
    query: { kind: "detail", type: "pr", number: 2, page: 1 },
  });
  assert.equal(pr.record.head.sha, f.sha);
  assert.equal(pr.record.author.login, "Owner");
  assert.equal(pr.record.reviews[0].sha, f.sha);
  assert.equal(pr.record.checks[0].sha, f.sha);
  assert.equal((await f.calls()).filter((v) => v.method !== "GET").length, 0);
  await f.save({ identity: { id: 12, login: "Friend" }, access: "read" });
  assert.equal(
    (await f.probe({ op: "observe", query: { kind: "identity" } })).identity.login,
    "Friend",
  );
});
test("explicit issue and comment preserve acting authorship and machine receipt identity", async (t) => {
  const f = await fixture(t);
  await f.save({ identity: { id: 12, login: "Friend" }, access: "write" });
  const op = await f.prepare({
    kind: "issue-create",
    title: "Reviewed task",
    body: "Deliberate checkpoint",
  });
  assert.equal((await f.calls()).filter((v) => v.method !== "GET").length, 0);
  const done = await f.apply(op);
  assert.equal(done.state, "completed");
  assert.match(done.result.url, /\/issues\/101$/);
  assert.equal((await f.get()).issues[0].user.login, "Friend");
  assert.deepEqual(await f.apply(op), done);
  await assert.rejects(
    f.probe({ op: "prepare", id: op.id, input: { ...op.input, title: "Different" } }),
    /GITHUB_WORK_KEY/,
  );
  const comment = await f.prepare({
    kind: "comment",
    number: 1,
    type: "issue",
    body: "Selected result",
  });
  const saved = await f.apply(comment);
  assert.equal(saved.state, "completed");
  assert(saved.result.url.endsWith("#issuecomment-3000000000"));
  assert.equal((await f.calls()).filter((v) => v.method === "POST").length, 2);
});
test("lost external acknowledgement remains unknown after restart and reconciles exact issue/comment without replay", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { kind: "issue-create", title: "Unknown issue", body: "Original" },
    { kind: "comment", type: "pr", number: 2, body: "Unknown comment" },
  ]) {
    const op = await f.prepare(input);
    await f.save({ drop: true });
    assert.equal((await f.apply(op)).state, "unknown");
    await f.save({ unavailable: false });
    const before = (await f.calls()).filter((v) => v.method !== "GET").length;
    const checked = await f.probe({ op: "status", id: op.id });
    assert.equal(checked.state, "completed");
    assert.equal((await f.calls()).filter((v) => v.method !== "GET").length, before);
  }
});
test("unconfirmed create blocks a fresh operation and a changed GitHub account never receives a retry", async (t) => {
  const f = await fixture(t),
    op = await f.prepare({ kind: "issue-create", title: "One", body: "Exact" });
  await f.save({ drop: true });
  assert.equal((await f.apply(op)).state, "unknown");
  await f.save({ unavailable: false, identity: { id: 12, login: "Friend" } });
  assert.equal((await f.probe({ op: "status", id: op.id })).state, "unknown");
  await assert.rejects(f.prepare(op.input), /GITHUB_WORK_UNKNOWN/);
  assert.equal((await f.calls()).filter((v) => v.method !== "GET").length, 1);
});
test("collaborator invitation and removal are separate admin-only actions with existing/pending reconciliation", async (t) => {
  const f = await fixture(t);
  await f.save({ access: "write" });
  await assert.rejects(
    f.prepare({ kind: "invite", login: "Friend", permission: "push" }),
    /GITHUB_WORK_ACCESS/,
  );
  await f.save({ access: "admin" });
  const op = await f.prepare({ kind: "invite", login: "Friend", permission: "push" });
  await f.save({ drop: true });
  assert.equal((await f.apply(op)).state, "unknown");
  await f.save({ unavailable: false });
  assert.equal((await f.probe({ op: "status", id: op.id })).result.state, "pending");
  const other = await f.prepare(op.input);
  assert.equal((await f.apply(other)).result.state, "pending");
  assert.equal((await f.get()).invitations.length, 1);
  const removal = await f.prepare({ kind: "remove", login: "Friend" });
  assert.equal((await f.apply(removal)).result.state, "absent");
  await f.save({
    collaborators: [{ id: 12, login: "Friend", permission: "write", role_name: "write" }],
  });
  assert.equal((await f.apply(await f.prepare(op.input))).result.state, "accepted");
  assert.equal((await f.calls()).filter((v) => v.method === "PUT").length, 1);
});
test("changed SHA, issue state, account or repository rejects stale action before any external write", async (t) => {
  const f = await fixture(t),
    op = await f.prepare({ kind: "comment", type: "pr", number: 2, body: "Exact head" });
  const state = await f.get();
  state.prs[0].head.sha = "b".repeat(40);
  await f.save(state);
  assert.equal((await f.apply(op)).code, "GITHUB_WORK_CHANGED");
  const next = await f.prepare({ kind: "issue-state", number: 1, state: "closed" });
  await f.save({ identity: { id: 12, login: "Friend" } });
  assert.equal((await f.apply(next)).code, "GITHUB_WORK_IDENTITY_CHANGED");
  f.git("remote", "set-url", "origin", "https://github.com/Other/Repo.git");
  await assert.rejects(
    f.probe({ op: "observe", query: { kind: "identity" } }),
    /GITHUB_WORK_REPOSITORY/,
  );
  assert.equal((await f.calls()).filter((v) => v.method !== "GET").length, 0);
});
test("issue state and review request are explicit typed operations; rechecking never repeats them", async (t) => {
  const f = await fixture(t);
  const closed = await f.apply(
    await f.prepare({ kind: "issue-state", number: 1, state: "closed" }),
  );
  assert.equal(closed.result.state, "closed");
  const opened = await f.apply(await f.prepare({ kind: "issue-state", number: 1, state: "open" }));
  assert.equal(opened.result.state, "open");
  const op = await f.prepare({ kind: "request-review", number: 2, login: "Friend" });
  assert.equal((await f.apply(op)).result.state, "requested");
  const count = (await f.calls()).filter((v) => v.method !== "GET").length;
  await f.probe({ op: "status", id: op.id });
  assert.equal((await f.calls()).filter((v) => v.method !== "GET").length, count);
  await f.save({ reject: 403 });
  const rejected = await f.apply(
    await f.prepare({ kind: "comment", type: "issue", number: 1, body: "Denied" }),
  );
  assert.equal(rejected.state, "failed");
});
test("fixed worker rejects caller endpoints, path escapes, executable hijacks and unknown parameters", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.probe({ op: "observe", query: { kind: "identity", endpoint: "user/repos" } }),
    /GITHUB_WORK_REQUEST/,
  );
  await assert.rejects(
    f.probe({
      op: "prepare",
      id: randomUUID(),
      input: { kind: "issue-create", title: "Bad", body: "x", command: "whoami" },
    }),
    /GITHUB_WORK_REQUEST/,
  );
  const sub = join(f.repo, "sub");
  await mkdir(sub);
  await assert.rejects(
    githubWorkProbe(sub, {
      op: "observe",
      repository: "Owner/Project",
      query: { kind: "identity" },
    }),
    /GITHUB_WORK_PATH/,
  );
  const link = join(f.root, "alias");
  await symlink(f.repo, link);
  await assert.rejects(
    githubWorkProbe(link, {
      op: "observe",
      repository: "Owner/Project",
      query: { kind: "identity" },
    }),
    /GITHUB_WORK_PATH/,
  );
});

test("concurrent stale-lock recovery never admits two GitHub writers", async (t) => {
  const f = await fixture(t);
  // The fixture stores receipts under its root's LOCALAPPDATA.
  const state = join(process.env.LOCALAPPDATA, "CodexWeb", "github-state");
  await mkdir(state, { recursive: true });
  const deadPid = Number(
    execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }),
  );
  const lock = join(
    state,
    createHash("sha256").update(JSON.stringify("owner/project")).digest("hex") + ".lock",
  );
  await writeFile(lock, String(deadPid));
  const results = await Promise.allSettled([
    f.prepare({ kind: "issue-create", title: "One", body: "one" }),
    f.prepare({ kind: "issue-create", title: "Two", body: "two" }),
  ]);
  assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(results.filter((v) => v.status === "rejected").length, 1);
  assert.equal((await f.calls()).filter((c) => c.method !== "GET").length, 0);
  assert.equal(
    (await f.prepare({ kind: "issue-create", title: "Next", body: "after release" })).state,
    "prepared",
  );
});
