import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubWorkProbe } from "../packages/machines/dist/githubWorkProbe.js";

test("Write grants bind the recipient numeric identity across preparation and application", async (t) => {
  const f = await fixture(t);
  const input = { kind: "invite", login: "Friend", permission: "push", targetId: 12 };
  const p = await f.prepare(input);
  await f.save({ targetId: 99 });
  assert.equal((await f.apply(p)).state, "failed");
  assert.equal((await f.calls()).filter((c) => c.method !== "GET").length, 0);
  await assert.rejects(f.prepare(input), /GITHUB_WORK_IDENTITY_CHANGED/);
  await f.save({ targetId: 12 });
  const granted = await f.apply(await f.prepare(input));
  assert.equal(granted.state, "completed");
  assert.equal(granted.result.state, "pending");
  await f.save({
    invitations: [],
    collaborators: [{ id: 99, login: "Friend", permission: "write" }],
  });
  assert.equal((await f.apply(await f.prepare(input))).state, "failed");
  assert.equal((await f.calls()).filter((c) => c.method !== "GET").length, 1);
});

test("recipient accepts only exact Write invitation and reconciles lost acknowledgement without replay", async (t) => {
  const f = await fixture(t);
  const input = {
    kind: "accept-invitation",
    targetRepository: "Author/Shared",
    repositoryId: 77,
    identityId: 11,
  };
  const invitation = {
    id: 301,
    permissions: "write",
    invitee: { id: 11, login: "Owner" },
    repository: { id: 77, full_name: "Author/Shared" },
  };
  await f.save({
    access: "read",
    received: [{ ...invitation, invitee: { id: 99, login: "Other" } }],
  });
  assert.equal((await f.apply(await f.prepare(input))).state, "failed");
  assert.equal((await f.calls()).filter((c) => c.method !== "GET").length, 0);
  await assert.rejects(f.prepare({ ...input, identityId: 99 }), /GITHUB_WORK_IDENTITY_CHANGED/);
  await f.save({ received: [invitation], drop: true });
  const p = await f.prepare(input);
  assert.equal((await f.apply(p)).state, "unknown");
  await f.save({ unavailable: false });
  assert.equal((await f.probe({ op: "status", id: p.id })).state, "completed");
  assert.equal((await f.apply(p)).state, "completed");
  assert.deepEqual(
    (await f.calls()).filter((c) => c.method !== "GET").map((c) => c.endpoint),
    ["user/repository_invitations/301"],
  );
});

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
const fs=require('node:fs'),p=process.env.GH_WORK_FIXTURE,s=JSON.parse(fs.readFileSync(p,'utf8')),args=process.argv.slice(2),method=args[args.indexOf('--method')+1],endpoint=args.find(x=>x==='graphql'||x==='user'||x.startsWith('user/')||x.startsWith('users/')||x.startsWith('repos/')||x.startsWith('search/issues')),body=args.includes('--input')?JSON.parse(fs.readFileSync(0,'utf8')):undefined;
fs.appendFileSync(p.replace('github.json','calls.jsonl'),JSON.stringify({method,endpoint,body})+'\\n');
const answer=(status,value)=>{process.stdout.write('HTTP/2.0 '+status+' Test\\r\\nContent-Type: application/json\\r\\n\\r\\n'+(value==null?'':JSON.stringify(value)));if(status>=400)process.exitCode=1;};
const persist=()=>fs.writeFileSync(p,JSON.stringify(s));
const changed=value=>{persist();if(s.replyLostAt===raw){s.replyLostAt=null;persist();process.exitCode=1;return;}if(s.drop || s.dropEndpoint===raw){s.dropEndpoint=null;s.unavailable=true;s.drop=false;persist();process.exitCode=1;return;}answer(value==null?204:201,value);};
const base='repos/Owner/Project',raw=endpoint?.split('?')[0],parts=raw?.split('/')||[],n=Number(parts[4]);
if(method!=='GET'&&s.reject){answer(s.reject,{});return;}
if(s.unavailable){answer(503,{});return;}
if(endpoint==='user'){answer(200,s.identity);return;}
if(raw==='users/Friend'){answer(200,{id:s.targetId||12,login:'Friend'});return;}
if(raw==='repos/Author/Shared'){answer(s.targetAccepted?200:404,{id:77,full_name:'Author/Shared',permissions:{push:true}});return;}
if(raw==='user/repository_invitations'){answer(200,s.received||[]);return;}
if(raw==='user/repository_invitations/301'&&method==='PATCH'){s.targetAccepted=true;s.received=[];changed(null);return;}
if(raw===base){answer(s.access==='unavailable'?404:200,{id:s.repositoryId,node_id:'R_Test',full_name:'Owner/Project',default_branch:'main',has_issues:true,permissions:{admin:s.access==='admin',maintain:s.access==='maintain',push:s.access==='write',triage:s.access==='triage',pull:true}});return;}
if(s.preparation){
const crypto=require('node:crypto'),blob=content=>{const b=Buffer.from(content,'base64');return crypto.createHash('sha1').update('blob '+b.length+'\\0').update(b).digest('hex');};
const commit=(branch,message,files,parent)=>{const sha=crypto.createHash('sha1').update(message+JSON.stringify(files)).digest('hex'),tree={...(s.commits[parent]?.tree||{}),...Object.fromEntries(files.map(f=>[f.path,f.content]))};for(const f of files)if(f.content===null)delete tree[f.path];s.commits[sha]={sha,commit:{message},parents:parent?[{sha:parent}]:[],author:s.identity,tree};s.refs[branch]=sha;return sha;};

const cp=require('node:child_process'),git=(args,input)=>cp.execFileSync('git',args,{input,encoding:'utf8'}).trim();
const makeTree=entries=>{const dirs=new Map([['',[]]]);for(const e of entries){const parts=e.path.split('/'),name=parts.pop();let dir='';for(const p of parts){dir=dir?dir+'/'+p:p;if(!dirs.has(dir))dirs.set(dir,[]);}dirs.get(parts.join('/')).push({...e,path:name});}let root;for(const dir of [...dirs.keys()].sort((a,b)=>b.length-a.length)){const sha=git(['mktree','--missing'],dirs.get(dir).map(e=>e.mode+' '+e.type+' '+e.sha+'\\t'+e.path+'\\n').join(''));if(!dir)root=sha;else{const parts=dir.split('/'),name=parts.pop();dirs.get(parts.join('/')).push({path:name,sha,type:'tree',mode:'040000'});}}return root;};
const listTree=sha=>git(['ls-tree','-r','-t',sha]).split('\\n').filter(Boolean).map(line=>{const [metadata,...name]=line.split('\\t'),[mode,type,sha]=metadata.split(' ');return {mode,type,sha,path:name.join('\\t')};});
const initialTree=commit=>makeTree(Object.entries(commit.tree).map(([path,content])=>({path,type:(s.modes?.[path]==='160000'?'commit':'blob'),mode:s.modes?.[path]||'100644',sha:git(['hash-object','-w','--stdin'],Buffer.from(content,'base64'))})));
if(parts[3]==='git'&&parts[4]==='commits'){
 if(method==='POST'){const person=a=>a.name+' <'+a.email+'> '+Math.floor(new Date(a.date).getTime()/1000)+' +0000',raw='tree '+body.tree+'\\nparent '+body.parents[0]+'\\nauthor '+person(body.author)+'\\ncommitter '+person(body.committer)+'\\n\\n'+body.message,sha=git(['hash-object','-t','commit','-w','--stdin'],raw);s.gitCommits={...s.gitCommits,[sha]:{sha,tree:{sha:body.tree},parents:body.parents.map(sha=>({sha}))}};changed(s.gitCommits[sha]);return;}
 const c=s.gitCommits?.[parts[5]] || s.commits[parts[5]];answer(c?200:404,c?(c.commit?{sha:parts[5],tree:{sha:initialTree(c)}}:c):{});return;
}
if(parts[3]==='git'&&parts[4]==='trees'){
 if(method==='POST'){const sha=makeTree(body.tree);changed({sha});return;}
 try{answer(200,{sha:parts[5],tree:listTree(parts[5]),truncated:!!s.truncated});}catch{answer(404,{});}return;
}
if(parts[3]==='git'&&parts[4]==='blobs'){
 try{const content=cp.execFileSync('git',['cat-file','blob',parts[5]]);answer(200,{sha:parts[5],size:content.length,encoding:'base64',content:content.toString('base64')});}catch{answer(404,{});}return;
}
if(endpoint==='graphql'&&body.variables.input.refUpdates){const r=body.variables.input.refUpdates[0],branch=r.name.replace('refs/heads/','');if(s.refs[branch]!==r.beforeOid){answer(200,{errors:[{type:'STALE_DATA'}]});return;}s.refs[branch]=r.afterOid;changed({data:{updateRefs:{clientMutationId:null}}});return;}
if(parts[3]==='commits'&&parts.length===5){const ref=decodeURIComponent(parts[4]),sha=s.refs[ref]||ref,c=s.commits[sha];answer(c?200:409,c||{message:'Git Repository is empty.'});return;}
if(parts[3]==='git'&&parts[4]==='ref'){const ref=decodeURIComponent(parts.slice(6).join('/'));answer(s.refs[ref]?200:404,{object:{sha:s.refs[ref]}});return;}
if(parts[3]==='git'&&parts[4]==='refs'&&method==='POST'){s.refs[body.ref.replace('refs/heads/','')]=body.sha;changed({object:{sha:body.sha}});return;}
if(parts[3]==='contents'){const name=parts.slice(4).map(decodeURIComponent).join('/');if(method==='PUT'){const sha=commit(body.branch,body.message,[{path:name,content:body.content}],null);changed({commit:{sha}});return;}const ref=new URLSearchParams(endpoint.split('?')[1]).get('ref'),content=s.commits[ref]?.tree[name];if(content===undefined){const prefix=name?name+'/':'',entries=[...new Set(Object.keys(s.commits[ref]?.tree||{}).filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length).split('/')[0]))].map(v=>({name:v,path:prefix+v,type:Object.hasOwn(s.commits[ref]?.tree||{},prefix+v)?'file':'dir'}));if(entries.length || !name){answer(200,entries);return;}}answer(content===undefined?404:200,{type:'file',path:name,sha:content===undefined?undefined:blob(content),size:content===undefined?0:Buffer.from(content,'base64').length,encoding:'base64',content});return;}
if(endpoint==='graphql'){const v=body.variables.input,branch=v.branch.branchName;if(s.refs[branch]!==v.expectedHeadOid){answer(200,{errors:[{type:'STALE_DATA'}]});return;}const oid=commit(branch,v.message.headline+'\\n\\n'+v.message.body,[...(v.fileChanges.additions||[]).map(f=>({path:f.path,content:f.contents})),...(v.fileChanges.deletions||[]).map(f=>({path:f.path,content:null}))],v.expectedHeadOid);changed({data:{createCommitOnBranch:{commit:{oid}}}});return;}
if(parts[3]==='pulls'&&parts.length===4&&method==='POST'){const value={number:78,user:s.identity,title:body.title,body:body.body,head:{sha:s.refs[body.head],ref:body.head,repo:{full_name:'Owner/Project'}},base:{ref:body.base},state:'open'};s.prs.push(value);changed(value);return;}
}
if(endpoint?.startsWith('search/issues')){const q=new URLSearchParams(endpoint.split('?')[1]);answer(200,{items:q.get('q').includes('is:pr')?s.prs:s.issues});return;}
if(parts[3]==='commits'&&parts.length===4){answer(200,[{sha:'b'.repeat(40),commit:{message:'Exact commit\\nPrivate body not indexed',author:{name:'Unlinked author'},committer:{date:'2026-09-23T10:00:00Z'}},author:null}]);return;}
if(parts[3]==='commits'&&parts.length===5){answer(200,{sha:parts[4],commit:{message:'Exact change'},parents:[{sha:'c'.repeat(40)}],stats:{additions:1,deletions:0},files:[{filename:'src/nullable.ts',status:'modified',additions:1,deletions:0,patch:'+ nullable: true'}]});return;}
if(parts[3]==='pulls'&&parts[5]==='files'){if(s.moveHead){s.prs[0].head.sha='d'.repeat(40);persist();}answer(200,[{filename:'src/pr.ts',status:'modified',patch:'+ tested',additions:1,deletions:0}]);return;}
if(parts[3]==='pulls'&&parts.length===4){answer(200,s.prs);return;}
if(parts[3]==='issues'&&parts.length===4){if(method==='POST'){const value={...s.issues[0],number:100+s.issues.length,title:body.title,body:body.body,user:s.identity};s.issues.unshift(value);changed(value);}else answer(200,s.issues);return;}
if(parts[3]==='issues'&&parts[5]==='comments'){if(method==='POST'){const value={id:3000000000+s.comments.length,body:body.body,user:s.identity,created_at:'2026-09-13T01:00:00Z'};s.comments.push(value);changed(value);}else answer(200,s.comments);return;}
if(parts[3]==='issues'&&parts.length===5){const value=s.issues.find(x=>x.number===n)||s.prs.find(x=>x.number===n);if(!value){answer(404,{});return;}if(method==='PATCH'){value.state=body.state;changed(value);}else answer(200,value);return;}
if(parts[3]==='pulls'&&parts.length===5){answer(200,s.prs.find(x=>x.number===n));return;}
if(parts[3]==='pulls'&&parts[5]==='reviews'){answer(200,[{user:{login:'Friend'},state:'COMMENTED',commit_id:'a'.repeat(40)}]);return;}
if(parts[3]==='pulls'&&parts[5]==='requested_reviewers'){s.prs[0].requested_reviewers=body.reviewers.map(login=>({login}));changed(s.prs[0]);return;}
if(parts[3]==='commits'){answer(200,parts[5]==='check-runs'?{total_count:1,check_runs:[{id:s.checkRun||9,name:'Local verification',head_sha:parts[4],conclusion:s.checkState||'success'}]}:{sha:parts[4],total_count:0,statuses:[]});return;}
if(parts[3]==='collaborators'&&parts.length===4){answer(200,s.collaborators);return;}
if(parts[3]==='collaborators'&&parts[5]==='permission'){const found=s.collaborators.find(v=>v.login.toLowerCase()===parts[4].toLowerCase());answer(found?200:404,found?{permission:found.permission,user:found}:{});return;}
if(parts[3]==='collaborators'&&method==='PUT'){const found=s.collaborators.find(v=>v.login.toLowerCase()===parts[4].toLowerCase());if(found){found.permission=body.permission==='push'?'write':body.permission;changed(null);return;}const value={id:201,invitee:{id:12,login:parts[4]},permissions:body.permission};s.invitations.push(value);changed(value);return;}
if(parts[3]==='collaborators'&&method==='DELETE'){s.collaborators=s.collaborators.filter(v=>v.login!==parts[4]);changed(null);return;}
if(parts[3]==='invitations'){if(method==='DELETE'){s.invitations=s.invitations.filter(v=>v.id!==n);changed(null);}else if(method==='PATCH'){const value=s.invitations.find(v=>v.id===n);value.permissions=body.permissions;changed(value);}else answer(200,s.invitations);return;}
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
test("bounded activity evidence reads exact immutable commits and rechecks PR head", async (t) => {
  const f = await fixture(t);
  for (const source of ["commit:" + "b".repeat(40), "issue:1", "pr:2"]) {
    const value = await f.probe({ op: "observe", query: { kind: "evidence", source } });
    assert.equal(value.evidence.source, source);
    assert(value.evidence.text.length <= 18000);
    if (source.startsWith("commit")) {
      assert.match(value.evidence.text, /nullable/);
      assert.equal(value.commit.sha, "b".repeat(40));
      assert.match(value.commit.files[0].patch, /nullable/);
      assert(value.commit.files.every((v) => v.patch.length <= 3000));
    }
    if (source.startsWith("pr")) assert.match(value.evidence.text, /tested/);
  }
  assert((await f.calls()).every((v) => v.method === "GET"));
  assert.equal(
    (await f.calls()).filter((v) => v.endpoint === "repos/Owner/Project/pulls/2").length,
    2,
  );
  await assert.rejects(
    f.probe({ op: "observe", query: { kind: "evidence", source: "commit:main" } }),
    /GITHUB_WORK_REQUEST/,
  );
  await f.save({ moveHead: true });
  await assert.rejects(
    f.probe({ op: "observe", query: { kind: "evidence", source: "pr:2" } }),
    /GITHUB_WORK_CHANGED/,
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
test("collaborator access raises insufficient roles, preserves stronger roles and reconciles lost upgrade acknowledgements", async (t) => {
  const f = await fixture(t);
  await f.save({ collaborators: [{ id: 12, login: "Friend", permission: "read" }] });
  const upgrade = await f.prepare({ kind: "invite", login: "Friend", permission: "push" });
  await f.save({ drop: true });
  assert.equal((await f.apply(upgrade)).state, "unknown");
  await f.save({ unavailable: false });
  assert.equal((await f.probe({ op: "status", id: upgrade.id })).result.state, "accepted");
  assert.equal((await f.get()).collaborators[0].permission, "write");
  assert.equal((await f.calls()).filter((v) => v.method === "PUT").length, 1);
  await f.save({ collaborators: [{ id: 12, login: "Friend", permission: "admin" }] });
  assert.equal((await f.apply(await f.prepare(upgrade.input))).result.state, "accepted");
  assert.equal((await f.get()).collaborators[0].permission, "admin");
  assert.equal((await f.calls()).filter((v) => v.method === "PUT").length, 1);
  await f.save({
    collaborators: [],
    invitations: [{ id: 201, invitee: { id: 12, login: "Friend" }, permissions: "read" }],
  });
  assert.equal((await f.apply(await f.prepare(upgrade.input))).result.state, "pending");
  assert.equal((await f.get()).invitations[0].permissions, "write");
  assert.equal((await f.get()).invitations.length, 1);
  assert.equal((await f.calls()).filter((v) => v.method === "PATCH").length, 1);
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

test("machine account bootstrap needs no checkout and cannot perform repository writes", async (t) => {
  const f = await fixture(t);
  const identity = await githubWorkProbe(null, {
    op: "observe",
    repository: "",
    query: { kind: "identity" },
  });
  assert.deepEqual(identity.identity, { id: 11, login: "Owner" });
  assert.equal(identity.repositoryId, null);
  await assert.rejects(
    githubWorkProbe(null, {
      op: "observe",
      repository: "Owner/Project",
      query: { kind: "issues" },
    }),
  );
  await assert.rejects(
    githubWorkProbe(null, {
      op: "prepare",
      repository: "Owner/Project",
      id: randomUUID(),
      input: { kind: "invite", login: "Friend", permission: "push", targetId: 12 },
    }),
  );
  await f.save({
    received: [
      {
        id: 301,
        permissions: "write",
        invitee: { id: 11, login: "Owner" },
        repository: { id: 77, full_name: "Author/Shared" },
      },
    ],
  });
  const request = { repository: "Author/Shared", id: randomUUID() };
  const prepared = await githubWorkProbe(null, {
    ...request,
    op: "prepare",
    input: {
      kind: "accept-invitation",
      targetRepository: "Author/Shared",
      repositoryId: 77,
      identityId: 11,
    },
  });
  const applied = await githubWorkProbe(null, {
    ...request,
    op: "apply",
    fingerprint: prepared.fingerprint,
  });
  assert.equal(applied.state, "completed");
  assert.equal((await githubWorkProbe(null, { ...request, op: "status" })).state, "completed");
  assert.deepEqual(
    (await f.calls()).filter((c) => c.method !== "GET").map((c) => c.endpoint),
    ["user/repository_invitations/301"],
  );
});

const preparationBranch = () => `codexweb/prepare/${randomUUID()}`;
const encoded = (text) => Buffer.from(text).toString("base64");
async function preparationFixture(t, empty = false) {
  const f = await fixture(t),
    head = "a".repeat(40);
  await f.save({
    preparation: true,
    refs: empty ? {} : { main: head },
    commits: empty
      ? {}
      : {
          [head]: {
            sha: head,
            commit: { message: "Existing" },
            parents: [],
            author: { id: 11, login: "Owner" },
            tree: { "README.md": encoded("Original\r\n"), "AGENTS.md": encoded("Keep policy") },
          },
        },
  });
  return f;
}
test("preparation observes immutable docs, creates isolated atomic package and reconciles lost file acknowledgement without replay", async (t) => {
  const f = await preparationFixture(t),
    branch = preparationBranch();
  const repo = await f.probe({
    op: "observe",
    query: { kind: "preparation", paths: ["README.md", "AGENTS.md", "docs/NEW.md"] },
  });
  assert.equal(repo.preparation.files[0].content, "Original\r\n");
  assert.equal(repo.preparation.files[2].sha, null);
  assert((await f.calls()).every((v) => v.method === "GET"));
  assert.equal(
    (await f.apply(await f.prepare({ kind: "preparation-branch", branch, head: f.sha }))).state,
    "completed",
  );
  const files = [
    {
      path: "README.md",
      content: encoded("Reviewed\r\n"),
      previous: repo.preparation.files[0].sha,
    },
    { path: "docs/NEW.md", content: encoded("New"), previous: null },
  ];
  const p = await f.prepare({
    kind: "preparation-files",
    branch,
    head: f.sha,
    title: "Reviewed package",
    files,
  });
  await f.save({ drop: true });
  assert.equal((await f.apply(p)).state, "unknown");
  await f.save({ unavailable: false });
  const r = await f.probe({ op: "status", id: p.id });
  assert.equal(r.state, "completed");
  assert.equal((await f.apply(p)).state, "completed");
  assert.equal((await f.get()).refs.main, f.sha);
  assert.equal((await f.calls()).filter((v) => v.endpoint === "graphql").length, 1);
  const pr = await f.prepare({
    kind: "preparation-pr",
    branch,
    head: r.result.sha,
    base: "main",
    title: "Reviewed package",
    body: "Docs",
  });
  await f.save({ drop: true });
  assert.equal((await f.apply(pr)).state, "unknown");
  await f.save({ unavailable: false });
  assert.equal((await f.probe({ op: "status", id: pr.id })).result.number, 78);
  assert.equal((await f.apply(pr)).state, "completed");
  assert.equal(
    (await f.calls()).filter((v) => v.method === "POST" && v.endpoint.endsWith("/pulls")).length,
    1,
  );
});
test("preparation refuses stale heads, identity changes, policy files, path aliases and default-branch writes", async (t) => {
  const f = await preparationFixture(t),
    branch = preparationBranch(),
    file = { path: "docs/a.md", content: encoded("a"), previous: null };
  for (const path of ["AGENTS.md", "docs/agents.md", "CODEXWEB.md", "docs/../x.md", "docs/CON.txt"])
    await assert.rejects(
      f.prepare({
        kind: "preparation-files",
        branch,
        head: f.sha,
        title: "x",
        files: [{ ...file, path }],
      }),
      /GITHUB_WORK_REQUEST/,
    );
  await assert.rejects(
    f.prepare({
      kind: "preparation-files",
      branch,
      head: f.sha,
      title: "x",
      files: [file, { ...file, path: "docs/A.md" }],
    }),
    /GITHUB_WORK_REQUEST/,
  );
  await assert.rejects(
    f.prepare({
      kind: "preparation-files",
      branch: "main",
      head: f.sha,
      title: "x",
      files: [file],
    }),
    /GITHUB_WORK_CHANGED/,
  );
  await assert.rejects(
    f.probe({ op: "observe", query: { kind: "preparation", paths: ["readme.md"] } }),
    /GITHUB_WORK_CHANGED/,
  );
  const p = await f.prepare({ kind: "preparation-branch", branch, head: f.sha });
  await f.save({ identity: { id: 99, login: "Other" } });
  assert.equal((await f.apply(p)).state, "failed");
  assert((await f.calls()).every((v) => v.method === "GET"));
  await f.save({
    identity: { id: 11, login: "Owner" },
    refs: { main: "b".repeat(40) },
    commits: { ["b".repeat(40)]: { sha: "b".repeat(40), tree: {} } },
  });
  await assert.rejects(
    f.prepare({ kind: "preparation-branch", branch: preparationBranch(), head: f.sha }),
    /GITHUB_WORK_CHANGED/,
  );
});
test("empty repository uses a single seed then an expected-head atomic commit, bound to its seed receipt", async (t) => {
  const f = await preparationFixture(t, true),
    file = { path: "README.md", content: encoded("Hello"), previous: null };
  const seed = await f.prepare({ kind: "preparation-seed", branch: "main", file, title: "Start" });
  const r = await f.apply(seed);
  assert.equal(r.state, "completed");
  const next = await f.prepare({
    kind: "preparation-files",
    branch: "main",
    head: r.result.sha,
    title: "Docs",
    files: [{ ...file, path: "docs/NEW.md" }],
  });
  assert.equal((await f.apply(next)).state, "completed");
  await assert.rejects(
    f.prepare({ kind: "preparation-seed", branch: "main", file, title: "Again" }),
    /GITHUB_WORK_CHANGED/,
  );
  assert.equal((await f.calls()).filter((v) => v.method !== "GET").length, 2);
});

test("activity attention uses numeric recipients and bounded head-specific checks", async (t) => {
  const f = await fixture(t);
  await f.save({ checkState: "failure" });
  let value = await f.probe({ op: "observe", query: { kind: "activity" } });
  assert.equal(value.activity.find((v) => v.kind === "issue").attention[0].kind, "assigned");
  const pr = value.activity.find((v) => v.kind === "pr");
  assert.equal(pr.checks.state, "failure");
  assert.equal(pr.checks.sha, "a".repeat(40));
  assert(pr.attention.some((v) => v.kind === "checks"));
  const old = pr.attention.find((v) => v.kind === "checks").version;
  await f.save({ checkRun: 10 });
  value = await f.probe({ op: "observe", query: { kind: "activity" } });
  assert.notEqual(
    value.activity.find((v) => v.kind === "pr").attention.find((v) => v.kind === "checks").version,
    old,
  );
  await f.save({ identity: { id: 999, login: "Owner" } });
  value = await f.probe({ op: "observe", query: { kind: "activity" } });
  assert(
    value.activity.every((v) => !v.attention?.length),
    "same login cannot impersonate numeric assignee/author",
  );
  await f.save({ identity: { id: 11, login: "Owner" }, checkState: "success" });
  value = await f.probe({ op: "observe", query: { kind: "activity" } });
  assert.equal(value.activity.find((v) => v.kind === "pr").checks.state, "success");
  assert(!value.activity.find((v) => v.kind === "pr").attention.some((v) => v.kind === "checks"));
  assert((await f.calls()).every((c) => c.method === "GET"));
});

test("direct repository files read immutable sources and commit any text path on the chosen branch exactly once", async (t) => {
  const f = await preparationFixture(t);
  const listing = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "", path: "" },
  });
  assert.equal(listing.repositoryFiles.branch, "main");
  assert(listing.repositoryFiles.entries.some((v) => v.path === "AGENTS.md"));
  const read = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "AGENTS.md" },
  });
  const file = read.repositoryFiles.file;
  const input = {
    kind: "repository-file",
    branch: "main",
    head: f.sha,
    title: "Manual policy edit",
    files: [{ path: file.path, previous: file.sha, content: encoded("Owner reviewed\r\n") }],
  };
  const p = await f.prepare(input);
  await f.save({ drop: true });
  assert.equal((await f.apply(p)).state, "unknown");
  await f.save({ unavailable: false });
  const done = await f.probe({ op: "status", id: p.id });
  assert.equal(done.state, "completed");
  assert.equal((await f.apply(p)).state, "completed");
  const state = await f.get();
  assert.equal(state.refs.main, done.result.sha);
  assert.equal(state.commits[state.refs.main].tree["AGENTS.md"], input.files[0].content);
  assert.equal(state.commits[state.refs.main].tree["README.md"], encoded("Original\r\n"));
  assert.equal((await f.calls()).filter((v) => v.endpoint === "graphql").length, 1);
});

