import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from '../../apps/hub/node_modules/ws/wrapper.mjs';
import {connectRemote} from '../../apps/hub/dist/remote.js';
const origin=process.env.GPT_PUBLIC_ORIGIN;
if(!origin||new URL(origin).protocol!=='https:')throw Error('GPT_PUBLIC_ORIGIN required');
const hub=process.env.GPT_HUB_URL??'http://127.0.0.1:8780';
const root=fileURLToPath(new URL('.',import.meta.url));
const vncPassword=readFileSync(process.env.GPT_VNC_PASSWORD_FILE,'utf8').trim();
async function auth(req){if(!req.headers.cookie)return false;try{const r=await fetch(hub+'/api/auth/session',{headers:{cookie:req.headers.cookie},signal:AbortSignal.timeout(4000)});const ok=r.ok;await r.body?.cancel();return ok}catch{return false}}
const paths=new Map([
 ['/gpt-connect',['connect.html','text/html; charset=utf-8']],
 ['/gpt-connect/',['connect.html','text/html; charset=utf-8']],
 ['/gpt-connect/style.css',['connect.css','text/css']],
 ['/gpt-connect/client.js',['connect-client.js','application/javascript']],
 ['/gpt-connect/vendor.js',['../../apps/web/public/vendor/guacamole-1.6.0.min.js','application/javascript']]
]);
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
 if(req.method!=='GET'){res.writeHead(405).end();return}
 if(!(await auth(req))){res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><meta name="viewport" content="width=device-width"><p>Сначала войди в <a href="/">Codex Web</a>, затем открой эту ссылку ещё раз.</p>');return}
 const path=new URL(req.url,'http://localhost').pathname,asset=paths.get(path);
 if(!asset){res.writeHead(404).end();return}
 try{res.setHeader('Content-Type',asset[1]);res.end(readFileSync(root+asset[0]))}catch{res.writeHead(503).end('Connection page unavailable')}
});
const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
server.on('upgrade',async(req,socket,head)=>{
 if(new URL(req.url,'http://localhost').pathname!=='/gpt-connect/remote'||req.headers.origin!==origin||!(await auth(req))){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
 if(wss.clients.size>=2){socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');return}
 wss.handleUpgrade(req,socket,head,ws=>{
  const close=connectRemote(ws,{protocol:'vnc',parameters:{hostname:process.env.GPT_VNC_HOST??'codex-web-gpt-connect',port:'5900',password:vncPassword,'read-only':'false','disable-copy':'true','disable-paste':'true','enable-sftp':'false','enable-audio':'false','color-depth':'24',cursor:'local'}},{width:480,height:900});
  const timer=setInterval(async()=>{if(!(await auth(req)))close()},30000);timer.unref();ws.once('close',()=>clearInterval(timer));
 });
});
server.listen(Number(process.env.GPT_GATEWAY_PORT??8787),'127.0.0.1');
console.log('GPT login gateway ready');

for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const ws of wss.clients)ws.close(1001,'Connection service restarting');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref()});
