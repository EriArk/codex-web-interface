import {capabilityReply} from "../tests/fixtures.mjs";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {randomBytes,randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import {resolve} from "node:path";
import {createApp} from "../apps/hub/dist/app.js";
import {Store} from "../apps/hub/dist/store.js";
import {Sessions} from "../apps/hub/dist/sessions.js";
import {configSchema} from "../packages/shared/dist/index.js";
process.umask(0o077);
const raw=JSON.parse(readFileSync(process.argv[2],"utf8"));
raw.hub={...raw.hub,publicBaseUrl:"http://127.0.0.1:8782",host:"127.0.0.1",port:8782,secureCookies:false,databasePath:":memory:",resultsPath:resolve(".local/qa-results")};
const config=configSchema.parse(raw),store=new Store(":memory:");
class FakeRpc extends EventEmitter {
 closed=false;activeThread="";turn="";
 async initialize(){return {};}
 async request(method,p){
  const capabilities=capabilityReply(method);if(capabilities)return capabilities;
  if(method==="account/read")return {account:{type:"chatgpt"}};
  if(method==="thread/start")return {thread:{id:randomUUID()}};
  if(method==="thread/resume")return {thread:{turns:[]}};
  if(method==="turn/start"){
   this.activeThread=p.threadId;this.turn=randomUUID();
   this.emit("notification","turn/started",{threadId:p.threadId,turn:{id:this.turn}});
   const id=randomUUID();
   setTimeout(()=>this.emit("notification","item/agentMessage/delta",{threadId:p.threadId,turnId:this.turn,itemId:id,delta:"Проверяю проект. "}),150);
   setTimeout(()=>this.emit("request",{id:99,method:"item/commandExecution/requestApproval",params:{threadId:p.threadId,turnId:this.turn,command:"npm test",reason:"Проверка интерфейса подтверждений"}}),450);
   return {turn:{id:this.turn}};
  }
  if(method==="turn/interrupt"){this.complete("interrupted");return {};}
  return {};
 }
 respond(){
  const id=randomUUID();
  this.emit("notification","item/completed",{threadId:this.activeThread,turnId:this.turn,item:{type:"agentMessage",id,text:"Готово. Проверка интерфейса подтверждений завершена.",phase:"final_answer"}});
  this.complete("completed");
 }
 rejectRequest(){}
 complete(status){this.emit("notification","turn/completed",{threadId:this.activeThread,turn:{id:this.turn,status}});}
 close(){this.closed=true;}
}
const sessions=new Sessions(config,store,()=>new FakeRpc());
const t=store.createThread(config.projects[0].id,randomUUID(),"Проверка мобильного интерфейса");
for(let n=1;n<=60;n++){
 const turn="qa-turn-"+n;
 store.append(t.id,"user.message",{id:"user-"+n,text:"Задача "+n+". Проверь подключение и сохрани результаты."},turn);
 store.append(t.id,"assistant.completed",{id:"assistant-"+n,text:"Шаг "+n+" завершён. Подключение к проекту работает.\n\nДетали выполнения находятся в **Активности**, а полезные итоги — в **Результатах**.",phase:"final_answer"},turn);
 if(n%5===0)store.result(t.id,turn,"check-"+n,"check","Проверка проекта завершена",{command:"npm test",exitCode:0});
}
store.createThread(config.projects[0].id,randomUUID(),"Другой диалог");
store.setPreferences({projectId:config.projects[0].id,threadId:t.id,theme:"organizer"});
const credentials={setupToken:randomBytes(32).toString("base64url"),password:randomBytes(24).toString("base64url")};
mkdirSync(".local",{recursive:true});
writeFileSync(".local/qa-credentials.json",JSON.stringify(credentials),{mode:0o600});
const {app}=await createApp(config,{store,sessions,setupToken:credentials.setupToken,webRoot:resolve("apps/web/dist")});
process.on("SIGTERM",()=>void app.close().then(()=>process.exit(0)));
await app.listen({host:"127.0.0.1",port:8782});
console.log("Isolated QA server ready on loopback; simulated Codex, real Remote provider.");