test("direct repository file edits refuse stale heads, changed file fingerprints, account/access changes and traversal", async (t) => {
  const f = await preparationFixture(t);
  const read = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "README.md" },
  });
  const input = {
    kind: "repository-file",
    branch: "main",
    head: f.sha,
    title: "Manual edit",
    files: [
      { path: "README.md", previous: read.repositoryFiles.file.sha, content: encoded("New") },
    ],
  };
  for (const path of ["../secret", "a/../README.md", ".git/config", "a//b"])
    await assert.rejects(
      f.prepare({ ...input, files: [{ ...input.files[0], path }] }),
      /GITHUB_WORK_REQUEST/,
    );
  await assert.rejects(
    f.prepare({ ...input, files: [{ ...input.files[0], previous: "f".repeat(40) }] }),
    /GITHUB_WORK_CHANGED/,
  );
  const p = await f.prepare(input);
  await f.save({ identity: { id: 99, login: "Owner" } });
  assert.equal((await f.apply(p)).state, "failed");
  await f.save({ identity: { id: 11, login: "Owner" }, access: "read" });
  await assert.rejects(f.prepare(input), /GITHUB_WORK_ACCESS/);
  await f.save({ access: "write" });
  const p2 = await f.prepare(input);
  await f.save({ refs: { main: "b".repeat(40) } });
  assert.equal((await f.apply(p2)).state, "failed");
  assert((await f.calls()).every((v) => v.method === "GET"));
});

