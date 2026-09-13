import { lookup } from 'node:dns/promises';
import { createServer, request } from 'node:http';
import { connect, createServer as tcpServer, isIPv4 } from 'node:net';
import { pathToFileURL } from 'node:url';

// Public IPv4 only. No alternate numeric forms, mapped IPv6, Tailnet, metadata,
// multicast or special-purpose destinations. Resolve once, then connect by IP.
export function publicIPv4(address) {
 if (!isIPv4(address)) return false;
 const [a,b,c] = address.split('.').map(Number);
 return !(a===0 || a===10 || a===127 || a>=224 ||
  (a===100 && b>=64 && b<=127) || (a===169 && b===254) ||
  (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) ||
  (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}
export async function publicTarget(value, tunnel, resolver=lookup) {
 const url=new URL(tunnel?'https://'+value:value);
 if(url.username || url.password || url.hash || url.protocol!==(tunnel?'https:':'http:') ||
    (url.port && url.port!==String(tunnel?443:80)) ||
    (tunnel && (url.pathname!=='/' || url.search || !/^[a-zA-Z0-9.-]+:443$/.test(value)))) throw Error('EGRESS_DENIED');
 const addresses=await resolver(url.hostname,{all:true,family:4});
 if(!addresses.length || addresses.some(item=>!publicIPv4(item.address))) throw Error('EGRESS_DENIED');
 return {address:addresses[0].address,port:tunnel?443:80,url};
}
const cleanHeaders=headers=>{
 const blocked=new Set(['connection','proxy-connection','proxy-authorization','proxy-authenticate','keep-alive','upgrade','te','trailer','transfer-encoding',...(String(headers.connection??'').toLowerCase().split(',').map(s=>s.trim()))]);
 return Object.fromEntries(Object.entries(headers).filter(([key])=>!blocked.has(key.toLowerCase())));
};
export function publicProxy({resolveTarget=publicTarget}={}) {
 const server=createServer({maxHeaderSize:16384,requestTimeout:120000,headersTimeout:15000},async(req,res)=>{
  try{
   const target=await resolveTarget(req.url,false);
   if(req.destroyed)return;
   const outgoing=request({host:target.address,port:target.port,path:target.url.pathname+target.url.search,method:req.method,
    headers:{...cleanHeaders(req.headers),host:target.url.host},agent:false,timeout:120000},reply=>{
     res.writeHead(reply.statusCode??502,cleanHeaders(reply.headers));reply.pipe(res);
   });
   outgoing.on('timeout',()=>outgoing.destroy());outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
   res.on('close',()=>outgoing.destroy());req.pipe(outgoing);
  }catch{res.writeHead(403).end();}
 });
 server.maxConnections=128;
 server.on('connect',async(req,client,head)=>{
  client.on('error',()=>{});
  try{
   const target=await resolveTarget(req.url,true);
   if(client.destroyed)return;
   const remote=connect({host:target.address,port:target.port});
   const close=()=>{remote.destroy();client.destroy();};
   client.on('close',close);remote.on('error',close);remote.on('close',close);
   client.setTimeout(120000,close);remote.setTimeout(120000,close);
   remote.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);});
  }catch{client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 });
 server.on('clientError',(_,socket)=>socket.destroy());
 return server;
}

// Ingress has fixed destinations inside this user's isolated network. No caller
// destination, Docker socket, account secret or filesystem mount is accepted.
export function fixedIngress(host,port) {
 const server=tcpServer(client=>{
  const remote=connect({host,port}),close=()=>{client.destroy();remote.destroy();};
  client.on('error',close);remote.on('error',close);client.on('close',close);remote.on('close',close);
  client.setTimeout(600000,close);remote.setTimeout(600000,close);client.pipe(remote);remote.pipe(client);
 });
 server.maxConnections=64;return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const id=process.env.GPT_WORKSPACE_ID;
 if(!/^[a-f0-9-]{36}$/.test(id??''))throw Error('GPT_WORKSPACE_INVALID');
 const servers=[publicProxy(),fixedIngress('codex-web-gpt-'+id,8786),fixedIngress('codex-web-gpt-'+id+'-remote',4822)];
 servers.forEach((server,i)=>server.listen([3128,8786,4822][i],'0.0.0.0'));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{servers.forEach(s=>s.close());setTimeout(()=>process.exit(0),1000).unref();});
}
