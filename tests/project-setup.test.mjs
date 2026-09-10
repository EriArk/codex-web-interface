import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setupProbe } from "../packages/machines/dist/setupProbe.js";

const git = (root, ...args) =>
  execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "project-setup-")),
    bin = join(root, "bin"),
    state = join(root, "github.json");
  await mkdir(bin);
  await writeFile(state, JSON.stringify({ creates: 0, repos: {}, block: false }));
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process');const a=process.argv.slice(2),file=process.env.SETUP_TEST_STATE,s=JSON.parse(fs.readFileSync(file));
const out=x=>process.stdout.write(JSON.stringify(x));const fail=(code)=>{process.stderr.write('HTTP '+code);process.exit(1)};
if(a[0]==='repo'&&a[1]==='view'){out({isEmpty:s.empty===true});process.exit(0)}
if(a[0]==='repo'&&a[1]==='clone'){cp.execFileSync('git',['clone','--template=',s.source,a[3]],{stdio:'ignore'});cp.execFileSync('git',['-C',a[3],'remote','set-url','origin','https://github.com/'+a[2]+'.git']);process.exit(0)}
if(a[0]!=='api')throw Error('unexpected command');
const method=a[a.indexOf('--method')+1],endpoint=a[5];
if(endpoint==='user'){out({login:'Owner'});process.exit(0)}
if(method==='POST'){
 if(endpoint!=='user/repos')throw Error('unexpected mutation');s.creates++;const name=a.find(x=>x.startsWith('name=')).slice(5),desc=a.find(x=>x.startsWith('description=')).slice(12);
 s.repos[name]={id:7,owner:{login:'Owner'},name,private:a.includes('private=true'),created_at:new Date().toISOString(),description:desc,size:0};fs.writeFileSync(file,JSON.stringify(s));out(s.repos[name]);process.exit(0)
}
const name=endpoint.split('/')[2];if(s.block&&s.creates)fail(503);if(!s.repos[name])fail(404);out(s.repos[name]);
`,
    { mode: 0o700 },
  );
  const prior = {
    PATH: process.env.PATH,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    SETUP_TEST_STATE: process.env.SETUP_TEST_STATE,
  };
  process.env.PATH = bin + ":" + process.env.PATH;
  process.env.LOCALAPPDATA = join(root, "private");
  process.env.SETUP_TEST_STATE = state;
  t.after(async () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    machineId: "local",
    name: "Demo",
    workingDirectory: join(root, "project"),
    createDirectory: true,
    repository: {
      mode: "create",
      owner: "Owner",
      name: "Demo",
      visibility: "private",
      description: "Owner project",
    },
  };
  const load = async () => JSON.parse(await readFile(state, "utf8")),
    save = async (v) => writeFile(state, JSON.stringify(v));
  return { root, input, load, save };
}
test("project setup review is read-only; exact retries create one repository and no dummy commit", async (t) => {
  const f = await fixture(t),
    inspection = await setupProbe({ op: "inspect", input: f.input });
  assert.deepEqual(inspection.steps, [
    "create-directory",
    "git-init",
    "create-repository",
    "link-origin",
    "register-project",
  ]);
  assert.equal((await f.load()).creates, 0);
  const request = {
    op: "apply",
    id: randomUUID(),
    input: f.input,
    fingerprint: inspection.fingerprint,
  };
  const first = await setupProbe(request);
  assert.equal(first.state, "complete");
  assert.equal(
    git(f.input.workingDirectory, "remote", "get-url", "origin"),
    "https://github.com/Owner/Demo.git",
  );
  assert.throws(() => git(f.input.workingDirectory, "rev-parse", "--verify", "HEAD"));
  assert.equal((await setupProbe(request)).state, "complete");
  assert.equal((await f.load()).creates, 1);
  await assert.rejects(
    setupProbe({ ...request, input: { ...f.input, name: "different" } }),
    /OPERATION_CONFLICT/,
  );
});
test("unknown GitHub creation is reconciled from the expected remote without another POST", async (t) => {
  const f = await fixture(t),
    inspection = await setupProbe({ op: "inspect", input: f.input });
  await f.save({ ...(await f.load()), block: true });
  const request = {
    op: "apply",
    id: randomUUID(),
    input: f.input,
    fingerprint: inspection.fingerprint,
  };
  assert.equal((await setupProbe(request)).state, "unknown");
  assert.equal((await f.load()).creates, 1);
  await f.save({ ...(await f.load()), block: false });
  assert.equal((await setupProbe(request)).state, "complete");
  assert.equal((await f.load()).creates, 1);
});
test("setup refuses changed folders and conflicting Git without changing source or origin", async (t) => {
  const f = await fixture(t),
    inspection = await setupProbe({ op: "inspect", input: f.input });
  await mkdir(f.input.workingDirectory);
  await writeFile(join(f.input.workingDirectory, "owner.txt"), "keep");
  await assert.rejects(
    setupProbe({
      op: "apply",
      id: randomUUID(),
      input: f.input,
      fingerprint: inspection.fingerprint,
    }),
    /DIRECTORY_NOT_EMPTY/,
  );
  git(f.input.workingDirectory, "init");
  git(f.input.workingDirectory, "remote", "add", "origin", "https://github.com/Owner/Other.git");
  await assert.rejects(
    setupProbe({ op: "inspect", input: { ...f.input, createDirectory: false } }),
    /REMOTE_CONFLICT/,
  );
  assert.equal(await readFile(join(f.input.workingDirectory, "owner.txt"), "utf8"), "keep");
  assert.equal(
    git(f.input.workingDirectory, "remote", "get-url", "origin"),
    "https://github.com/Owner/Other.git",
  );
  assert.equal((await f.load()).creates, 0);
});
test("existing remote clones into an isolated new folder and repeat keeps its commit unchanged", async (t) => {
  const f = await fixture(t),
    source = join(f.root, "source");
  await mkdir(source);
  git(source, "init", "-b", "main");
  await writeFile(join(source, "README.md"), "real project");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial content");
  await f.save({
    ...(await f.load()),
    source,
    repos: {
      Demo: {
        id: 8,
        name: "Demo",
        owner: { login: "Owner" },
        private: true,
        size: 3,
        created_at: new Date().toISOString(),
      },
    },
  });
  f.input.repository.mode = "connect";
  const inspection = await setupProbe({ op: "inspect", input: f.input });
  assert.deepEqual(inspection.steps, ["clone", "register-project"]);
  const request = {
    op: "apply",
    id: randomUUID(),
    input: f.input,
    fingerprint: inspection.fingerprint,
  };
  assert.equal((await setupProbe(request)).state, "complete");
  assert.equal(
    git(f.input.workingDirectory, "rev-parse", "HEAD"),
    git(source, "rev-parse", "HEAD"),
  );
  assert.equal(await readFile(join(f.input.workingDirectory, "README.md"), "utf8"), "real project");
  assert.equal((await setupProbe(request)).state, "complete");
  assert.equal((await f.load()).creates, 0);
});
