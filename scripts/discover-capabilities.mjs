import { readFile } from "node:fs/promises";
import { spawnCodex } from "../packages/machines/dist/index.js";
import { CodexClient } from "../packages/codex/dist/index.js";
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
const p=config.projects[0],m=config.machines.find(m=>m.id===p.machineId);
const c=new CodexClient(spawnCodex(m,p.workingDirectory),45000);
c.on("fault",()=>{});c.on("request",r=>c.rejectRequest(r.id));
try {
 await c.request("initialize",{clientInfo:{name:"codex_web_interface",version:"0.1.0"},capabilities:{experimentalApi:true}});
 c.notify("initialized",{});
 for(const method of ["model/list","collaborationMode/list","config/read"]) {
  try {const r=await c.request(method,method==="model/list"?{limit:100,includeHidden:false}:method==="config/read"?{includeLayers:false,cwd:p.workingDirectory}:{});
   console.log(JSON.stringify({method,result:method==="config/read"?{model:r.config?.model,effort:r.config?.model_reasoning_effort}:r}));
  }catch(e){console.log({method,code:e.code});}
 }
}finally{c.close();}