test("manual branch -> commit -> PR preserves the base and reconciles every lost acknowledgement without replay", async (t) => {
  const f = await preparationFixture(t),
    branch = "edit/readme#1";
  const b = await f.prepare({ kind: "repository-branch", branch, base: "main", head: f.sha });
  await f.save({ drop: true });
  assert.equal((await f.apply(b)).state, "unknown");
  await f.save({ unavailable: false });
  assert.equal((await f.probe({ op: "status", id: b.id })).state, "completed");
  assert.equal((await f.apply(b)).state, "completed");
  const read = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch, path: "README.md" },
  });
  const file = await f.prepare({
    kind: "repository-file",
    branch,
    head: f.sha,
    title: "Reviewed change",
    files: [
      { path: "README.md", previous: read.repositoryFiles.file.sha, content: encoded("New\r\n") },
    ],
  });
  const saved = await f.apply(file);
  assert.equal(saved.state, "completed");
  const input = {
    kind: "repository-pr",
    branch,
    base: "main",
    head: saved.result.sha,
    title: "Review manual change",
    body: "Description",
  };
  const pr = await f.prepare(input);
  await f.save({ drop: true });
  assert.equal((await f.apply(pr)).state, "unknown");
  await f.save({ unavailable: false });
  const done = await f.probe({ op: "status", id: pr.id });
  assert.equal(done.state, "completed");
  assert.equal(done.result.number, 78);
  assert.equal((await f.apply(pr)).state, "completed");
  await assert.rejects(f.prepare(input), /GITHUB_WORK_CHANGED/);
  const state = await f.get();
  assert.equal(state.refs.main, f.sha);
  assert.equal(state.refs[branch], saved.result.sha);
  const writes = (await f.calls()).filter((v) => v.method !== "GET");
  assert.equal(writes.length, 3);
  assert(writes.every((v) => v.method === "POST"));
});
test("manual branch/PR creation refuses occupied names, stale sources, identical branches, changed heads and acting accounts", async (t) => {
  const f = await preparationFixture(t);
  const input = { kind: "repository-branch", branch: "edit/test", base: "main", head: f.sha };
  await assert.rejects(f.prepare({ ...input, branch: "main" }), /GITHUB_WORK_REQUEST/);
  await assert.rejects(f.prepare({ ...input, head: "b".repeat(40) }), /GITHUB_WORK_CHANGED/);
  const prepared = await f.prepare(input);
  await f.save({ refs: { main: f.sha, "edit/test": f.sha } });
  assert.equal((await f.apply(prepared)).state, "failed");
  await assert.rejects(f.prepare(input), /GITHUB_WORK_CHANGED/);
  await f.save({ refs: { main: f.sha } });
  const changed = await f.prepare(input);
  await f.save({ identity: { id: 99, login: "Owner" } });
  assert.equal((await f.apply(changed)).state, "failed");
  await f.save({
    identity: { id: 11, login: "Owner" },
    refs: { main: f.sha, "edit/test": "b".repeat(40) },
  });
  const prInput = {
    kind: "repository-pr",
    branch: "edit/test",
    base: "main",
    head: "b".repeat(40),
    title: "PR",
    body: "",
  };
  await assert.rejects(f.prepare({ ...prInput, base: "edit/test" }), /GITHUB_WORK_REQUEST/);
  const pr = await f.prepare(prInput);
  await f.save({ refs: { main: f.sha, "edit/test": "c".repeat(40) } });
  assert.equal((await f.apply(pr)).state, "failed");
  assert((await f.calls()).every((v) => v.method === "GET"));
});

