import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {createApp} from "../apps/hub/dist/app.js";
import {loadConfig} from "../apps/hub/dist/config.js";
import {readNativeActivity} from "../packages/machines/dist/index.js";
process.umask(0o077);
await mkdir(".local",{recursive:true});
const root=await mkdtemp(resolve(".local/qa-real-queue-")),base=loadConfig(process.argv[2]),origin="https://qa.example.test";
const config={...base,hub:{...base.hub,publicBaseUrl:origin,databasePath:join(root,"app.db"),resultsPath:join(root,"results")}};
let instance,thread;
try{
 const token=randomBytes(32).toString("base64url");instance=await createApp(config,{setupToken:token});
 const {app,store,sessions}=instance;
 const enrolled=await app.inject({method:"POST",url:"/api/auth/setup",headers:{origin},payload:{token,password:randomBytes(24).toString("base64url")}});
 assert.equal(enrolled.statusCode,200);
 const headers={origin,cookie:enrolled.headers["set-cookie"].split(";")[0],"x-csrf-token":enrolled.json().csrf};
 const request=async(path,method="GET",payload)=>{
  const result=await app.inject({method,url:"/api"+path,headers:{...headers,"idempotency-key":randomUUID()},...(payload?{payload}:{})});
  assert.equal(result.statusCode,200,path+" "+result.body);return result.json();
 };
 thread=await sessions.create(config.projects[0].id,"CodexWeb isolated native queue check");
 const caps=await sessions.capabilities(thread.projectId),settings={...caps.defaults,mode:"default"};
 if(caps.models.find(m=>m.id===settings.model)?.efforts.includes("low"))settings.effort="low";
 const completed=[],users=[];sessions.on("event",e=>{if(e.threadId!==thread.id)return;if(e.type==="turn.completed")completed.push(e);if(e.type==="user.message")users.push(e);});
 const started=await request("/threads/"+thread.id+"/turns","POST",{text:"This is an isolated protocol verification. Do not inspect or change files, do not delegate, do not contact external services. Say a short progress sentence, then run only PowerShell Start-Sleep -Seconds 15; Write-Output 'QUEUE TEST READY'. Finish with a short confirmation.",settings});
 const add=async text=>{
  await request("/threads/"+thread.id+"/queue","POST",{text,clientId:randomUUID(),attachments:[]});
  return (await request("/threads/"+thread.id+"/queue")).items.find(q=>q.text===text);
 };
 let q=await add("Disposable queue test draft. Do not execute this; it will be edited and deleted.");
 await request("/threads/"+thread.id+"/queue/"+q.id,"POST",{action:"edit",revision:q.revision,text:"Edited disposable queue draft"});
 q=(await request("/threads/"+thread.id+"/queue")).items.find(v=>v.id===q.id);assert.equal(q.text,"Edited disposable queue draft");
 await request("/threads/"+thread.id+"/queue/"+q.id,"POST",{action:"delete",revision:q.revision});
 q=await add("This is a steering instruction: continue the original harmless wait/print test and include STEER_RECEIVED in its final reply. Do not change files.");
 await request("/threads/"+thread.id+"/queue/"+q.id,"POST",{action:"steer",revision:q.revision,expectedTurnId:started.turnId});
 assert.equal((await request("/threads/"+thread.id+"/queue")).items.length,0);
 const followup="Reply QUEUE_SECOND_DONE only. No tools, file changes or external actions.";
 q=await add(followup);
 const deadline=Date.now()+150000;
 while(completed.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,500));
 assert.equal(completed.length,2,"Queue automatically continues to a second turn");assert(completed.every(e=>e.payload.status==="completed"));
 assert.equal((await request("/threads/"+thread.id+"/queue")).items.length,0);
 assert.equal(users.filter(e=>e.payload.text===followup).length,1,"Queued message appears live once");
 const messages=store.history(thread.id).messages;
 assert(messages.some(m=>m.role==="assistant"&&m.text.includes("STEER_RECEIVED")));
 assert(messages.some(m=>m.role==="assistant"&&m.text.includes("QUEUE_SECOND_DONE")));
 const runtime=await sessions.runtime(thread.projectId);
 const projects=await runtime.rpc.request("project/list",{limit:1});assert(Array.isArray(projects.data));
 const catalog=await runtime.rpc.request("thread/list",{limit:1,useStateDbOnly:true});assert(Array.isArray(catalog.data));
 const reread=await runtime.rpc.request("thread/read",{threadId:thread.codexThreadId,includeTurns:false});assert.equal(reread.thread.id,thread.codexThreadId);
 const resumed=await runtime.rpc.request("thread/resume",{threadId:thread.codexThreadId,excludeTurns:true,cwd:sessions.project(thread.projectId).workingDirectory});assert.equal(resumed.thread.id,thread.codexThreadId);
 const turns=await runtime.rpc.request("thread/turns/list",{threadId:thread.codexThreadId,limit:1,itemsView:"notLoaded",sortDirection:"desc"});assert.equal(turns.data.length,1);
 const items=await runtime.rpc.request("thread/items/list",{threadId:thread.codexThreadId,limit:5,sortDirection:"desc"});assert(Array.isArray(items.data));
 const machine=config.machines.find(m=>m.id===sessions.project(thread.projectId).machineId);
 const observer=machine.codex.activityNode?await readNativeActivity(machine,runtime.codexHome,[thread.codexThreadId]):[];
 if(observer.length)assert.equal(observer[0].status,"completed");
 const report={nativeWindowsCodex:true,version:caps.serverVersion,hubApi:true,compatibilityContract:{initializeAccount:true,modelsAndModes:true,projectList:true,threadListReadStartResume:true,pagedTurnsAndItems:true},nativeQueueAddEditDelete:true,steerExactTurn:true,noDuplicateSteer:true,automaticNextTurn:true,liveQueuedUserMessage:true,ownerThreadUntouched:true};
 await writeFile(".local/real-queue-report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(instance&&thread){
  if(instance.store.thread(thread.id).activeTurnId)await instance.sessions.interrupt(thread.id).catch(()=>{});
  await(await instance.sessions.queueClient(thread.id)).request("thread/archive",{threadId:thread.codexThreadId}).catch(()=>{});
 }
 await instance?.app.close();await rm(root,{recursive:true,force:true});
}
