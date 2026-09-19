if(new URLSearchParams(location.search).get('immersive')==='1'){
 document.body.classList.add('immersive');
 const back=document.querySelector('header a');back.textContent='‹';back.setAttribute('aria-label','Назад к чату');
 const reload=document.querySelector('#reload');reload.textContent='↻';reload.setAttribute('aria-label','Переподключить Remote');
 const toggle=document.createElement('button');toggle.type='button';toggle.textContent='☷';toggle.setAttribute('aria-label','Управление Remote');toggle.setAttribute('aria-expanded','false');
 const footer=document.querySelector('footer');footer.hidden=true;toggle.onclick=()=>{footer.hidden=!footer.hidden;toggle.setAttribute('aria-expanded',String(!footer.hidden));};
 document.querySelector('header').insertBefore(toggle,reload);
}
const G=window.Guacamole,surface=document.querySelector('#surface'),host=document.querySelector('#display'),status=document.querySelector('#status'),sink=document.querySelector('#sink');
const nativeRuntime=document.querySelector('meta[name="codex-runtime"]')?.content==='native';
let client,keyboard,mouse,touch,remoteInput;
let nativeZoom=.8,nativePointer;
if(nativeRuntime){
 const reload=document.querySelector('#reload');reload.textContent='↻';reload.setAttribute('aria-label','Переподключить приложение');
 for(const [label,title,update] of [['−','Уменьшить',()=>nativeZoom=Math.max(.2,nativeZoom/1.25)],['+','Увеличить',()=>nativeZoom=Math.min(1.5,nativeZoom*1.25)],['⊡','Весь экран приложения',()=>nativeZoom=0]]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-label',title);button.onclick=()=>{update();resize()};reload.before(button);
 }
}
function text(value){status.textContent=value;status.hidden=!value}
function positionNative(d,center=false){
 if(!nativeRuntime)return;
 const scale=d.getScale(),w=surface.clientWidth,h=surface.clientHeight,point=nativePointer??{x:d.getWidth()/2,y:d.getHeight()/2};
 let left=center?w/2-point.x*scale:parseFloat(host.style.left)||0,top=center?h/2-point.y*scale:parseFloat(host.style.top)||0;
 const x=left+point.x*scale,y=top+point.y*scale;
 if(x<40)left+=40-x;else if(x>w-40)left+=w-40-x;
 if(y<40)top+=40-y;else if(y>h-40)top+=h-40-y;
 const bound=(value,viewport,size)=>size<=viewport?(viewport-size)/2:Math.max(viewport-size,Math.min(0,value));
 host.style.left=bound(left,w,d.getWidth()*scale)+'px';host.style.top=bound(top,h,d.getHeight()*scale)+'px';
}
function resize(){document.documentElement.style.setProperty('--height',(window.visualViewport?.height??innerHeight)+'px');if(!client)return;const d=client.getDisplay();if(!d.getWidth())return;const fit=Math.min(surface.clientWidth/d.getWidth(),surface.clientHeight/d.getHeight(),1),scale=nativeRuntime?Math.max(fit,nativeZoom):fit;d.scale(scale);host.style.left=Math.max(0,(surface.clientWidth-d.getWidth()*scale)/2)+'px';positionNative(d,true);}
async function connect(){
 remoteInput?.dispose();remoteInput=undefined;keyboard?.reset();client?.disconnect();host.replaceChildren();text(nativeRuntime?'Подключаем приложение…':'Подключаем браузер…');
 const workspace=document.querySelector('meta[name="codex-workspace"]')?.content;
 const query=new URLSearchParams();if(workspace)query.set('workspace',workspace);if(nativeRuntime)query.set('runtime','native');
 const tunnel=new G.WebSocketTunnel(location.origin.replace(/^http/,'ws')+'/gpt-connect/remote');
 client=new G.Client(tunnel);const active=client,d=active.getDisplay();host.append(d.getElement());d.onresize=resize;
 active.onerror=e=>{if(client===active)text(e.message||'Связь прервалась. Переподключись кнопкой сверху.')};tunnel.onerror=active.onerror;active.onstatechange=s=>{if(client!==active)return;if(s===3){text('');resize()}else if(s===5)text('Связь прервалась. Переподключись кнопкой сверху.')};
 if(nativeRuntime){
  d.showCursor(true);
  remoteInput=new window.RemoteInput(surface,{
   mode:()=> 'trackpad',scale:()=>d.getScale(),sensitivity:()=>1,
   direct:(x,y)=>{const rect=host.getBoundingClientRect();return {x:(x-rect.left)/d.getScale(),y:(y-rect.top)/d.getScale()}},
   clamp:(x,y)=>({x:Math.round(Math.max(0,Math.min((d.getWidth()||1280)-1,x))),y:Math.round(Math.max(0,Math.min((d.getHeight()||900)-1,y)))}),
   send:s=>active.sendMouseState(s,false),pointer:()=>d.showCursor(true),
   position:p=>{nativePointer=p;positionNative(d);d.moveCursor(p.x,p.y)},
   zoom:ratio=>{nativeZoom=Math.max(.2,Math.min(1.5,(nativeZoom||d.getScale())*ratio));resize()},
   pan:(x,y)=>{host.style.left=(parseFloat(host.style.left)||0)+x+'px';host.style.top=(parseFloat(host.style.top)||0)+y+'px';positionNative(d)}
  });
  remoteInput.setPosition(640,450);
 }else{
  mouse=new G.Mouse(d.getElement());mouse.onmousedown=mouse.onmouseup=mouse.onmousemove=s=>active.sendMouseState(s,true);
  touch=new G.Mouse.Touchscreen(d.getElement());touch.onmousedown=touch.onmouseup=touch.onmousemove=s=>active.sendMouseState(s,true);
 }
 keyboard??=new G.Keyboard(document.body);keyboard.onkeydown=k=>{if(document.activeElement!==sink&&document.activeElement!==surface)return true;active.sendKeyEvent(1,k);return false};keyboard.onkeyup=k=>active.sendKeyEvent(0,k);
 query.set('width',String(nativeRuntime?1280:480));query.set('height','900');
 active.connect(query.toString());
}
let committed='';
sink.addEventListener('compositionstart',e=>{committed='';e.stopPropagation()});
sink.addEventListener('compositionend',e=>{committed=e.data;sink.value='';setTimeout(()=>committed='',0)});
sink.addEventListener('input',e=>{if(!e.isComposing){if(committed&&e.data===committed)e.stopPropagation();committed='';sink.value=''}});
sink.addEventListener('keypress',()=>sink.value='');
const kb=document.querySelector('#keyboard');kb.onclick=()=>{if(document.activeElement===sink)sink.blur();else sink.focus({preventScroll:true})};
sink.onfocus=()=>kb.setAttribute('aria-pressed','true');sink.onblur=()=>{kb.setAttribute('aria-pressed','false');keyboard?.reset()};
document.querySelector('#reload').onclick=connect;
for(const button of document.querySelectorAll('[data-key]'))button.onclick=()=>{const k=Number(button.dataset.key);client?.sendKeyEvent(1,k);client?.sendKeyEvent(0,k)};
window.addEventListener('resize',resize);visualViewport?.addEventListener('resize',resize);window.addEventListener('blur',()=>{remoteInput?.reset();keyboard?.reset()});window.addEventListener('pagehide',()=>{remoteInput?.dispose();client?.disconnect()});resize();connect();