test("manual create/rename/delete use atomic commits with exact absence and byte reconciliation", async (t) => {
  const f = await preparationFixture(t);
  const apply = async (head, files, title) => {
    const op = await f.prepare({ kind: "repository-file", branch: "main", head, files, title });
    await f.save({ drop: true });
    assert.equal((await f.apply(op)).state, "unknown");
    await f.save({ unavailable: false });
    const done = await f.probe({ op: "status", id: op.id });
    assert.equal(done.state, "completed");
    await f.apply(op);
    return done.result.sha;
  };
  let head = await apply(
    f.sha,
    [{ path: "docs/new.txt", previous: null, content: "" }],
    "Create empty",
  );
  let tree = (await f.get()).commits[head].tree;
  assert.equal(tree["docs/new.txt"], "");
  const original = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "README.md" },
  });
  head = await apply(
    head,
    [
      { path: "README.md", previous: original.repositoryFiles.file.sha, content: null },
      { path: "Readme.md", previous: null, content: original.repositoryFiles.file.content },
    ],
    "Case rename",
  );
  tree = (await f.get()).commits[head].tree;
  assert(!Object.hasOwn(tree, "README.md"));
  assert.equal(tree["Readme.md"], original.repositoryFiles.file.content);
  const renamed = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "Readme.md" },
  });
  head = await apply(
    head,
    [{ path: "Readme.md", previous: renamed.repositoryFiles.file.sha, content: null }],
    "Delete",
  );
  tree = (await f.get()).commits[head].tree;
  assert(!Object.hasOwn(tree, "Readme.md"));
  assert.equal(tree["docs/new.txt"], "");
  const writes = (await f.calls()).filter((v) => v.method === "POST");
  assert.equal(writes.length, 3);
  assert(writes.every((v) => v.endpoint === "graphql"));
});
test("manual file operations refuse occupied destinations, wrong fingerprints, duplicate paths and missing deletes before writes", async (t) => {
  const f = await preparationFixture(t);
  const prepare = (files) =>
    f.prepare({
      kind: "repository-file",
      branch: "main",
      head: f.sha,
      files,
      title: "Manual change",
    });
  await assert.rejects(
    prepare([{ path: "README.md", previous: null, content: "" }]),
    /GITHUB_WORK_CHANGED/,
  );
  await assert.rejects(
    prepare([{ path: "README.md", previous: "b".repeat(40), content: null }]),
    /GITHUB_WORK_CHANGED/,
  );
  await assert.rejects(
    prepare([{ path: "missing.txt", previous: null, content: null }]),
    /GITHUB_WORK_REQUEST/,
  );
  await assert.rejects(
    prepare([{ path: "missing.txt", previous: "b".repeat(40), content: null }]),
    /GITHUB_WORK_CHANGED/,
  );
  await assert.rejects(
    prepare([
      { path: "new.txt", previous: null, content: "" },
      { path: "new.txt", previous: null, content: "" },
    ]),
    /GITHUB_WORK_REQUEST/,
  );
  await assert.rejects(
    prepare([{ path: "../escape", previous: null, content: "" }]),
    /GITHUB_WORK_REQUEST/,
  );
  const op = await prepare([{ path: "new.txt", previous: null, content: "" }]);
  await f.save({ refs: { main: "b".repeat(40) } });
  assert.equal((await f.apply(op)).state, "failed");
  assert.equal((await f.calls()).filter((v) => v.method === "POST").length, 0);
});

