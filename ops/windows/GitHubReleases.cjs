'use strict';
// Fixed read-only GitHub release lookup in the logged-in Windows session.
// No listener, URL/command input, repository mutations or desktop process effects.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const TASK = 'CodexWebGitHubReleases';
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..';
const validJob = name => /^[a-f0-9-]{36}\.request\.json$/.test(name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = data => {
  if (!Array.isArray(data)) throw Error('RELEASES_UNAVAILABLE');
  return data.slice(0, 6).filter(r => r && Number.isSafeInteger(r.id)).map(r => ({
    id:r.id, name:typeof r.name === 'string' ? r.name.slice(0,300) : '',
    tag_name:typeof r.tag_name === 'string' ? r.tag_name.slice(0,300) : '',
    html_url:typeof r.html_url === 'string' ? r.html_url.slice(0,2048) : '',
    body:typeof r.body === 'string' ? r.body.slice(0,12001) : '',
    published_at:typeof r.published_at === 'string' ? r.published_at.slice(0,40) : '',
    prerelease:r.prerelease === true, draft:r.draft === true,
    assets:Array.from({length:Math.min(1000,Array.isArray(r.assets)?r.assets.length:0)},()=>({})),
  }));
};
async function read(root,name) {
  const file=path.join(root,name), stat=await fs.lstat(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>262144)throw Error('INVALID_RELEASE_JOB');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
async function worker(root, execute=run) {
  const config=await read(root,'config.json');
  if(!path.isAbsolute(config.gh) || path.basename(config.gh).toLowerCase()!=='gh.exe')throw Error('INVALID_RELEASE_CONFIG');
  let empty=0;
  const deadline=Date.now()+30000;
  while(Date.now()<deadline && empty<4) {
    const names=(await fs.readdir(root)).filter(validJob).slice(0,16);
    let processed=0;
    for(const name of names) {
      const output=name.replace('.request.json','.response.json');
      if(await fs.stat(path.join(root,output)).then(()=>true,()=>false))continue;
      let response;
      try {
        const job=await read(root,name);
        if(!valid(job.owner)||!valid(job.repo)||!Number.isFinite(job.createdAt)||Math.abs(Date.now()-job.createdAt)>60000)throw Error('INVALID_RELEASE_JOB');
        const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:GH_DEBUG|GH_HOST|GH_REPO|GH_PAGER|PAGER)$/i.test(key)));
        const result=await execute(config.gh,['api','--hostname','github.com','--method','GET',`repos/${job.owner}/${job.repo}/releases?per_page=6`],{cwd:root,env:{...env,GH_PROMPT_DISABLED:'1',GH_HOST:'github.com'},windowsHide:true,timeout:8000,maxBuffer:2097152});
        response={ok:true,items:clean(JSON.parse(result.stdout))};
      } catch { response={ok:false,code:'RELEASES_UNAVAILABLE'}; }
      const temporary=path.join(root,output+'.tmp');
      await fs.writeFile(temporary,JSON.stringify(response),{flag:'wx',mode:0o600});
      await fs.rename(temporary,path.join(root,output));
      processed++;
    }
    empty=processed?0:empty+1;
    await sleep(250);
  }
}
async function request(root,owner,repo,execute=run) {
  if(!valid(owner)||!valid(repo)||!/^[A-Za-z0-9-]+$/.test(owner))throw Error('INVALID_REPOSITORY');
  const files=await fs.readdir(root);
  // Only our expired transient receipt files; never source files, credentials or another service.
  for(const name of files.filter(n=>/^[a-f0-9-]{36}\.(?:request|response)\.json(?:\.tmp)?$/.test(n))) {
    const file=path.join(root,name),stat=await fs.lstat(file);
    if(stat.isFile()&&!stat.isSymbolicLink()&&Date.now()-stat.mtimeMs>120000)await fs.unlink(file).catch(()=>{});
  }
  if(files.filter(validJob).length>16)throw Error('RELEASES_BUSY');
  const id=randomUUID(),input=`${id}.request.json`,output=`${id}.response.json`;
  await fs.writeFile(path.join(root,input),JSON.stringify({owner,repo,createdAt:Date.now()}),{flag:'wx',mode:0o600});
  try {
    const scheduler=path.join(process.env.SystemRoot||'C:\\Windows','System32','schtasks.exe');
    const deadline=Date.now()+11000;
    const start=()=>execute(scheduler,['/Run','/TN',TASK],{windowsHide:true,timeout:1000,maxBuffer:4096});
    await start();
    let nextStart=Date.now()+2000;
    while(Date.now()<deadline) {
      try { const response=await read(root,output);if(!response.ok)throw Error('RELEASES_UNAVAILABLE');return clean(response.items); }
      catch(e) { if(e.code!=='ENOENT')throw e; }
      // A previous worker may have been exiting when IgnoreNew accepted Run.
      // Re-kicking this fixed read-only task does not repeat an existing receipt.
      if(Date.now()>=nextStart){await start().catch(()=>{});nextStart=Date.now()+2000;}
      await sleep(100);
    }
    throw Error('RELEASES_TIMEOUT');
  } finally {
    await fs.unlink(path.join(root,input)).catch(()=>{});
    await fs.unlink(path.join(root,output)).catch(()=>{});
  }
}
module.exports={worker,request,clean,valid};
if(require.main===module) {
  const root=__dirname;
  (async()=>{
    if(process.platform!=='win32')throw Error('WINDOWS_REQUIRED');
    if(process.argv.length===3&&process.argv[2]==='worker')await worker(root);
    else if(process.argv.length===5&&process.argv[2]==='request')process.stdout.write(JSON.stringify(await request(root,process.argv[3],process.argv[4])));
    else throw Error('INVALID_RELEASE_ACTION');
  })().catch(()=>{process.stderr.write('RELEASES_UNAVAILABLE\n');process.exitCode=1;});
}
