'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile),root=__dirname,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=async file=>{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>262144)throw Error('INVALID_REQUEST');return JSON.parse(await fs.readFile(file,'utf8'));};
async function worker(){
 const {setupProbe}=await import('./setupProbe.js');let empty=0;const deadline=Date.now()+540000;
 while(Date.now()<deadline&&empty<8){
  let count=0;
  for(const file of (await fs.readdir(root)).filter(n=>/^[a-f0-9-]{36}\.request\.json$/.test(n)).slice(0,24)){
   const output=file.replace('.request.json','.response.json');if(await fs.stat(path.join(root,output)).then(()=>true,()=>false))continue;
   let result;
   try {const job=await read(path.join(root,file));if(Date.now()-job.at>300000)throw Error('REQUEST_EXPIRED');result={ok:true,value:await setupProbe(job.request)};}
   catch(e){result={ok:false,code:/^[A-Z_]{3,60}$/.test(e.message)?e.message:'SETUP_UNAVAILABLE'};}
   const temp=path.join(root,output+'.tmp');await fs.writeFile(temp,JSON.stringify(result),{flag:'wx',mode:0o600});await fs.rename(temp,path.join(root,output));count++;
  }
  empty=count?0:empty+1;await sleep(250);
 }
}
async function request(){
 let source='';for await(const chunk of process.stdin){source+=chunk;if(source.length>32768)throw Error('INVALID_REQUEST');}
 const request=JSON.parse(source);if(!['inspect','repositories','apply','status'].includes(request.op))throw Error('INVALID_REQUEST');
 if(request.op==='status'){const {setupProbe}=await import('./setupProbe.js');process.stdout.write(JSON.stringify({ok:true,value:await setupProbe(request)}));return;}
 const files=await fs.readdir(root);
 for(const file of files.filter(n=>/^[a-f0-9-]{36}\.(request|response)\.json(?:\.tmp)?$/.test(n))){const target=path.join(root,file),s=await fs.lstat(target);if(s.isFile()&&!s.isSymbolicLink()&&Date.now()-s.mtimeMs>600000)await fs.unlink(target).catch(()=>{});}
 if((await fs.readdir(root)).filter(n=>n.endsWith('.request.json')).length>=24)throw Error('SETUP_BUSY');
 const id=randomUUID(),input=path.join(root,id+'.request.json'),output=path.join(root,id+'.response.json');
 await fs.writeFile(input,JSON.stringify({request,at:Date.now()}),{flag:'wx',mode:0o600});
 const start=()=>run(path.join(process.env.SystemRoot||'C:\\Windows','System32','schtasks.exe'),['/Run','/TN','CodexWebProjectSetup'],{windowsHide:true,timeout:2000,maxBuffer:4096});
 try {
  await start();let next=Date.now()+3000;const deadline=Date.now()+(request.op==='apply'?240000:35000);
  while(Date.now()<deadline){
   try{const value=await read(output);process.stdout.write(JSON.stringify(value));return;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(Date.now()>=next){await start().catch(()=>{});next=Date.now()+3000;}await sleep(200);
  }
  throw Error('SETUP_UNAVAILABLE');
 }finally{await fs.unlink(input).catch(()=>{});await fs.unlink(output).catch(()=>{});}
}
if(process.platform!=='win32')throw Error('WINDOWS_REQUIRED');
(process.argv.length===3&&process.argv[2]==='worker'?worker():process.argv.length===3&&process.argv[2]==='request'?request():Promise.reject(Error('INVALID_REQUEST'))).catch(()=>{process.stdout.write(JSON.stringify({ok:false,code:'SETUP_UNAVAILABLE'}));process.exitCode=1;});
