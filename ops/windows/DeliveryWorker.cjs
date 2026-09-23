'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile),root=__dirname,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=async (file,max=2097152)=>{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>max)throw Error('DELIVERY_REQUEST');return JSON.parse(await fs.readFile(file,'utf8'));};
const valid=v=>v&&v.request&&['inspect','prepare','apply','status','github'].includes(v.request.op)&&((typeof v.root==='string'&&path.isAbsolute(v.root)&&v.root.length<=2048)||(v.root===null&&v.request.op==='github'));
async function worker(){
 const {deliveryProbe}=await import('./deliveryProbe.js');let empty=0;const deadline=Date.now()+540000;
 while(Date.now()<deadline&&empty<8){
  let count=0;
  for(const file of (await fs.readdir(root)).filter(n=>/^[a-f0-9-]{36}\.request\.json$/.test(n)).slice(0,12)){
   const output=file.replace('.request.json','.response.json');if(await fs.stat(path.join(root,output)).then(()=>true,()=>false))continue;
   let result;
   try {const job=await read(path.join(root,file),524288);if(!valid(job)||Date.now()-job.at>300000)throw Error('DELIVERY_REQUEST');result={ok:true,value:job.request.op==='github'?await (await import('./githubWorkProbe.js')).githubWorkProbe(job.root,job.request.request):await deliveryProbe(job.root,job.request)};}
   catch(e){result={ok:false,code:/^[A-Z_]{3,60}$/.test(e.message)?e.message:'DELIVERY_UNAVAILABLE'};}
   const temp=path.join(root,output+'.tmp');await fs.writeFile(temp,JSON.stringify(result),{flag:'wx',mode:0o600});await fs.rename(temp,path.join(root,output));count++;
  }
  empty=count?0:empty+1;await sleep(250);
 }
}
async function request(){
 let source='';for await(const chunk of process.stdin){source+=chunk;if(source.length>524288)throw Error('DELIVERY_REQUEST');}
 const value=JSON.parse(source);if(!valid(value))throw Error('DELIVERY_REQUEST');
 for(const file of (await fs.readdir(root)).filter(n=>/^[a-f0-9-]{36}\.(request|response)\.json(?:\.tmp)?$/.test(n))){const target=path.join(root,file),s=await fs.lstat(target);if(s.isFile()&&!s.isSymbolicLink()&&Date.now()-s.mtimeMs>600000)await fs.unlink(target).catch(()=>{});}
 if((await fs.readdir(root)).filter(n=>n.endsWith('.request.json')).length>=12)throw Error('DELIVERY_BUSY');
 const id=randomUUID(),input=path.join(root,id+'.request.json'),output=path.join(root,id+'.response.json'),temp=input+'.tmp';
 await fs.writeFile(temp,JSON.stringify({...value,at:Date.now()}),{flag:'wx',mode:0o600});await fs.rename(temp,input);
 const start=()=>run(path.join(process.env.SystemRoot||'C:\\Windows','System32','schtasks.exe'),['/Run','/TN','CodexWebDelivery'],{windowsHide:true,timeout:2000,maxBuffer:4096});
 try {await start();let next=Date.now()+3000;const deadline=Date.now()+(['apply','github'].includes(value.request.op)?240000:170000);
  while(Date.now()<deadline){try{process.stdout.write(JSON.stringify(await read(output)));return;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(Date.now()>=next){await start().catch(()=>{});next=Date.now()+3000;}await sleep(200);}
  throw Error('DELIVERY_UNAVAILABLE');
 }finally{await fs.unlink(input).catch(()=>{});await fs.unlink(output).catch(()=>{});}
}
if(process.platform!=='win32')throw Error('WINDOWS_REQUIRED');
(process.argv.length===3&&process.argv[2]==='worker'?worker():process.argv.length===3&&process.argv[2]==='request'?request():Promise.reject(Error('DELIVERY_REQUEST'))).catch(()=>{process.stdout.write(JSON.stringify({ok:false,code:'DELIVERY_UNAVAILABLE'}));process.exitCode=1;});
