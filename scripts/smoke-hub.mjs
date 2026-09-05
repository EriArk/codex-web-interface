import {readFile} from "node:fs/promises";
import {randomBytes,randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {once} from "node:events";
import {createApp} from "../apps/hub/dist/app.js";
import {GuacParser,instruction} from "../apps/hub/dist/remote.js";
const require=createRequire(new URL("../apps/hub/package.json",import.meta.url));
const {WebSocket}=require("ws");
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
for(const line of (await readFile(process.argv[3],"utf8")).split("\n")){
 const pos=line.indexOf("=");if(pos>0)process.env[line.slice(0,pos)]=line.slice(pos+1);
}
config.hub.databasePath=":memory:";
const token=randomBytes(32).toString("base64url");
const {app,store,sessions}=await createApp(config,{setupToken:token});
await app.listen({host:"127.0.0.1",port:0});
const base="http://127.0.0.1:"+app.server.address().port;
const origin=config.hub.publicBaseUrl;
try {
 const enrolled=await app.inject({method:"POST",url:"/api/auth/setup",headers:{origin},payload:{token,password:randomBytes(32).toString("base64url")}});
 if(enrolled.statusCode!==200)throw new Error(enrolled.body);
 const cookie=enrolled.headers["set-cookie"].split(";")[0];
 const csrf=enrolled.json().csrf;
 const headers={cookie,origin,"x-csrf-token":csrf,"idempotency-key":randomUUID()};
 const created=await app.inject({method:"POST",url:"/api/projects/"+config.projects[0].id+"/threads",headers,payload:{title:"Проверка Hub → Windows"}});
 if(created.statusCode!==200)throw new Error(created.body);
 const thread=created.json();
 const stream=new WebSocket(base.replace("http:","ws:")+"/api/events?threadId="+thread.id+"&after=0",{headers:{cookie,origin}});
 await once(stream,"open");stream.close(); // Browser leaves; Hub must retain the running session.
 let timer;
 const done=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error("Hub turn timeout")),120000);
  sessions.on("event",e=>{if(e.threadId===thread.id && e.type==="turn.completed")resolve(e);});
 });
 const turn=await app.inject({method:"POST",url:"/api/threads/"+thread.id+"/turns",headers:{...headers,"idempotency-key":randomUUID()},payload:{text:"Read the first 4 lines of README.md with PowerShell. Change nothing. Report briefly in Russian."}});
 if(turn.statusCode!==200)throw new Error(turn.body);
 const completion=await done;clearTimeout(timer);
 const history=store.history(thread.id);
 const activity=store.activity(thread.id).items;
 if(completion.payload.status!=="completed" || !activity.some(e=>e.type==="activity.command" && e.payload.exitCode===0 && e.payload.output?.includes("# Codex Web Interface")))throw new Error("No verified file read through Hub");
 const reconnect=new WebSocket(base.replace("http:","ws:")+"/api/events?threadId="+thread.id+"&after=0",{headers:{cookie,origin}});
 const received=[];reconnect.on("message",data=>received.push(JSON.parse(data.toString())));
 await once(reconnect,"open");
 await new Promise(resolve=>setTimeout(resolve,150));reconnect.close();
 if(!received.some(e=>e.type==="turn.completed"))throw new Error("Reconnect did not replay completed turn");
 console.log({hubCodex:true,browserDisconnectPreservedTurn:true,replay:true,messages:history.messages.length});
 const remote=new WebSocket(base.replace("http:","ws:")+"/api/projects/"+config.projects[0].id+"/remote?width=1280&height=800","guacamole",{headers:{cookie,origin}});
 const parser=new GuacParser();
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{remote.close();reject(new Error("Remote display timeout"));},20000);
  remote.on("message",data=>{
   for(const parts of parser.feed(data.toString())){
    if(parts[0]==="sync")remote.send(instruction("sync",...parts.slice(1)));
    if(parts[0]==="error"){clearTimeout(timeout);reject(new Error(parts.slice(1).join(" ")));}
    if(parts[0]==="size" && parts[1]==="0" && Number(parts[2])>0){
     console.log({remoteDesktop:true,width:parts[2],height:parts[3]});
     clearTimeout(timeout);remote.close();resolve();
    }
   }
  });
  remote.on("error",reject);
 });
} finally {await app.close();}
