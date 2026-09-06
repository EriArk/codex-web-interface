import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApp } from "../apps/hub/dist/app.js";
import { loadConfig } from "../apps/hub/dist/config.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../apps/hub/dist/maintenance.js";
process.umask(0o077);
await mkdir(".local",{recursive:true});
const root=await mkdtemp(resolve(".local/qa-restore-"));
const base=loadConfig(process.argv[2]);
const config={...base,hub:{...base.hub,publicBaseUrl:"https://qa.example.test",databasePath:join(root,"source","app.db"),resultsPath:join(root,"source","results")}};
const setupToken=randomBytes(32).toString("base64url"),password=randomBytes(24).toString("base64url"),marker="RESTORE-"+randomBytes(6).toString("hex");
let original,restored,thread;
async function turn(manager,id,prompt,settings){
 let timer,listener;
 const done=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error("Native restore turn timeout")),120000);
  listener=e=>{if(e.threadId===id&&e.type==="turn.completed")resolve(e)};
  manager.on("event",listener);
 });
 void done.catch(()=>{});
 try{await manager.startTurn(id,prompt,settings);assert.equal((await done).payload.status,"completed");}
 finally{clearTimeout(timer);manager.off("event",listener);}
}
try{
 original=await createApp(config,{setupToken});
 const setup=await original.app.inject({method:"POST",url:"/api/auth/setup",headers:{origin:config.hub.publicBaseUrl},payload:{token:setupToken,password}});
 assert.equal(setup.statusCode,200);
 thread=await original.sessions.create(config.projects[0].id,"CodexWeb backup and restore verification");
 const caps=await original.sessions.capabilities(thread.projectId),settings={...caps.defaults,mode:"default"};
 if(caps.models.find(m=>m.id===settings.model)?.efforts.includes("low"))settings.effort="low";
 const attachment=await original.sessions.attachments.put(thread.id,"restore-note.txt",Buffer.from("restore fixture"));
 await turn(original.sessions,thread.id,"Isolated integration test. Do not use tools or inspect files. Remember "+marker+" and reply with that word only.",settings);
 const snapshot=await createSnapshot(config,join(root,"backups"),{revision:"b269368"});
 const manifest=await verifySnapshot(snapshot);
 assert.equal(manifest.schemaVersion,2);
 await original.app.close();original=undefined;
 const target=join(root,"restored");
 await restoreSnapshot(snapshot,target);
 restored=await createApp({...config,hub:{...config.hub,databasePath:join(target,"app.db"),resultsPath:join(target,"results")}});
 const old=await restored.app.inject({method:"GET",url:"/api/auth/session",headers:{cookie:setup.headers["set-cookie"].split(";")[0]}});
 assert.equal(old.statusCode,401);
 const login=await restored.app.inject({method:"POST",url:"/api/auth/login",headers:{origin:config.hub.publicBaseUrl},payload:{password}});
 assert.equal(login.statusCode,200);
 assert.equal(restored.store.thread(thread.id).codexThreadId,thread.codexThreadId);
 assert.equal((await readFile(join(target,"results","uploads",attachment.id+".bin"))).toString(),"restore fixture");
 console.log("Restored original credentials, Hub/native IDs and uploaded file; old browser session revoked.");
 await restored.sessions.resume(thread.id);
 await turn(restored.sessions,thread.id,"Do not use tools. Which RESTORE word did I ask you to remember earlier? Reply with that word only.",settings);
 assert(restored.store.history(thread.id).messages.findLast(m=>m.role==="assistant")?.text.includes(marker));
 const report={nativeWindowsCodex:true,onlineSnapshot:true,passwordLoginAfterRestore:true,oldSessionRevoked:true,uploadedFileRestored:true,originalHubAndNativeIds:true,realContextRecallAfterRestore:true,ownerDatabaseAndDesktopUntouched:true};
 await writeFile(".local/real-restore-report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 const manager=restored??original;
 if(manager&&thread){
  if(manager.store.thread(thread.id).activeTurnId)await manager.sessions.interrupt(thread.id).catch(()=>{});
  await(await manager.sessions.runtime(thread.projectId)).rpc.request("thread/archive",{threadId:thread.codexThreadId}).catch(()=>{});
 }
 await restored?.app.close();await original?.app.close();
 await rm(root,{recursive:true,force:true});
}
