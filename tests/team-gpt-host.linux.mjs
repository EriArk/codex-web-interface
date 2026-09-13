// Explicit opt-in: disposable Docker/profile verification. Never reads live configuration.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Store } from "../apps/hub/dist/store.js";
import { TeamGpt, teamGptName } from "../apps/hub/dist/team-gpt.js";
import { reconcileGptProfiles } from "../apps/hub/dist/team-gpt-host.js";
import {
  createProfileSnapshot,
  verifyProfileSnapshot,
} from "../apps/hub/dist/team-profile-backup.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import { configSchema } from "../packages/shared/dist/index.js";

const image = process.env.TEAM_QA_GPT_IMAGE;
if (
  process.platform !== "linux" ||
  process.getuid?.() !== 1000 ||
  !/^codex-web-gpt:[a-f0-9]{7,64}$/.test(image ?? "")
)
  throw Error("Set TEAM_QA_GPT_IMAGE to an isolated candidate image on Linux, as UID 1000.");
await mkdir(".local", { recursive: true });
const parent = await realpath(".local"),
  root = await mkdtemp(join(parent, "gpt-network-qa-"));
const config = configSchema.parse({
  hub: {
    publicBaseUrl: "https://fixture.invalid",
    databasePath: join(root, "owner.db"),
    resultsPath: join(root, "results"),
  },
  auth: { username: "fixture" },
  team: {
    enabled: true,
    root: join(root, "team"),
    gptProfiles: { enabled: true, maxProfiles: 1, portBase: 18900 },
  },
  machines: [],
  projects: [],
});
const owner = new Store(config.hub.databasePath);
owner.db.prepare("INSERT INTO users VALUES('fixture','unused-fixture-hash')").run();
const registry = new TeamStore(join(config.team.root, "team.db"), config, owner),
  gpt = new TeamGpt(config, registry),
  id = registry.ownerId;
const name = teamGptName(id),
  exec = promisify(execFile),
  docker = async (...args) =>
    (await exec("docker", args, { timeout: 45000, maxBuffer: 1024 * 1024 })).stdout;
try {
  gpt.request(id);
  for (let pass = 0; pass < 18 && gpt.row(id).state !== "ready"; pass++) {
    await reconcileGptProfiles(config, registry.db, { image });
    const row = gpt.row(id);
    assert.notEqual(row.state, "failed", row.code ?? "provisioning failed");
    if (row.state !== "ready") await new Promise((r) => setTimeout(r, 5000));
  }
  assert.equal(gpt.row(id).state, "ready", "new empty browser started");
  const row = gpt.row(id);
  assert.equal((await fetch("http://127.0.0.1:18900/service-health")).status, 401);
  assert.equal(
    (
      await fetch("http://127.0.0.1:18900/service-health", {
        headers: { Authorization: "Bearer " + row.serviceToken },
      })
    ).status,
    200,
  );
  // No login, sends, native writer, owner profile, or existing container is used.
  const output = await docker(
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `
 import assert from 'node:assert/strict';import {connect} from 'node:net';import {readFileSync} from 'node:fs';
 assert(!readFileSync('/proc/net/route','utf8').split('\\n').some(line=>line.split(/\\s+/)[1]==='00000000'),'no default route');
 const blocked=host=>new Promise(resolve=>{const s=connect({host,port:443});s.once('connect',()=>{s.destroy();resolve(false)});s.once('error',()=>resolve(true));s.setTimeout(1500,()=>{s.destroy();resolve(true)});});
 for(const ip of ['1.1.1.1','192.168.50.122','100.64.0.1'])assert(await blocked(ip),'direct egress blocked '+ip);
 const proxy='http://${name}-edge:3128';
 const {request}=await import('node:http');
 const through=value=>new Promise((resolve,reject)=>{const r=request(proxy,{path:value},s=>{s.resume();s.on('end',()=>resolve(s.statusCode));});r.on('error',reject);r.setTimeout(10000,()=>r.destroy());r.end();});
 for(const host of ['127.0.0.1','192.168.50.122','100.64.0.1','${name}','${name}-remote'])assert.equal(await through('http://'+host+'/'),403,host);
 const status=await through('http://example.com/');assert(status>=200&&status<500,'public HTTP still works');
 console.log('No direct route; LAN/Tailnet/other internal destinations refused; public HTTP works.');
 `,
  );
  console.log(output.trim());
  const guac = await docker(
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `
 import assert from 'node:assert/strict';import {connect} from 'node:net';
 await new Promise((resolve,reject)=>{const s=connect({host:'${name}-remote',port:4822},()=>s.write('6.select,3.vnc;'));s.on('data',b=>{assert(String(b).includes('args'));s.destroy();resolve()});s.on('error',reject);s.setTimeout(5000,()=>s.destroy(Error('timeout')));});console.log('Dedicated Guacamole handshake works.');
 `,
  );
  console.log(guac.trim());
  const containers = JSON.parse(await docker("inspect", name, name + "-edge", name + "-remote"));
  assert.equal(containers[0].Mounts[0].Source, join(config.team.root, "users", id, "gpt"));
  assert.equal(containers[1].Mounts.length, 0);
  assert.equal(containers[2].Mounts.length, 0);
  assert.equal(Object.keys(containers[0].NetworkSettings.Networks).length, 1);
  assert.equal(Object.keys(containers[2].NetworkSettings.Networks).length, 1);
  await assert.rejects(
    createProfileSnapshot(config, join(root, "backups")),
    /PROFILE_BROWSER_MUST_BE_STOPPED/,
  );
  assert.equal(containers[0].Config.Labels["io.codex-web.workspace"], id);
  await docker(
    "exec",
    name,
    "node",
    "-e",
    "require('node:fs').writeFileSync('/data/backup-fixture','retained anonymous profile',{mode:0o600})",
  );
  await docker("stop", "--time", "30", name);
  const checkpoint = await createProfileSnapshot(config, join(root, "backups"));
  const verified = await verifyProfileSnapshot(checkpoint);
  assert.equal(verified.profiles[0].userId, id);
  assert(verified.profiles[0].files.some((file) => file.path.startsWith("profile/Default/")));
  assert.equal(
    await readFile(join(checkpoint, id, "backup-fixture"), "utf8"),
    "retained anonymous profile",
  );
  assert.equal(JSON.parse(await docker("inspect", name))[0].State.Running, false);
  console.log(
    "Disposable GPT profile, network isolation, live-backup denial and stopped-profile backup passed.",
  );
} finally {
  for (const idName of [name, name + "-remote", name + "-edge"]) {
    let rows;
    try {
      rows = JSON.parse(await docker("container", "inspect", idName));
    } catch {
      continue;
    }
    assert.equal(rows[0].Config.Labels["io.codex-web.workspace"], id, "only remove this fixture");
    await docker("rm", "-f", idName);
  }
  for (const network of [name, name + "-out"]) {
    let rows;
    try {
      rows = JSON.parse(await docker("network", "inspect", network));
    } catch {
      continue;
    }
    assert.equal(rows[0].Labels["io.codex-web.workspace"], id);
    await docker("network", "rm", network);
  }
  registry.close();
  owner.close();
  assert.equal(await realpath(root), resolve(root));
  assert.equal(resolve(root, ".."), parent);
  await rm(root, { recursive: true });
}
