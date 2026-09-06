import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {Store} from "../apps/hub/dist/store.js";
import {Sessions} from "../apps/hub/dist/sessions.js";
import {CodexClient} from "../packages/codex/dist/index.js";
import {spawnCodex} from "../packages/machines/dist/index.js";
const require=createRequire(new URL("../apps/hub/package.json",import.meta.url)),sharp=require("sharp");
const config=JSON.parse(await readFile(process.argv[2],"utf8")),root=await mkdtemp(join(tmpdir(),"codex-real-options-"));
config.hub.resultsPath=root;
const store=new Store(":memory:");
let transmitted;
class ObservedClient extends CodexClient {
 request(method,params) {
  if(method==="thread/start")params={...params,sandbox:"read-only",ephemeral:true};
  if(method==="turn/start"){transmitted=params;params={...params,sandboxPolicy:{type:"readOnly"}};}
  return super.request(method,params);
 }
}
const sessions=new Sessions(config,store,(m,cwd)=>new ObservedClient(spawnCodex(m,cwd),45000));
try {
 const caps=await sessions.capabilities(config.projects[0].id);
 const thread=await sessions.create(config.projects[0].id,"Ephemeral attachment and plan verification");
 const word="FILE_CHECK_"+randomUUID().replaceAll("-","").slice(0,8);
 const doc=await sessions.attachments.put(thread.id,"check.txt",Buffer.from("Verification word: "+word+"\n","utf8"));
 const image=await sessions.attachments.put(thread.id,"blue.png",await sharp({create:{width:120,height:80,channels:3,background:"#0044ff"}}).png().toBuffer());
 const selection={...caps.defaults,effort:"low",mode:"plan"};
 const completed=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error("Real Codex turn timeout")),120000);
  sessions.on("event",event=>{
   if(event.type==="approval.requested")void sessions.approve(event.payload.id,"decline");
   if(event.threadId===thread.id&&event.type==="turn.completed"){clearTimeout(timer);resolve(event);}
  });
 });
 await sessions.startTurn(thread.id,"Проверка вложений. Ничего не изменяй. Прочитай прикреплённый check.txt. Назови контрольное слово из файла и основной цвет прикреплённого изображения. Ответь кратко по-русски.",selection,[doc.id,image.id]);
 const result=await completed;
 assert.equal(result.payload.status,"completed");
 const answer=store.history(thread.id).messages.filter(m=>m.role==="assistant").map(m=>m.text).join("\n");
 assert.ok(answer.includes(word),"Codex must read the actual uploaded file");
 assert.match(answer,/син|blue/i,"Codex must inspect the attached image");
 assert.equal(transmitted.collaborationMode.mode,"plan");
 assert.equal(transmitted.effort,"low");
 assert.equal(transmitted.input.filter(i=>i.type==="localImage").length,1);
 console.log(JSON.stringify({realWindowsCodex:true,nativePlan:true,model:selection.model,effort:selection.effort,fileReadVerified:true,imageVisionVerified:true}));
}finally{await sessions.close();store.close();await rm(root,{recursive:true});}
