import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/hub/dist/app.js";
import { Store } from "../apps/hub/dist/store.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { configSchema } from "../packages/shared/dist/index.js";

if (!process.argv[2]) throw new Error("Pass an explicit native QA config");
process.umask(0o077);
const raw = JSON.parse(await readFile(process.argv[2], "utf8"));
const root = await mkdtemp(join(tmpdir(), "codex-native-attachments-"));
raw.hub = {...raw.hub, databasePath: ":memory:", resultsPath: root, publicBaseUrl: "https://qa.example.test"};
for (const machine of raw.machines) delete machine.activityNode;
const config = configSchema.parse(raw), store = new Store(":memory:"), sessions = new Sessions(config, store);
const token = randomBytes(32).toString("base64url");
const {app} = await createApp(config, {store, sessions, setupToken: token});
const require = createRequire(new URL("../apps/hub/package.json", import.meta.url)), sharp = require("sharp");
let thread, rpc;
const report = [];
try {
  const login = await app.inject({method:"POST",url:"/api/auth/setup",headers:{origin:config.hub.publicBaseUrl},payload:{token,password:randomBytes(24).toString("base64url")}});
  assert.equal(login.statusCode,200);
  const headers={cookie:login.headers["set-cookie"].split(";")[0],origin:config.hub.publicBaseUrl,"x-csrf-token":login.json().csrf};
  const created=await app.inject({method:"POST",url:"/api/projects/"+config.projects[0].id+"/threads",headers:{...headers,"idempotency-key":randomUUID()},payload:{title:"CodexWeb isolated large attachment verification"}});
  assert.equal(created.statusCode,200,created.body);thread=created.json();
  rpc=await sessions.queueClient(thread.id);
  const caps=await sessions.capabilities(thread.projectId);
  const selected=caps.models.find(m=>m.id===caps.defaults.model);
  const pixels=randomBytes(2048*1536*3);
  for(let n=0;n<pixels.length;n+=3){pixels[n]=200+pixels[n]%56;pixels[n+1]%=65;pixels[n+2]%=65;}
  for (const [access,format] of [["workspace","png"],["full","jpeg"]]) {
    const settings={...caps.defaults,access,effort:selected.efforts.includes("low")?"low":caps.defaults.effort};
    const saved=await app.inject({method:"PATCH",url:"/api/threads/"+thread.id+"/settings",headers,payload:settings});
    assert.equal(saved.statusCode,200,saved.body);
    const source=sharp(pixels,{raw:{width:2048,height:1536,channels:3}});
    const bytes=await (format==="png"?source.png():source.jpeg({quality:98})).toBuffer();
    assert(bytes.length>1024*1024,"Use a photo-sized payload, not a tiny solid-color fixture");
    const upload=await app.inject({method:"POST",url:"/api/threads/"+thread.id+"/attachments?name="+encodeURIComponent("Фото проверка."+format),headers:{...headers,"content-type":"application/octet-stream"},payload:bytes});
    assert.equal(upload.statusCode,200,upload.body);
    const key=randomUUID(),payload={text:"Изолированная проверка веб-интерфейса. Назови преобладающий цвет приложенного изображения одним словом. Без инструментов и изменений файлов.",settings,attachments:[upload.json().id]};
    const started=Date.now();
    const sent=await app.inject({method:"POST",url:"/api/threads/"+thread.id+"/turns",headers:{...headers,"idempotency-key":key},payload});
    assert.equal(sent.statusCode,200,sent.body);
    const sendMs=Date.now()-started;
    const replay=await app.inject({method:"POST",url:"/api/threads/"+thread.id+"/turns",headers:{...headers,"idempotency-key":key},payload});
    assert.equal(replay.statusCode,200,replay.body);
    for(let n=0;n<900&&["running","starting","waiting_approval"].includes(store.thread(thread.id).status);n++)await new Promise(r=>setTimeout(r,100));
    assert.equal(store.thread(thread.id).status,"completed");
    const history=store.history(thread.id).messages;
    const answer=history.filter(m=>m.role==="assistant").at(-1)?.text??"";
    assert.match(answer,/красн|red/i);
    assert.equal(history.filter(m=>m.role==="user").length,report.length+1,"An idempotent retry must not duplicate a message");
    assert.equal(sessions.attachments.get(upload.json().id).messageId!==null,true);
    const native=await rpc.request("thread/resume",{threadId:thread.codexThreadId,excludeTurns:true});
    assert.equal(native.approvalPolicy,access==="full"?"never":"on-request");
    assert.equal(native.sandbox.type,access==="full"?"dangerFullAccess":"workspaceWrite");
    const item={access,format,bytes:bytes.length,sendMs,imageUnderstood:true,nativePermissionsVerified:true,noDuplicate:true};
    report.push(item);console.log(JSON.stringify(item));
  }
  await mkdir(".local/qa-large-attachments",{recursive:true});
  await writeFile(".local/qa-large-attachments/native.json",JSON.stringify(report,null,2));
} finally {
  if(thread&&rpc){
    if(["running","starting","waiting_approval"].includes(store.thread(thread.id).status))await sessions.interrupt(thread.id).catch(()=>{});
    await rpc.request("thread/archive",{threadId:thread.codexThreadId}).catch(()=>{});
  }
  await app.close();
  await rm(root,{recursive:true,force:true});
}