test("tree moves preserve nested binary objects/modes and recover each lost acknowledgement without replay", async (t) => {
  const f = await fixture(t),
    head = f.sha;
  const tree = {
    "docs/a.txt": Buffer.from("alpha").toString("base64"),
    "docs/nested/tool": Buffer.from("binary\0").toString("base64"),
    "docs/link": Buffer.from("../a.txt").toString("base64"),
    "keep.txt": Buffer.from("keep").toString("base64"),
  };
  for (const phase of ["trees", "commits", "graphql"]) {
    await f.save({
      preparation: true,
      refs: { main: head },
      commits: { [head]: { commit: { message: "base" }, tree } },
      modes: { "docs/nested/tool": "100755", "docs/link": "120000" },
      gitCommits: {},
      unavailable: false,
      dropEndpoint: null,
    });
    const read = await f.probe({
      op: "observe",
      query: { kind: "repository-files", branch: "main", path: "docs" },
    });
    assert.equal(read.repositoryFiles.directory.files, 3);
    const input = {
      kind: "repository-tree",
      branch: "main",
      head,
      title: "Move directory " + phase,
      files: [
        {
          path: "docs",
          previous: read.repositoryFiles.directory.sha,
          content: null,
          moveTo: "renamed/docs",
        },
      ],
    };
    await assert.rejects(
      f.prepare({ ...input, files: [{ ...input.files[0], moveTo: "keep.txt" }] }),
      /GITHUB_WORK_CHANGED/,
    );
    const p = await f.prepare(input),
      start = (await f.calls()).length;
    await f.save({
      dropEndpoint: phase === "graphql" ? "graphql" : "repos/Owner/Project/git/" + phase,
    });
    assert.equal((await f.apply(p)).state, "unknown");
    await f.save({ unavailable: false });
    let r = await f.probe({ op: "status", id: p.id });
    if (phase !== "graphql") {
      assert.equal(r.state, "prepared");
      r = await f.apply(p);
    }
    assert.equal(r.state, "completed");
    const state = await f.get(),
      entries = f.git("ls-tree", "-r", state.gitCommits[r.result.sha].tree.sha);
    assert.match(entries, /100755 blob [a-f0-9]+\trenamed\/docs\/nested\/tool/);
    assert.match(entries, /120000 blob [a-f0-9]+\trenamed\/docs\/link/);
    assert.match(entries, /keep.txt/);
    assert.doesNotMatch(entries, /\tdocs\//);
    await f.apply(p);
    const writes = (await f.calls()).slice(start).filter((c) => c.method !== "GET");
    assert.deepEqual(
      writes.map((c) => c.endpoint),
      ["repos/Owner/Project/git/trees", "repos/Owner/Project/git/commits", "graphql"],
    );
  }
});

test("directory deletion checks full immutable tree and exact HEAD", async (t) => {
  const f = await fixture(t),
    tree = {
      "docs/file": Buffer.from("x").toString("base64"),
      keep: Buffer.from("y").toString("base64"),
    };
  await f.save({
    preparation: true,
    refs: { main: f.sha },
    commits: { [f.sha]: { commit: { message: "base" }, tree } },
  });
  const data = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "docs" },
  });
  const input = {
    kind: "repository-tree",
    branch: "main",
    head: f.sha,
    title: "Delete folder",
    files: [
      { path: "docs", previous: data.repositoryFiles.directory.sha, content: null, moveTo: null },
    ],
  };
  await f.save({ truncated: true });
  await assert.rejects(f.prepare(input), /GITHUB_WORK_REQUEST/);
  await f.save({ truncated: false });
  const p = await f.prepare(input);
  await f.save({ refs: { main: "b".repeat(40) } });
  assert.equal((await f.apply(p)).state, "failed");
  await f.save({ refs: { main: f.sha } });
  const r = await f.apply(await f.prepare(input));
  assert.equal(r.state, "completed");
  assert.match(f.git("ls-tree", "-r", (await f.get()).gitCommits[r.result.sha].tree.sha), /\tkeep/);
  assert.doesNotMatch(
    f.git("ls-tree", "-r", (await f.get()).gitCommits[r.result.sha].tree.sha),
    /docs/,
  );
});

