import { readFile } from "node:fs/promises";
import { spawnCodex, probeCodex } from "../packages/machines/dist/index.js";
import { CodexClient } from "../packages/codex/dist/index.js";
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
const machine=config.machines.find(m=>m.id===process.argv[3]);
const project=config.projects.find(p=>p.machineId===machine.id);
console.log(await probeCodex(machine,project.workingDirectory));
const child=spawnCodex(machine,project.workingDirectory);
const client=new CodexClient(child,45000);
client.on("fault",e=>console.log({code:e.code}));
client.on("request",req=>client.rejectRequest(req.id));
try {
  const hello=await client.initialize();
  console.log({handshake:true,platformOs:hello.platformOs,userAgent:hello.userAgent});
  const auth=await client.request("account/read",{refreshToken:false});
  console.log({requiresOpenaiAuth:auth.requiresOpenaiAuth,accountType:auth.account?.type??null});
  const models=await client.request("model/list",{});
  console.log({modelsAvailable:models.data?.length});
  const result=await client.request("command/exec",{command:["powershell.exe","-NoProfile","-Command","Get-Content -LiteralPath README.md -TotalCount 4"],cwd:project.workingDirectory,timeoutMs:10000,sandboxPolicy:{type:"readOnly"}});
  console.log(result);
} finally { client.close(); }
