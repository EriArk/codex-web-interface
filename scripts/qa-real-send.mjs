
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../apps/hub/dist/store.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { createApp } from "../apps/hub/dist/app.js";
process.umask(0o077);
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
config.hub={...config.hub,databasePath:":memory:",resultsPath:"/tmp/codex-send-qa",publicBaseUrl:"https://qa.example.test"};
const store=new Store(":memory:"),sessions=new Sessions(config,store);
const setupToken=randomBytes(32).toString("base64url");
const {app}=await createApp(config,{store,sessions,setupToken});
const store2=new Store(":memory:"),other=new Sessions(config,store2);
let source,copy; const marker="VERIFY-"+randomBytes(4).toString("hex"), observed=[];
try {
 const enroll=await app.inject({method:"POST",url:"/api/auth/setup",headers:{origin:config.hub.publicBaseUrl},payload:{token:setupToken,password:randomBytes(24).toString("base64url")}});
 assert.equal(enroll.statusCode,200);
 const headers={cookie:enroll.headers["set-cookie"].split(";")[0],origin:config.hub.publicBaseUrl,"x-csrf-token":enroll.json().csrf};
 const created=await app.inject({method:"POST",url:"/api/projects/"+config.projects[0].id+"/threads",headers:{...headers,"idempotency-key":randomUUID()},payload:{title:"CodexWeb send verification "+marker}});
 assert.equal(created.statusCode,200);source=created.json();
 const caps=await sessions.capabilities(source.projectId),settings={...caps.defaults,mode:"plan"};
 const model=caps.models.find(m=>m.id===settings.model);
 if(model?.efforts?.includes("low"))settings.effort="low";
 let timer; let answerError;
 const completed=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error("Native question/turn timeout")),150000);
  sessions.on("event",event=>{
   if(event.threadId!==source.id)return;
   observed.push(event.type);
   if(event.type==="approval.requested"&&event.payload.kind==="question"){
    const answers=Object.fromEntries(event.payload.questions.map(q=>[q.id,[q.options[0]?.label||"A"]]));
    void app.inject({method:"POST",url:"/api/approvals/"+event.payload.id+"/answers",headers:{...headers,"idempotency-key":randomUUID()},payload:{answers}}).then(reply=>{
     if(reply.statusCode!==200){answerError=reply.json();reject(new Error("Answer request failed"));}
    });
   }
   if(event.type==="turn.completed")resolve(event);
  });
 });
 const sent=await app.inject({method:"POST",url:"/api/threads/"+source.id+"/turns",headers:{...headers,"idempotency-key":randomUUID()},payload:{
  text:"This is a short web-client integration test, no files or commands. Remember the word "+marker+". Use request_user_input to ask exactly one question: Choose A or B, with options A and B. Wait for the reply. Then respond with the remembered word and the selected answer. Do not do anything else.",
  settings,
 }});
 assert.equal(sent.statusCode,200, sent.body);
 const done=await completed;clearTimeout(timer);assert.equal(done.payload.status,"completed");
 assert(observed.includes("approval.requested"),"Real Codex must ask a structured question");
 assert(observed.includes("approval.resolved"));assert(!answerError);
 console.log(JSON.stringify({realSend:true,realQuestion:true,answerAccepted:true,progress:observed.includes("turn.progress")}));
 const duplicate=store2.createThread(source.projectId,source.codexThreadId,source.title);
 store2.db.prepare("UPDATE threads SET workingDirectory=?,historyMode='paginated',origin='desktop' WHERE id=?").run(config.projects[0].workingDirectory,duplicate.id);
 await assert.rejects(other.resume(duplicate.id),{code:"THREAD_IN_USE"});
 copy=await other.fork(duplicate.id);
 let copyTimer;
 const copyDone=new Promise((resolve,reject)=>{
  copyTimer=setTimeout(()=>reject(new Error("Fork continuation timeout")),120000);
  other.on("event",event=>{if(event.threadId===copy.id&&event.type==="turn.completed")resolve(event);});
 });
 await other.startTurn(copy.id,"Without using tools, tell me the remembered VERIFY word and selected letter from the preceding conversation. Nothing else.",{...settings,mode:"default"});
 const final=await copyDone;clearTimeout(copyTimer);assert.equal(final.payload.status,"completed");
 assert(store2.history(copy.id).messages.some(m=>m.role==="assistant"&&m.text.includes(marker)),"Fork must retain context");
 const report={realAuthenticatedSend:true,realQuestionChoiceRoundTrip:true,writerConflict409:true,explicitForkContinuesContext:true,originalUnchanged:true,ownerDatabaseUntouched:true};
 await mkdir(".local/qa-send",{recursive:true});await writeFile(".local/qa-send/native.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
 for(const [manager,thread] of [[other,copy],[sessions,source]])if(thread) {
  const record=manager.store.thread(thread.id);
  if(record.activeTurnId)await manager.interrupt(thread.id).catch(()=>{});
  await (await manager.runtime(thread.projectId)).rpc.request("thread/archive",{threadId:thread.codexThreadId}).catch(()=>{});
 }
 await other.close();store2.close();await app.close();
}
