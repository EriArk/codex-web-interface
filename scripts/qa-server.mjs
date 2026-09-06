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
 closed=false;activeThread="";turn="";forks=new Map();queue=[];
 projects=[{id:"qa-native-seed",name:config.projects[0].name,roots:[{path:config.projects[0].workingDirectory}]}];
 async initialize(){return {userAgent:"codex/0.153.4"};}
 async request(method,p){
  const capabilities=capabilityReply(method);if(capabilities)return capabilities;
  if(method==="project/list")return {data:this.projects,nextCursor:null};
  if(method==="project/create"){const project={id:randomUUID(),name:p.name,roots:p.roots};this.projects.push(project);return {project};}
  if(method==="thread/list")return {data:[],nextCursor:null};
  if(method==="fs/getMetadata")return {isDirectory:true};
  if(method==="fs/readDirectory")return {entries:[{fileName:"Example",isDirectory:true,isFile:false}]};
  if(method==="account/read")return {account:{type:"chatgpt"}};
  if(method==="thread/start")return {thread:{id:randomUUID()}};
  if(method==="thread/resume")return {thread:{turns:[]}};
  if(method==="thread/turns/list")return {data:[{id:"qa-completed",status:"completed"}]};
  if(method==="thread/fork"){
   const thread={id:randomUUID(),cwd:p.cwd,historyMode:"paginated",updatedAt:Date.now()/1000};
   this.forks.set(thread.id,thread);return {thread};
  }
  if(method==="thread/read")return {thread:this.forks.get(p.threadId)};
  if(method==="thread/items/list")return {data:[],nextCursor:null};
  if(method==="thread/queue/list")return {data:this.queue.filter(q=>q.threadId===p.threadId)};
  if(method==="thread/queue/add"){const queuedSubmission={id:randomUUID(),clientUserMessageId:p.clientUserMessageId,input:p.input,threadId:p.threadId};this.queue.push(queuedSubmission);return {queuedSubmission};}
  if(method==="thread/queue/update"){const q=this.queue.find(q=>q.id===p.queuedSubmissionId);q.input=p.input;return {queuedSubmission:q};}
  if(method==="thread/queue/delete"){const before=this.queue.length;this.queue=this.queue.filter(q=>q.id!==p.queuedSubmissionId);return {deleted:this.queue.length!==before};}
  if(method==="turn/steer"){
    this.emit("notification","item/completed",{threadId:p.threadId,turnId:p.expectedTurnId,item:{id:randomUUID(),clientId:p.clientUserMessageId,type:"userMessage",content:p.input}});
    return {turnId:p.expectedTurnId};
  }
  if(method==="turn/start"){
   this.activeThread=p.threadId;this.turn=randomUUID();
   if(p.input.some(item=>item.text?.includes("Queue QA"))) {
    const turn=this.turn,thread=p.threadId,id=randomUUID();
    this.emit("notification","turn/started",{threadId:thread,turn:{id:turn}});
    this.emit("notification","item/completed",{threadId:thread,turnId:turn,item:{id:randomUUID(),clientId:p.clientUserMessageId,type:"userMessage",content:p.input}});
    setTimeout(()=>this.emit("notification","item/agentMessage/delta",{threadId:thread,turnId:turn,itemId:id,delta:"Проверяю очередь…"}),200);
    setTimeout(()=>{
      this.emit("notification","item/completed",{threadId:thread,turnId:turn,item:{id,type:"agentMessage",text:"Очередь проверена.",phase:"final_answer"}});
      this.emit("notification","turn/completed",{threadId:thread,turn:{id:turn,status:"completed"}});
      const q=this.queue.find(q=>q.threadId===thread);
      if(q){this.queue=this.queue.filter(v=>v.id!==q.id);void this.request("turn/start",{threadId:thread,input:q.input,clientUserMessageId:q.clientUserMessageId});}
    },p.input.some(v=>v.text?.includes("initial"))?25000:1500);
    return {turn:{id:turn}};
   }
   if(p.input.some(item=>item.text?.includes("Realtime QA"))) {
    const turn=this.turn,thread=p.threadId,id=randomUUID();
    this.emit("notification","turn/started",{threadId:thread,turn:{id:turn}});
    setTimeout(()=>this.emit("notification","item/agentMessage/delta",{threadId:thread,turnId:turn,itemId:id,delta:"Realtime: первая часть. "}),300);
    setTimeout(()=>this.emit("notification","item/agentMessage/delta",{threadId:thread,turnId:turn,itemId:id,delta:"Вторая часть пришла."}),1200);
    setTimeout(()=>this.emit("notification","item/completed",{threadId:thread,turnId:turn,item:{id:"qa-live-check-"+turn,type:"commandExecution",command:"npm test -- live",status:"completed",exitCode:0,aggregatedOutput:"LIVE CHECK PASSED"}}),1800);
    setTimeout(()=>{
      const hubThread=store.threadByCodex(thread);
      const image=store.result(hubThread.id,turn,"live-image-"+turn,"image","Изображение в реальном времени",{url:"/icon.svg",width:180,height:180});
      const event=store.append(hubThread.id,"result.created",{id:image,type:"image"},turn);sessions.emit("event",event);
    },2400);
    setTimeout(()=>this.emit("notification","item/completed",{threadId:thread,turnId:turn,item:{id,type:"agentMessage",text:"Realtime: первая часть. Вторая часть пришла. Готово.",phase:"final_answer"}}),10000);
    setTimeout(()=>this.emit("notification","turn/completed",{threadId:thread,turn:{id:turn,status:"completed"}}),10500);
    return {turn:{id:turn}};
   }
   this.emit("notification","turn/started",{threadId:p.threadId,turn:{id:this.turn}});
   const id=randomUUID();
   setTimeout(()=>this.emit("notification","item/agentMessage/delta",{threadId:p.threadId,turnId:this.turn,itemId:id,delta:"Проверяю проект. "}),150);
   setTimeout(()=>this.emit("notification","item/started",{threadId:p.threadId,turnId:this.turn,item:{type:"reasoning",id:"qa-reasoning"}}),250);
   if(p.input.some(item=>item.text?.includes("Выбор ответа"))) {
    setTimeout(()=>this.emit("request",{id:100,method:"item/tool/requestUserInput",params:{threadId:p.threadId,turnId:this.turn,questions:[
     {id:"choice",question:"Какой вариант выбираем?",header:"Вариант",options:[{label:"A",description:"Первый вариант"},{label:"B",description:"Второй вариант"}]},
     {id:"note",question:"Добавить пожелание?",header:"Пожелание",options:[]}
    ]}}),1500);
   } else setTimeout(()=>this.emit("request",{id:99,method:"item/commandExecution/requestApproval",params:{threadId:p.threadId,turnId:this.turn,command:"npm test",reason:"Проверка интерфейса подтверждений"}}),450);
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
await sessions.catalog.refresh();
const rpc=(await sessions.runtime(config.projects[0].id)).rpc;
rpc.projects.push({id:"qa-second-project",name:"Второй проект",roots:[{path:config.projects[0].workingDirectory+"-qa"}]});
await sessions.catalog.refresh(true);
const second=sessions.catalog.projects().find(p=>p.sourceId==="qa-second-project");
store.createThread(second.id,randomUUID(),"Чат второго проекта");
store.createThread("unassigned-"+config.machines[0].id,randomUUID(),"Отдельный чат");
const t=store.createThread(config.projects[0].id,randomUUID(),"Проверка мобильного интерфейса");
for(let n=1;n<=60;n++){
 const turn="qa-turn-"+n;
 store.append(t.id,"user.message",{id:"user-"+n,text:"Задача "+n+". Проверь подключение и сохрани результаты."},turn);
 store.append(t.id,"assistant.completed",{id:"assistant-"+n,text:"Шаг "+n+" завершён. Подключение к проекту работает.\n\nДетали выполнения находятся в **Активности**, а полезные итоги — в **Результатах**.",phase:"final_answer"},turn);
 if(n%5===0)store.result(t.id,turn,"check-"+n,"check","Проверка проекта завершена",{command:"npm test",exitCode:0});
}
store.createThread(config.projects[0].id,randomUUID(),"Другой диалог");
store.result(t.id,"qa-turn-59","long-command","check","Длинная команда",{command:"echo example\n".repeat(80),exitCode:0});
store.result(t.id,"qa-turn-59","plan-code","plan","План с кодом",{text:"Код открывается по нажатию.\n\n"+String.fromCharCode(96).repeat(3)+"js\n"+"const value = 1;\n".repeat(70)+String.fromCharCode(96).repeat(3)});
store.result(t.id,"qa-turn-60","preview-image","image","Изображение проверки",{url:"/icon.svg",width:180,height:180});
store.setPreferences({projectId:config.projects[0].id,threadId:t.id,theme:"organizer"});
const credentials={setupToken:randomBytes(32).toString("base64url"),password:randomBytes(24).toString("base64url")};
mkdirSync(".local",{recursive:true});
writeFileSync(".local/qa-credentials.json",JSON.stringify(credentials),{mode:0o600});
const {app}=await createApp(config,{store,sessions,setupToken:credentials.setupToken,webRoot:resolve("apps/web/dist")});
process.on("SIGTERM",()=>void app.close().then(()=>process.exit(0)));
await app.listen({host:"127.0.0.1",port:8782});
console.log("Isolated QA server ready on loopback; simulated Codex, real Remote provider.");