test("manual GitHub text exceeds 2 MiB through durable receipts and rejects GitHub ceiling excess", async (t) => {
  const f = await fixture(t),
    content = Buffer.alloc(4 * 1024 * 1024, "x").toString("base64");
  await f.save({
    preparation: true,
    refs: { main: f.sha },
    commits: { [f.sha]: { commit: { message: "base" }, tree: { "large.txt": content } } },
  });
  const view = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "large.txt" },
  });
  assert.equal(view.repositoryFiles.file.content, content);
  const input = {
    kind: "repository-file",
    branch: "main",
    head: f.sha,
    title: "Large file",
    files: [
      {
        path: "large.txt",
        previous: view.repositoryFiles.file.sha,
        content: Buffer.alloc(4 * 1024 * 1024, "y").toString("base64"),
      },
    ],
  };
  const p = await f.prepare(input);
  assert.equal((await f.apply(p)).state, "completed");
  assert.equal((await f.probe({ op: "status", id: p.id })).state, "completed");
  await assert.rejects(
    f.prepare({
      ...input,
      files: [{ ...input.files[0], content: "A".repeat(139810140) }],
    }),
    /GITHUB_WORK_REQUEST/,
  );
});

test("an absent immutable object ends its intent without any branch update", async (t) => {
  const f = await fixture(t),
    tree = { "file.txt": Buffer.from("content").toString("base64") };
  await f.save({
    preparation: true,
    refs: { main: f.sha },
    commits: { [f.sha]: { commit: { message: "base" }, tree } },
  });
  const data = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "file.txt" },
  });
  const p = await f.prepare({
    kind: "repository-tree",
    branch: "main",
    head: f.sha,
    title: "Move",
    files: [
      {
        path: "file.txt",
        previous: data.repositoryFiles.file.sha,
        content: null,
        moveTo: "other.txt",
      },
    ],
  });
  await f.save({ reject: 503 });
  assert.equal((await f.apply(p)).state, "unknown");
  await f.save({ reject: 0 });
  assert.equal((await f.probe({ op: "status", id: p.id })).state, "failed");
  assert.equal((await f.apply(p)).state, "failed");
  assert.equal((await f.calls()).filter((c) => c.method !== "GET").length, 1);
  assert.equal((await f.get()).refs.main, f.sha);
});

test("lost immutable acknowledgement is confirmed once by hash before the next phase", async (t) => {
  const f = await fixture(t),
    tree = { "file.txt": Buffer.from("confirmed").toString("base64") };
  await f.save({
    preparation: true,
    refs: { main: f.sha },
    commits: { [f.sha]: { commit: { message: "base" }, tree } },
  });
  const data = await f.probe({
    op: "observe",
    query: { kind: "repository-files", branch: "main", path: "file.txt" },
  });
  const p = await f.prepare({
    kind: "repository-tree",
    branch: "main",
    head: f.sha,
    title: "Bounded read",
    files: [
      {
        path: "file.txt",
        previous: data.repositoryFiles.file.sha,
        content: null,
        moveTo: "confirmed.txt",
      },
    ],
  });
  await f.save({ replyLostAt: "repos/Owner/Project/git/trees" });
  assert.equal((await f.apply(p)).state, "completed");
  assert.deepEqual(
    (await f.calls()).filter((c) => c.method !== "GET").map((c) => c.endpoint),
    ["repos/Owner/Project/git/trees", "repos/Owner/Project/git/commits", "graphql"],
  );
});
