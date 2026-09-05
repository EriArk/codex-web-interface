import {readFile} from "node:fs/promises";
import {spawnCodex} from "../packages/machines/dist/index.js";
import {CodexClient} from "../packages/codex/dist/index.js";
const c=JSON.parse(await readFile(process.argv[2],"utf8"));
const p=c.projects[0], m=c.machines[0];
const rpc=new CodexClient(spawnCodex(m,p.workingDirectory));
let complete,fail,timer,verifiedRead=false;
const finished=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});
rpc.on("fault",e=>fail(e));
rpc.on("request",req=>{
 console.log({request:req.method});
 if(req.method.endsWith("/requestApproval")) rpc.respond(req.id,{decision:"decline"});
 else rpc.rejectRequest(req.id);
});
rpc.on("notification",(method,params)=>{
 if(method==="item/completed") {
  const item=params.item;
  if(item?.type==="commandExecution" && item.exitCode===0 && String(item.aggregatedOutput).includes("# Codex Web Interface")) verifiedRead=true;
  if(item?.type==="mcpToolCall" && item.status==="completed" && JSON.stringify(item.result??"").includes("# Codex Web Interface")) verifiedRead=true;
  console.log(JSON.stringify({item}).slice(0,7000));
 }
 if(method==="turn/completed") complete(params.turn);
});
try {
 await rpc.initialize();
 const {thread}=await rpc.request("thread/start",{cwd:p.workingDirectory,ephemeral:true,approvalPolicy:"on-request",sandbox:"read-only"});
 console.log({threadId:thread.id});
 timer=setTimeout(()=>fail(new Error("Smoke test timed out")),120000);
 await rpc.request("turn/start",{threadId:thread.id,input:[{type:"text",text:"Connection smoke test: run a read-only PowerShell command that prints the first 4 lines of README.md in this working directory. Do not edit files. Then briefly report the result in Russian. Use the available command tool to actually read the file; do not infer contents from context."}]});
 const turn=await finished;
 console.log({turnStatus:turn?.status,verifiedRead});
 if(turn?.status!=="completed" || !verifiedRead) process.exitCode=1;
} finally {clearTimeout(timer);rpc.close();}
