
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,win32} from "node:path";
import {randomUUID} from "node:crypto";
import {Store} from "../apps/hub/dist/store.js";
import {Sessions} from "../apps/hub/dist/sessions.js";
import {CodexClient} from "../packages/codex/dist/index.js";
import {spawnCodex} from "../packages/machines/dist/index.js";
function factory(m,cwd) { return new CodexClient(spawnCodex(m,cwd)); }
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
const root=await mkdtemp(join(tmpdir(),"codex-continuity-"));config.hub.resultsPath=root;
const store=new Store(":memory:");let sessions=new Sessions(config,store,factory),project,thread,nativeId;
const machine=config.machines.find(m=>m.type==="ssh-windows");
assert(machine,"Windows machine required");
const marker=randomUUID().slice(0,8),name="CodexWeb verification "+marker;
const directory=win32.join(win32.dirname(config.projects.find(p=>p.machineId===machine.id).workingDirectory),"CodexWebVerify-"+marker);
async function run(prompt,settings) {
 const done=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{sessions.removeListener("event",handle);reject(new Error("Continuity turn timeout"));},120000);
  const handle=event=>{
   if(event.type==="approval.requested")void sessions.approve(event.payload.id,"decline");
   if(event.threadId===thread.id&&event.type==="turn.completed"){clearTimeout(timer);sessions.removeListener("event",handle);resolve(event);}
  };sessions.on("event",handle);
 });
 await sessions.startTurn(thread.id,prompt,settings);
 assert.equal((await done).payload.status,"completed");
}
try {
 await sessions.catalog.refresh(true);
 project=await sessions.catalog.createProject(machine.id,name,directory,true,randomUUID());
 assert(project);
 nativeId=sessions.project(project.id).sourceId;
 const rpc=(await sessions.runtime(project.id)).rpc;
 const folders=await sessions.catalog.directories(machine.id,win32.dirname(directory));
 assert(folders.entries.some(p=>p.path===directory));
 assert((await rpc.request("project/list",{limit:100})).data.some(p=>p.id===nativeId&&p.name===name));
 console.log(JSON.stringify({createdRealProject:true,folderBrowser:true,name}));
 thread=await sessions.create(project.id,name);
 assert.equal((await sessions.catalog.history(store.thread(thread.id))).messages.length,0);
 await sessions.close();sessions=new Sessions(config,store,factory);
 await sessions.catalog.refresh(true);
 const caps=await sessions.capabilities(project.id),settings={...caps.defaults,effort:"low",mode:"default"};
 const word="ORCHID_"+marker;
 await run("Remember this verification word for our next message: "+word+". Do not use tools or change files. Reply only with that word.",settings);
 thread=store.thread(thread.id);
 const first=await sessions.catalog.history(thread);
 assert(first.messages.some(m=>m.role==="assistant"&&m.text.includes(word)));
 const sameId=thread.codexThreadId;
 await sessions.close();sessions=new Sessions(config,store,factory);
 await sessions.catalog.refresh(true);
 await run("What was the verification word in my previous message? Reply only with the word. Do not use tools.",settings);
 assert.equal(store.thread(thread.id).codexThreadId,sameId);
 const second=await sessions.catalog.history(store.thread(thread.id));
 assert(second.messages.filter(m=>m.role==="assistant").at(-1).text.includes(word));
 assert.equal(new Set(second.messages.map(m=>m.id)).size,second.messages.length);
 assert.equal(second.messages.filter(m=>m.role==="user").length,2);
 console.log(JSON.stringify({sameNativeThreadResumed:true,contextAcrossAppServerRestart:true,nativeHistoryMessages:second.messages.length}));
} finally {
 try {
  const rpc=(await sessions.runtime(config.projects.find(p=>p.machineId===machine.id).id)).rpc;
  if(thread)await rpc.request("thread/archive",{threadId:store.thread(thread.id).codexThreadId}).catch(()=>{});
  if(nativeId)await rpc.request("project/delete",{projectId:nativeId});
  if(project) {
   const meta=await rpc.request("fs/readDirectory",{path:directory});
   assert.equal(meta.entries.length,0,"Only remove the test's verified empty directory");
   await rpc.request("fs/remove",{path:directory,recursive:false,force:false});
  }
 } finally {await sessions.close();store.close();await rm(root,{recursive:true});}
}
