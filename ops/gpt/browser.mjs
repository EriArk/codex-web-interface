import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {connect as connectSocket} from 'node:net';
import {privateState,readConnectorHealth} from './browser-health.mjs';
import {readAsset} from './browser-assets.mjs';
import {mutateLibrary} from './browser-library.mjs';
import {readModels,selectModels} from './browser-models.mjs';
import {prepareSession} from './browser-session.mjs';
import {activeConversation} from './conversation-binding.mjs';
import {readJson,proxyBridge} from './bridge-proxy.mjs';
import {timingSafeEqual} from 'node:crypto';
import {chromium} from 'playwright';
const children=[];let closing=false,context,server;
const start=(cmd,args)=>{const child=spawn(cmd,args,{stdio:['ignore','ignore','ignore']});children.push(child);child.on('error',()=>void close('child-start-'+cmd,1));child.on('exit',(code,signal)=>{if(!closing&&!args.includes('-storepasswd'))void close('child-exit-'+cmd+'-'+(signal||code),1)});return child};
process.on('SIGTERM',()=>void close('SIGTERM'));process.on('SIGINT',()=>void close('SIGINT'));
process.on('unhandledRejection',()=>void close('unhandled-rejection',1));
process.on('uncaughtException',()=>void close('uncaught-exception',1));
// The entrypoint holds /data/browser.lock exclusively across the process lifetime.
mkdirSync('/data/profile',{recursive:true,mode:0o700});
for(const path of ['/tmp/.X91-lock','/tmp/.X11-unix/X91','/data/profile/SingletonLock','/data/profile/SingletonCookie','/data/profile/SingletonSocket']){
 try{unlinkSync(path)}catch(e){if(e.code!=='ENOENT')throw e}
}
start('Xvfb',[':91','-screen','0','480x900x24','-nolisten','tcp','-ac']);
let displayReady=false;
for(let attempt=0;attempt<100&&!displayReady;attempt++){
 displayReady=await new Promise(resolve=>{const socket=connectSocket('/tmp/.X11-unix/X91');socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))});
 if(!displayReady)await new Promise(resolve=>setTimeout(resolve,50));
}
if(!displayReady)throw Error('GPT_DISPLAY_START_FAILED');
start('openbox',[]);
start('node',['/opt/gpt/bridge.mjs']);
const password=readFileSync('/data/vnc-password','utf8').trim();
await new Promise((resolve,reject)=>{const p=start('x11vnc',['-storepasswd',password,'/data/vnc-auth']);p.once('exit',code=>code===0?resolve():reject(Error('VNC password setup failed')))});
start('x11vnc',['-display',':91','-rfbauth','/data/vnc-auth','-rfbport','5900','-forever','-shared','-noxdamage','-repeat']);
context=await chromium.launchPersistentContext('/data/profile',{channel:'chromium',headless:false,viewport:null,args:['--hide-crash-restore-bubble','--no-first-run','--no-default-browser-check','--window-size=480,900','--start-maximized','--disable-extensions-except=/opt/bridge/tools/chrome-bridge-extension','--load-extension=/opt/bridge/tools/chrome-bridge-extension']});
context.on('close',()=>{if(!closing)void close('browser-closed',1)});
context.on('page',page=>page.on('crash',()=>console.error('GPT lifecycle: page-crashed')));
const bridgeToken=readFileSync('/data/bridge-token','utf8').trim();
await context.addInitScript(value=>{if(location.origin==='https://chatgpt.com'){localStorage.setItem('chatgptBridge:bridge.serverUrl',JSON.stringify('http://127.0.0.1:8080'));localStorage.setItem('chatgptBridge:bridge.token',JSON.stringify(value));localStorage.setItem('chatgptBridge:bridge.debug','false')}},bridgeToken);
const page=context.pages()[0]??await context.newPage();
await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
const token=readFileSync('/data/service-token','utf8').trim();
async function activePage(){
 const response=await fetch('http://127.0.0.1:8080/health',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
 const health=await response.json();
 const pages=context.pages().filter(p=>new URL(p.url()).origin==='https://chatgpt.com');
 const selected=pages.find(p=>p.url()===health.activeClient?.url);
 if(selected)return selected;
 if(pages.length===1)return pages[0];
 throw Error('GPT_ACTIVE_TAB_UNAVAILABLE');
}
function authorized(req){const v=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);return v.length===expected.length&&timingSafeEqual(v,expected)}
const storageState=privateState();
server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(!authorized(req)){res.writeHead(401).end();return}
 const url=new URL(req.url,'http://localhost');
 if(req.method==='POST'&&['/bridge/sessions/new','/bridge/sessions/select'].includes(url.pathname)){
  try{
   const body=await readJson(req,4096),sessionId=url.pathname.endsWith('/new')?null:(body.sessionId??'');
   const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
   const health=async()=>{const r=await fetch('http://127.0.0.1:8080/health',{headers,signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('GPT_BRIDGE_UNAVAILABLE');return r.json()};
   const result=await prepareSession({activePage,health,sessionId,command:async id=>{
    const r=await fetch('http://127.0.0.1:8080/sessions/'+(id?'select':'new'),{method:'POST',headers,body:JSON.stringify(id?{sessionId:id}:{}),signal:AbortSignal.timeout(15000)});
    await r.body?.cancel();return r.ok;
   }});
   res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
  }catch(error){console.error('GPT preparation:',error?.message==='GPT_UI_ATTENTION'?'GPT_UI_ATTENTION':'GPT_SESSION_NOT_READY');res.writeHead(409,{'Content-Type':'application/json','X-Codex-Gpt-Preparation':error?.message==='GPT_UI_ATTENTION'?'attention':'session-not-ready'}).end(JSON.stringify({error:'GPT_SESSION_NOT_READY'}))}
  return;
 }
 if(req.method==='POST'&&url.pathname==='/uploads/release'){
  try {
   const body=await readJson(req,4096);
   if(!Array.isArray(body.ids)||body.ids.length>8||body.ids.some(id=>typeof id!=='string'||!/^file_[a-f0-9]{20}$/.test(id)))throw Error('GPT_UPLOAD_IDS_INVALID');
   const headers={Authorization:'Bearer '+token};
   const health=await(await fetch('http://127.0.0.1:8080/health',{headers,signal:AbortSignal.timeout(5000)})).json();
   if(health.activeRequests?.length){res.writeHead(409).end('{}');return;}
   for(const id of body.ids) {
    const response=await fetch('http://127.0.0.1:8080/files/'+id,{method:'DELETE',headers,signal:AbortSignal.timeout(5000)});
    await response.body?.cancel();if(!response.ok&&response.status!==404)throw Error('GPT_UPLOAD_RELEASE_FAILED');
   }
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));
  }catch{res.writeHead(409).end('{}');}
  return;
 }
 if(url.pathname.startsWith('/bridge/')){await proxyBridge(req,res,url.pathname,token);return}
 if(req.method==='GET'&&url.pathname==='/asset'){
  const id=url.searchParams.get('id')??'';
  if(!/^file[-_][a-zA-Z0-9_-]{1,100}$/.test(id)){res.writeHead(400).end();return}
  try{
   const result=await readAsset(await activePage(),id);
   if(result.status!==200){res.writeHead(result.status).end();return}
   res.writeHead(200,{'Content-Type':result.mime}).end(Buffer.from(result.base64,'base64'));
  }catch{res.writeHead(503).end()}
  return;
 }
 if(req.method==='GET'&&url.pathname==='/sandbox-file'){
  const conversationId=url.searchParams.get('conversationId')??'',messageId=url.searchParams.get('messageId')??'',path=url.searchParams.get('path')??'';
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId)||!/^[a-zA-Z0-9_-]{1,100}$/.test(messageId)||!path.startsWith('/mnt/data/')||path.length>2048||/[\\\x00-\x1f\x7f?#%]/.test(path)||path.slice(1).split('/').some(p=>!p||p==='.'||p==='..')){res.writeHead(400).end();return}
  try{
   const result=await readAsset(await activePage(),null,{conversationId,messageId,path});
   if(result.status!==200){res.writeHead(result.status).end();return}
   res.writeHead(200,{'Content-Type':result.mime}).end(Buffer.from(result.base64,'base64'));
  }catch{res.writeHead(503).end()}
  return;
 }
 if(req.method==='POST'&&url.pathname==='/library'){
  try{
   const input=await readJson(req,4096);
   const health=await(await fetch('http://127.0.0.1:8080/health',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)})).json();
   if(health.activeRequests?.length){res.writeHead(409).end('{}');return}
   const result=await mutateLibrary(await activePage(),input);
   res.writeHead(result.status,{'Content-Type':'application/json'}).end(JSON.stringify({ok:result.ok===true}));
  }catch{res.writeHead(409,{'Content-Type':'application/json'}).end('{}')}
  return;
 }
 if(req.method==='POST'&&url.pathname==='/settings'){
  try{
   const settings=await readJson(req,4096);
   if(typeof settings.model!=='string'||settings.model.length>120||!/^\d$/.test(String(settings.effort)))throw Error('GPT_INVALID_SETTINGS');
   const target=await activePage();
   const result=await selectModels(target,settings);
   res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result));
  }catch(error){const reason=error?.message==='GPT_UI_ATTENTION'?'attention':(error?.name==='TimeoutError'||/Execution context was destroyed|Target.*closed|Cannot find context/i.test(error?.message??''))?'timeout':'settings-not-confirmed';console.error('GPT settings:',reason);res.writeHead(409,{'Content-Type':'application/json','X-Codex-Gpt-Preparation':reason}).end(JSON.stringify({error:'GPT_SETTINGS_NOT_CONFIRMED'}))}
  return;
 }
 if(req.method!=='GET'||!['/status','/catalog','/conversation','/bridge-health','/models','/projects','/active','/pins','/project'].includes(url.pathname)){res.writeHead(404).end();return}
 res.setHeader('Content-Type','application/json');
 try{
  if(url.pathname==='/status'){
   const report=await readConnectorHealth({health:async()=>{
    const r=await fetch('http://127.0.0.1:8080/health',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw Error('GPT_BRIDGE_UNAVAILABLE');return r.json();
   },pages:()=>context.pages(),privateState:storageState});
   res.end(JSON.stringify(report));return;
  }
  const target=await activePage();
  if(url.pathname==='/models'){res.end(JSON.stringify(await readModels(target)));return}
  if(url.pathname==='/active'){
   const health=await(await fetch('http://127.0.0.1:8080/health',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)})).json();
   res.end(JSON.stringify(activeConversation(health)));return;
  }
  if(url.pathname==='/bridge-health'){
   const upstream=await fetch('http://127.0.0.1:8080'+(url.pathname==='/models'?'/models':'/health'),{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
   res.statusCode=upstream.status;res.end(await upstream.text());return;
  }
  let path;
  if(url.pathname==='/pins'){path='/backend-api/pins'}else if(url.pathname==='/projects'){path='/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5'}else if(url.pathname==='/catalog'){
   const offset=Number(url.searchParams.get('offset')??0);
   if(!Number.isSafeInteger(offset)||offset<0||offset>100000){res.writeHead(400).end('{}');return}
   path='/backend-api/conversations?offset='+offset+'&limit=20&order=updated&is_archived='+(url.searchParams.get('archived')==='1'?'true':'false');
  }else{
   const id=url.searchParams.get('id')??'';
   if(!/^[a-z0-9-]{16,80}$/i.test(id)){res.writeHead(400).end('{}');return}
   path=(url.pathname==='/project'?'/backend-api/gizmos/':'/backend-api/conversation/')+encodeURIComponent(id);
  }
  if(new URL(target.url()).origin!=='https://chatgpt.com'){res.writeHead(409).end(JSON.stringify({error:'GPT_LOGIN_REQUIRED'}));return}
  const result=await target.evaluate(async path=>{
   // The account session stays inside its own browser origin; only requested conversation data leaves it.
   const sessionResponse=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(10000)});
   if(!sessionResponse.ok)return {status:401,error:'GPT_LOGIN_REQUIRED'};
   const session=await sessionResponse.json();
   if(typeof session.accessToken!=='string')return {status:401,error:'GPT_LOGIN_REQUIRED'};
   const response=await fetch(path,{credentials:'include',cache:'no-store',headers:{Authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(20000)});
   if(!response.ok)return {status:response.status,error:'GPT_READ_FAILED'};
   const reader=response.body.getReader(),chunks=[];let size=0;
   while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8*1024*1024){await reader.cancel();return {status:413,error:'GPT_HISTORY_TOO_LARGE'}}chunks.push(part.value)}
   const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length}
   return {status:200,data:JSON.parse(new TextDecoder().decode(bytes))};
  },path);
  res.statusCode=result.status;res.end(JSON.stringify(result.data??{error:result.error}));
 }catch{res.statusCode=503;res.end(JSON.stringify({error:'GPT_BROWSER_UNAVAILABLE'}))}
});
server.listen(8786,'0.0.0.0');
async function close(reason='signal',code=0){
 if(closing)return;closing=true;console.error('GPT lifecycle:',reason);
 server?.close();
 let timer;
 await Promise.race([context?.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,15000)})]);
 clearTimeout(timer);
 for(const p of children)if(p.exitCode===null)p.kill();
 process.exit(code);
}
console.log('GPT connection browser ready');
