import WebSocket from '../../apps/hub/node_modules/ws/wrapper.mjs';

// This stream carries only session readiness. Owner content and credentials never
// travel back to the browser connection page.
export function watchHubSession(hub, origin, cookie, onReady, onEnd) {
 const url=new URL('/api/auth/watch',hub);
 url.protocol=url.protocol==='https:'?'wss:':'ws:';
 const socket=new WebSocket(url,{headers:{Origin:origin,Cookie:cookie},handshakeTimeout:5000});
 let stopped=false,ready=false,timer;
 const end=()=>{if(stopped)return;stopped=true;clearTimeout(timer);socket.terminate();onEnd();};
 const arm=(ms)=>{clearTimeout(timer);timer=setTimeout(end,ms);timer.unref();};
 arm(6000);
 socket.on('message',data=>{
  if(ready)return;
  try {if(JSON.parse(String(data)).type!=='session.ready')return;} catch{return;}
  ready=true;arm(60000);onReady();
 });
 socket.on('ping',()=>{if(ready)arm(60000);});
 socket.on('close',end);socket.on('error',end);
 return ()=>{if(stopped)return;stopped=true;clearTimeout(timer);socket.terminate();};
}
