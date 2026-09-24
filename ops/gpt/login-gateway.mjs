import {watchHubSession,gptSessionAllowed} from './session-watch.mjs';
import {teamConnection} from './team-connection.mjs';
import {nativeRecoveryBinding,beginNativeRecovery} from './native-recovery.mjs';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {WebSocketServer} from '../../apps/hub/node_modules/ws/wrapper.mjs';
import {connectRemote} from '../../apps/hub/dist/remote.js';
import {NativeGptReadClient} from '../../apps/hub/dist/gpt-native.js';
import {randomUUID} from 'node:crypto';
const origin=process.env.GPT_PUBLIC_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:')throw Error('GPT_PUBLIC_ORIGIN required');
const hub=process.env.GPT_HUB_URL??'http://127.0.0.1:8780';
const root=fileURLToPath(new URL('.',import.meta.url));
const engineSocket=process.env.HUB_ENGINE_SOCKET;
const vncPassword=process.env.GPT_VNC_PASSWORD_FILE?readFileSync(process.env.GPT_VNC_PASSWORD_FILE,'utf8').trim():undefined;
const nativeConfig={userId:process.env.GPT_NATIVE_USER_ID,password:process.env.GPT_NATIVE_VNC_PASSWORD_FILE?readFileSync(process.env.GPT_NATIVE_VNC_PASSWORD_FILE,'utf8').trim():undefined};
const nativeSocket=process.env.GPT_NATIVE_ADAPTER_SOCKET;
const nativeStates=new Map();
function nativeState(userId){let state=nativeStates.get(userId);if(!state){state={resuming:false,opening:0,closing:new Set()};nativeStates.set(userId,state);}return state;}
function nativeSocketFor(binding){
 if(!binding?.native)return undefined;
 if(binding.legacy)return binding.userId===nativeConfig.userId?nativeSocket:undefined;
 return process.env.GPT_TEAM_ROOT?.startsWith('/')?join(process.env.GPT_TEAM_ROOT,'users',binding.userId,'gpt','native-adapter','adapter.sock'):undefined;
}
function nativeClient(binding){
 const socketPath=nativeSocketFor(binding);
 if(!socketPath)throw Error('NATIVE_UNAVAILABLE');
 return new NativeGptReadClient({socketPath,userId:binding.userId},()=>{},'/gpt-connect/native');
}
async function auth(req){
 if(!req.headers.cookie)return null;
 try{
  const params=new URL(req.url,'http://localhost').searchParams;
  const runtime=new URL(req.url,'http://localhost').pathname.startsWith('/gpt-connect/native/')?'native':params.get('runtime');
  const expected=params.get('workspace');
  if(engineSocket){
   try{return nativeRecoveryBinding(await teamConnection(engineSocket,req.headers.cookie,origin,expected),runtime,nativeConfig);}
   catch{if(runtime!=='native')return null;}
   // Preserve the separately provisioned owner's recovery page before its Hub
   // provider is activated. The session/identity checks below exclude members.
  }
  const r=await fetch(hub+'/api/auth/session',{headers:{cookie:req.headers.cookie,origin},signal:AbortSignal.timeout(4000)});
  if(!r.ok){await r.body?.cancel();return null;}
  const session=await r.json();
  if(runtime==='native'&&session.originalOwner!==true)return null;
  if(!gptSessionAllowed(session,process.env.GPT_WORKSPACE_USER_ID)|| (expected&&expected!==session.user?.id))return null;
  return nativeRecoveryBinding({legacy:true,userId:session.user?.id},runtime,nativeConfig);
 }catch{return null;}
}
const paths=new Map([
 ['/gpt-connect',['connect.html','text/html; charset=utf-8']],
 ['/gpt-connect/',['connect.html','text/html; charset=utf-8']],
 ['/gpt-connect/style.css',['connect.css','text/css']],
 ['/gpt-connect/client.js',['connect-client.js','application/javascript']],
 ['/gpt-connect/input.js',['../../apps/web/src/remoteInput.ts','application/javascript']],
 ['/gpt-connect/vendor.js',['../../apps/web/public/vendor/guacamole-1.6.0.min.js','application/javascript']]
]);
let sharedInput;
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
 const requestPath=new URL(req.url,'http://localhost').pathname;
 const resume=requestPath==='/gpt-connect/native/resume'&&req.method==='POST';
 if(req.method!=='GET'&&!resume){res.writeHead(405).end();return}
 if(resume&&(req.headers.origin!==origin||req.headers['content-type']!=='application/json')){res.writeHead(403).end();return}
 const binding=await auth(req);
 if(!binding){res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><meta name="viewport" content="width=device-width"><p>Проверь вход и готовность личного браузера в <a href="/">Codex Web</a>, затем открой эту страницу ещё раз.</p>');return}
 if(requestPath.startsWith('/gpt-connect/native/')){
  try{
   const adapter=nativeClient(binding),state=nativeState(binding.userId);
   if(resume){
    if(state.resuming||state.opening){res.writeHead(409).end();return}
    let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>64)throw Error('NATIVE_INVALID_REQUEST');}
    const current=await auth(req);if(!current?.native||current.userId!==binding.userId){res.writeHead(401).end();return}
    if(state.resuming||state.opening){res.writeHead(409).end();return}
    state.resuming=true;
    try{
     if(state.opening){res.writeHead(409).end();return}
     for(const ws of wss.clients)if(ws.native&&ws.workspace===binding.userId){ws.endNative?.();ws.close(1000,'Returning to website');}
     await Promise.allSettled([...state.closing]);
     await adapter.manual('resumeManual');
     res.end(JSON.stringify({ok:true}));
    }finally{state.resuming=false;}
    return;
   }
   if(req.method!=='GET'){res.writeHead(405).end();return}
   const history=requestPath.match(/^\/gpt-connect\/native\/history\/([a-f0-9-]{36})$/i);
   const download=requestPath.match(/^\/gpt-connect\/native\/downloads\/([a-f0-9-]{36})\/([a-zA-Z0-9_-]{1,100})\/(sandbox-[a-f0-9]{64})$/);
   let value;
   if(requestPath==='/gpt-connect/native/status')value=await adapter.status();
   else if(history)value=await adapter.history(history[1],new URL(req.url,'http://localhost').searchParams.get('before')??undefined);
   else if(download)value=await adapter.download(download[1],download[2],download[3]);
   else{res.writeHead(404).end();return}
   const current=await auth(req);if(!current?.native||current.userId!==binding.userId){res.writeHead(401).end();return}
   if(download){res.setHeader('Content-Type',value.file.image?value.file.mime:'application/octet-stream');res.setHeader('Content-Disposition',(value.file.image?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(value.file.name));res.end(value.bytes);}
   else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
  }catch{res.writeHead(503).end(JSON.stringify({ok:false,code:'NATIVE_UNAVAILABLE'}));}
  return;
 }
 const path=new URL(req.url,'http://localhost').pathname,asset=paths.get(path);
 if(!asset){res.writeHead(404).end();return}
 try{
  res.setHeader('Content-Type',asset[1]);
  let content=readFileSync(root+asset[0]);
  // Serve the same gesture implementation as PC Remote, with no separate
  // generated copy to drift. This service already requires repository Node 24.
  if(path==='/gpt-connect/input.js')content=Buffer.from(sharedInput??=stripTypeScriptTypes(content.toString('utf8'),{mode:'transform'}).replace('export class RemoteInput','window.RemoteInput = class RemoteInput'));
  if(asset[0]==='connect.html'&&binding.userId){
   if(!/^[a-f0-9-]{36}$/.test(binding.userId))throw Error();
   content=Buffer.from(content.toString('utf8').replace('<meta charset="utf-8">','<meta charset="utf-8"><meta name="codex-workspace" content="'+binding.userId+'">'));
  }
  if(asset[0]==='connect.html'&&binding.native){
   content=Buffer.from(content.toString('utf8')
    .replace('<meta charset="utf-8">','<meta charset="utf-8"><meta name="codex-runtime" content="native">')
    .replaceAll('Подключение ChatGPT','ChatGPT · Linux-клиент').replace('Открываем браузер…','Открываем приложение…')
    .replace('<script src="/gpt-connect/client.js">','<script src="/gpt-connect/input.js"></script><script src="/gpt-connect/client.js">')
    .replaceAll(/(src|href)="(\/gpt-connect\/[^"?]+)"/g,'$1="$2?runtime=native&workspace='+binding.userId+'"'));
   if(nativeSocketFor(binding))content=Buffer.from(content.toString('utf8').replace('<meta charset="utf-8">','<meta charset="utf-8"><meta name="codex-native-adapter" content="read-only">'));
  }
  res.end(content);
 }catch{res.writeHead(503).end('Connection page unavailable')}
});
server.requestTimeout=10000;server.headersTimeout=10000;
const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
server.on('upgrade',async(req,socket,head)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname!=='/gpt-connect/remote'||req.headers.origin!==origin){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
 const binding=await auth(req);
 if(!binding||(engineSocket&&!url.searchParams.get('workspace'))||(binding.legacy&&!binding.native&&!vncPassword)){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
 if([...wss.clients].filter(client=>client.workspace===binding.userId).length>=2){socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');return}
 let adapter,leaseId;
 const state=nativeState(binding.userId);
 if(binding.native){
  if(state.resuming){socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');return}
  state.opening++;
  try{adapter=nativeClient(binding);leaseId=randomUUID();await beginNativeRecovery(adapter,leaseId,()=>socket.destroyed);}
  catch{await adapter?.manual('endManual',leaseId).catch(()=>{});socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return}
  finally{state.opening--;}
  if(socket.destroyed){await adapter.manual('endManual',leaseId).catch(()=>{});return}
 }
 wss.handleUpgrade(req,socket,head,ws=>{
  ws.workspace=binding.userId;
  ws.native=!!binding.native;
  let close,ended=false;
  const end=()=>{
   if(ended)return;ended=true;close?.();
   if(adapter){const closing=adapter.manual('endManual',leaseId).catch(()=>{}).finally(()=>state.closing.delete(closing));state.closing.add(closing);}
  };
  ws.endNative=end;
  const stopWatch=watchHubSession(hub,origin,req.headers.cookie,()=>{
   if(ws.readyState!==1||ended)return;
   close=connectRemote(ws,{protocol:'vnc',parameters:{hostname:binding.native?binding.host:binding.legacy?(process.env.GPT_VNC_HOST??'codex-web-gpt-connect'):binding.host,port:'5900',password:binding.native?binding.password:binding.legacy?vncPassword:binding.password,'read-only':'false','disable-copy':'true','disable-paste':'true','enable-sftp':'false','enable-audio':'false','color-depth':'24',cursor:'local'}},{width:binding.native?1280:480,height:900},binding.legacy?(binding.native?Number(process.env.GPT_NATIVE_GUACD_PORT??4822):4822):binding.gatewayPort);
  },()=>{end();ws.close(1008,'Session ended');});
  ws.once('close',()=>{stopWatch();end();});
 });
});
server.listen(Number(process.env.GPT_GATEWAY_PORT??8787),'127.0.0.1',()=>console.log('GPT login gateway ready'));

for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const ws of wss.clients)ws.close(1001,'Connection service restarting');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref()});
