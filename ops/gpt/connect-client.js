const G=window.Guacamole,surface=document.querySelector('#surface'),host=document.querySelector('#display'),status=document.querySelector('#status'),sink=document.querySelector('#sink');
let client,keyboard,mouse,touch;
function text(value){status.textContent=value;status.hidden=!value}
function resize(){document.documentElement.style.setProperty('--height',(window.visualViewport?.height??innerHeight)+'px');if(!client)return;const d=client.getDisplay();if(!d.getWidth())return;const scale=Math.min(surface.clientWidth/d.getWidth(),surface.clientHeight/d.getHeight(),1);d.scale(scale);host.style.left=Math.max(0,(surface.clientWidth-d.getWidth()*scale)/2)+'px';}
async function connect(){
 client?.disconnect();host.replaceChildren();text('Подключаем браузер…');
 const tunnel=new G.WebSocketTunnel(location.origin.replace(/^http/,'ws')+'/gpt-connect/remote');
 client=new G.Client(tunnel);const active=client,d=active.getDisplay();host.append(d.getElement());d.onresize=resize;
 active.onerror=e=>text(e.message||'Связь прервалась. Нажми «Подключиться».');tunnel.onerror=active.onerror;active.onstatechange=s=>{if(s===3){text('');resize()}else if(s===5)text('Браузер отключён. Нажми «Подключиться».')};
 mouse=new G.Mouse(d.getElement());mouse.onmousedown=mouse.onmouseup=mouse.onmousemove=s=>active.sendMouseState(s,true);
 touch=new G.Mouse.Touchscreen(d.getElement());touch.onmousedown=touch.onmouseup=touch.onmousemove=s=>active.sendMouseState(s,true);
 keyboard??=new G.Keyboard(document.body);keyboard.onkeydown=k=>{if(document.activeElement!==sink&&document.activeElement!==surface)return true;active.sendKeyEvent(1,k);return false};keyboard.onkeyup=k=>active.sendKeyEvent(0,k);
 active.connect('width=480&height=900');
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
window.addEventListener('resize',resize);visualViewport?.addEventListener('resize',resize);window.addEventListener('pagehide',()=>client?.disconnect());resize();connect();
