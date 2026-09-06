import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {once} from "node:events";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {createRequire} from "node:module";
import {join,resolve} from "node:path";
import {createApp} from "../apps/hub/dist/app.js";
import {loadConfig} from "../apps/hub/dist/config.js";
const require=createRequire(new URL("../apps/hub/package.json",import.meta.url));
const {WebSocket}=require("ws");
process.umask(0o077);
await mkdir(".local",{recursive:true});
const root=await mkdtemp(resolve(".local/qa-real-stream-"));
const base=loadConfig(process.argv[2]),origin="https://qa.example.test";
const config={...base,hub:{...base.hub,publicBaseUrl:origin,databasePath:join(root,"app.db"),resultsPath:join(root,"results")}};
let instance,thread,ws;
try {
 const token=randomBytes(32).toString("base64url");
 instance=await createApp(config,{setupToken:token});
 const {app,store,sessions}=instance;
 await app.listen({host:"127.0.0.1",port:0});
 const enrolled=await app.inject({method:"POST",url:"/api/auth/setup",headers:{origin},payload:{token,password:randomBytes(24).toString("base64url")}});
 assert.equal(enrolled.statusCode,200);
 const cookie=enrolled.headers["set-cookie"].split(";")[0];
 thread=await sessions.create(config.projects[0].id,"CodexWeb isolated realtime verification");
 const caps=await sessions.capabilities(thread.projectId),settings={...caps.defaults,mode:"default"};
 if(caps.models.find(m=>m.id===settings.model)?.efforts.includes("low"))settings.effort="low";
 const events=[],arrivals=[];
 ws=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/api/events?threadId=${thread.id}&after=0`,{headers:{origin,cookie}});
 ws.on("message",data=>{const event=JSON.parse(data);events.push(event);arrivals.push(Date.now());});
 await once(ws,"open");
 let timer;
 const finished=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error("Native realtime timeout")),150000);
  ws.on("message",data=>{const e=JSON.parse(data);if(e.type==="turn.completed")resolve(e);});
 });
 void finished.catch(()=>{});
 try {
  const sent=await app.inject({method:"POST",url:`/api/threads/${thread.id}/turns`,headers:{origin,cookie,"x-csrf-token":enrolled.json().csrf,"idempotency-key":randomUUID()},payload:{text:"This is an isolated end-to-end transport test. Do not inspect or change files and do not delegate. First say a short progress sentence. Then execute exactly one PowerShell command: Write-Output 'CODEX LIVE TEST'; Start-Sleep -Seconds 2; Write-Output 'CODEX LIVE TEST DONE'. It only prints and waits. Finally reply briefly confirming the command result.",settings}});
  assert.equal(sent.statusCode,200,sent.body);
  assert.equal((await finished).payload.status,"completed");
 } finally {clearTimeout(timer);}
 const completion=events.findIndex(e=>e.type==="turn.completed"),delta=events.findIndex(e=>e.type==="assistant.delta"),result=events.findIndex(e=>e.type==="result.created");
 assert(delta>=0&&delta<completion,"Native text streams through authenticated WebSocket");
 assert(result>=0&&result<completion,"Native command result arrives before completion");
 const results=await app.inject({url:`/api/threads/${thread.id}/results`,headers:{cookie}});
 assert(results.json().items.some(item=>item.type==="check"&&item.payload.exitCode===0));
 assert.equal(store.navigation([thread.projectId]).projects[0].unread,1);
 const report={nativeWindowsCodex:true,sentViaHubApi:true,authenticatedWebSocket:true,streamedTextBeforeCompletion:true,resultEventBeforeCompletion:true,successfulResultAvailableImmediately:true,completionCreatesUnread:true,firstTextBeforeFinishedMs:arrivals[completion]-arrivals[delta],firstResultBeforeFinishedMs:arrivals[completion]-arrivals[result],ownerThreadUntouched:true};
 await writeFile(".local/real-stream-report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
 ws?.close();
 if(instance&&thread){if(instance.store.thread(thread.id).activeTurnId)await instance.sessions.interrupt(thread.id).catch(()=>{});await(await instance.sessions.runtime(thread.projectId)).rpc.request("thread/archive",{threadId:thread.codexThreadId}).catch(()=>{});}
 await instance?.app.close();await rm(root,{recursive:true,force:true});
}
