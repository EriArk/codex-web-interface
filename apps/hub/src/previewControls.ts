/** Small standalone controls used by the owner's saved HTML design studies. */
export const previewControls = String.raw`<script>
if(!globalThis.Tweak) globalThis.Tweak=class {
 constructor(options={}){
  this.change=typeof options.onChange==='function'?options.onChange:()=>{};
  this.host=document.createElement('div');
  this.host.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483646';
  const shadow=this.host.attachShadow({mode:'open'});
  const style=document.createElement('style');
  style.textContent=':host{font:14px system-ui;color:#263b33;color-scheme:light}button{font:inherit;min-height:44px;border:1px solid #bec9bf;border-radius:9px;background:#fffef9;color:inherit;padding:8px 14px;cursor:pointer;box-shadow:0 2px 12px #0002}section{display:grid;gap:14px;width:260px;max-width:calc(100vw - 24px);max-height:55vh;overflow:auto;box-sizing:border-box;padding:16px;margin-bottom:8px;border:1px solid #bec9bf;border-radius:12px;background:#fffef9;box-shadow:0 4px 20px #0003}section[hidden]{display:none}label{display:grid;gap:7px}select,input{font:inherit;accent-color:#3e6b58;min-height:36px;width:100%;box-sizing:border-box}input[type=checkbox]{width:24px;height:24px;min-height:24px}output{float:right;color:#5e6b60}';
  this.panel=document.createElement('section');this.panel.hidden=true;this.panel.setAttribute('aria-label','Настройка демо');
  const toggle=document.createElement('button');toggle.textContent='Настроить';toggle.setAttribute('aria-expanded','false');
  toggle.onclick=()=>{this.panel.hidden=!this.panel.hidden;toggle.setAttribute('aria-expanded',String(!this.panel.hidden));toggle.textContent=this.panel.hidden?'Настроить':'Скрыть';};
  shadow.append(style,this.panel,toggle);(document.body||document.documentElement).append(this.host);
 }
 row(label){const row=document.createElement('label'),span=document.createElement('span');span.textContent=label;row.append(span);this.panel.append(row);return row;}
 addSelect(state,key,options={}){const row=this.row(options.label||key),input=document.createElement('select');input.setAttribute('aria-label',options.label||key);for(const entry of options.options||[]){const opt=document.createElement('option');opt.value=typeof entry==='object'?entry.value:entry;opt.textContent=typeof entry==='object'?entry.label:entry;input.append(opt);}input.value=String(state[key]);input.onchange=()=>{state[key]=input.value;this.change();};row.append(input);return this;}
 addSlider(state,key,options={}){const row=this.row(options.label||key),input=document.createElement('input'),value=document.createElement('output');input.type='range';input.setAttribute('aria-label',options.label||key);input.min=String(options.min??0);input.max=String(options.max??100);input.step=String(options.step??1);input.value=String(state[key]);const update=()=>{value.textContent=input.value+(options.unit||'');};update();input.oninput=()=>{state[key]=Number(input.value);update();this.change();};row.firstChild.append(value);row.append(input);return this;}
 addToggle(state,key,options={}){const row=this.row(options.label||key),input=document.createElement('input');input.type='checkbox';input.setAttribute('aria-label',options.label||key);input.checked=!!state[key];input.onchange=()=>{state[key]=input.checked;this.change();};row.append(input);return this;}
 destroy(){this.host.remove();}
};
</script>`;
