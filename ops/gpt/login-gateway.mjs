import {watchHubSession,gptSessionAllowed} from './session-watch.mjs';
import {teamConnection} from './team-connection.mjs';
import {nativeRecoveryBinding} from './native-recovery.mjs';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {WebSocketServer} from '../../apps/hub/node_modules/ws/wrapper.mjs';
import {connectRemote} from '../../apps/hub/dist/remote.js';
const origin=process.env.GPT_PUBLIC_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:')throw Error('GPT_PUBLIC_ORIGIN required');
const hub=process.env.GPT_HUB_URL??'http://127.0.0.1:8780';
const root=fileURLToPath(new URL('.',import.meta.url));
const engineSocket=process.env.HUB_ENGINE_SOCKET;
const vncPassword=process.env.GPT_VNC_PASSWORD_FILE?readFileSync(process.env.GPT_VNC_PASSWORD_FILE,'utf8').trim():undefined;
const nativeConfig={userId:process.env.GPT_NATIVE_USER_ID,password:process.env.GPT_NATIVE_VNC_PASSWORD_FILE?readFileSync(process.env.GPT_NATIVE_VNC_PASSWORD_FILE,'utf8').trim():undefined};
async function auth(req){
 if(!req.headers.cookie)return null;
 try{
  const params=new URL(req.url,'http://localhost').searchParams;
  const expected=params.get('workspace');
  if(engineSocket&&params.get('runtime')!=='native')return nativeRecoveryBinding(await teamConnection(engineSocket,req.headers.cookie,origin,expected),params.get('runtime'),nativeConfig);
  const r=await fetch(hub+'/api/auth/session',{headers:{cookie:req.headers.cookie,origin},signal:AbortSignal.timeout(4000)});
  if(!r.ok){await r.body?.cancel();return null;}
  const session=await r.json();
  if(params.get('runtime')==='native'&&session.originalOwner!==true)return null;
  if(!gptSessionAllowed(session,process.env.GPT_WORKSPACE_USER_ID)|| (expected&&expected!==session.user?.id))return null;
  return nativeRecoveryBinding({legacy:true,userId:session.user?.id},params.get('runtime'),nativeConfig);
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
 if(req.method!=='GET'){res.writeHead(405).end();return}
 const binding=await auth(req);
 if(!binding){res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><meta name="viewport" content="width=device-width"><p>Проверь вход и готовность личного браузера в <a href="/">Codex Web</a>, затем открой эту страницу ещё раз.</p>');return}
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
  }
  res.end(content);
 }catch{res.writeHead(503).end('Connection page unavailable')}
});
const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
server.on('upgrade',async(req,socket,head)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname!=='/gpt-connect/remote'||req.headers.origin!==origin){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
 const binding=await auth(req);
 if(!binding||(engineSocket&&!url.searchParams.get('workspace'))||(binding.legacy&&!binding.native&&!vncPassword)){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
 if([...wss.clients].filter(client=>client.workspace===binding.userId).length>=2){socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');return}
 wss.handleUpgrade(req,socket,head,ws=>{
  ws.workspace=binding.userId;
  let close;
  const stopWatch=watchHubSession(hub,origin,req.headers.cookie,()=>{
   if(ws.readyState!==1)return;
   close=connectRemote(ws,{protocol:'vnc',parameters:{hostname:binding.native?binding.host:binding.legacy?(process.env.GPT_VNC_HOST??'codex-web-gpt-connect'):binding.host,port:'5900',password:binding.native?binding.password:binding.legacy?vncPassword:binding.password,'read-only':'false','disable-copy':'true','disable-paste':'true','enable-sftp':'false','enable-audio':'false','color-depth':'24',cursor:'local'}},{width:binding.native?1280:480,height:900},binding.legacy?4822:binding.gatewayPort);
  },()=>{close?.();ws.close(1008,'Session ended');});
  ws.once('close',()=>{stopWatch();close?.();});
 });
});
server.listen(Number(process.env.GPT_GATEWAY_PORT??8787),'127.0.0.1',()=>console.log('GPT login gateway ready'));

for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const ws of wss.clients)ws.close(1001,'Connection service restarting');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref()});
