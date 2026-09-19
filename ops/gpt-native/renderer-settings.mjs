// Pinned native Chat picker, lab-only. Native preset IDs are not slider positions
// or Codex reasoning values. Catalog and accessible controls must agree exactly.
export async function nativeSettings(request, read, control, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail = code => { throw Error(`NATIVE_${code}`); };
 if (!['inspectSettings','selectSettings'].includes(request?.operation)) fail('UNSUPPORTED_CONTROL');
 if (request.operation === 'selectSettings' && (typeof request.versionId !== 'string' || request.versionId.length > 128 || !Number.isSafeInteger(request.presetId))) fail('INVALID_REQUEST');
 const lock = Symbol.for('codex-web.native-settings');
 if (runtime[lock]) fail('SETTINGS_BUSY');
 runtime[lock] = true;
 let trigger, owned = false, deadline = Date.now() + 18000;
 const visible = e => e.getClientRects().length && !e.closest('[inert],[hidden],[aria-hidden="true"]');
 const enabled = e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.hasAttribute('data-disabled');
 const all = (root,selector) => [...root.querySelectorAll(selector)].filter(visible);
 const one = (root,selector) => {const es=all(root,selector);if(es.length!==1)fail('PICKER_UNAVAILABLE');return es[0];};
 const pause = () => new Promise(resolve=>setTimeout(resolve,40));
 const guard = async () => {
  if (Date.now() >= deadline) fail('SETTINGS_TIMEOUT');
  const s=await control({...request,operation:'inspectConversation'},read,load,runtime);
  if(!s.selected || !s.composerReady || s.hasDraft || s.stopAvailable)fail('NOT_READY');
 };
 const menu = () => {
  const id=trigger.getAttribute('aria-controls'), el=id && runtime.document.getElementById(id);
  if(!el || !visible(el) || el.getAttribute('role')!=='menu' || trigger.getAttribute('aria-expanded')!=='true')fail('PICKER_UNAVAILABLE');
  return el;
 };
 const mutate = async get => {
  await guard();
  const e=get();if(!enabled(e))fail('SETTING_UNAVAILABLE');
  e.click();await pause();
 };
 try {
  await guard();
  const {versions}=await read({operation:'readModels',accountFingerprint:request.accountFingerprint},load,runtime);
  const desired=request.operation==='selectSettings' ? versions.find(v=>v.id===request.versionId) : null;
  if(request.operation==='selectSettings' && (!desired?.enabled || !desired.presets.find(p=>p.id===request.presetId)?.available))fail('SETTING_UNAVAILABLE');
  trigger=one(runtime.document,'button[aria-label="Select ChatGPT model"]');
  // Never take over a picker already being used through manual recovery.
  if(trigger.getAttribute('aria-expanded')==='true')fail('PICKER_BUSY');
  await mutate(()=>trigger);owned=true;
  const snapshot = () => {
   const root=menu(), radios=[...root.querySelectorAll('[role="menuitemradio"]')];
   const selected=radios.filter(e=>e.getAttribute('aria-checked')==='true');
   if(selected.length!==1)fail('INVALID_SELECTION');
   const label=selected[0].textContent.trim(),version=versions.find(v=>v.label===label);
   if(!version || !version.enabled)fail('INVALID_SELECTION');
   const slider=one(root,'[data-reasoning-slider]');
   const status=(slider.getAttribute('aria-describedby')??'').split(/\s+/).map(id=>runtime.document.getElementById(id)).filter(e=>e&&root.contains(e)&&e.getAttribute('role')==='status');
   if(status.length!==1)fail('INVALID_SELECTION');
   // Match native text against the catalog, including count, rather than guessing
   // a semantic effort from a numeric slider position or translating the label.
   const index=version.presets.findIndex((p,i)=>status[0].textContent.trim()===`${p.label}, ${i+1} of ${version.presets.length}.`);
   if(index<0 || !version.presets[index].available)fail('INVALID_SELECTION');
   return {version,index,preset:version.presets[index]};
  };
  let current=snapshot();
  if(desired && desired.id!==current.version.id){
   await mutate(()=>one(menu(),'[data-model-picker-view-toggle]'));
   await mutate(()=>{
    const candidates=all(menu(),'[role="menuitemradio"]').filter(e=>e.textContent.trim()===desired.label);
    if(candidates.length!==1 || candidates[0].hasAttribute('aria-describedby'))fail('SETTING_UNAVAILABLE');
    return candidates[0];
   });
   current=snapshot();if(current.version.id!==desired.id)fail('SETTING_UNCONFIRMED');
  }
  if(desired){
   const target=desired.presets.findIndex(p=>p.id===request.presetId);
   for(let step=0;current.index!==target && step<16;step++){
    const direction=target>current.index?1:-1,next=current.index+direction;
    if(!desired.presets[next]?.available)fail('SETTING_UNAVAILABLE');
    await guard();
    const latest=snapshot();if(latest.version.id!==current.version.id || latest.preset.id!==current.preset.id)fail('SETTING_CHANGED');
    const slider=one(menu(),'[data-reasoning-slider]');if(!enabled(slider))fail('SETTING_UNAVAILABLE');
    slider.dispatchEvent(new runtime.KeyboardEvent('keydown',{key:direction>0?'ArrowRight':'ArrowLeft',bubbles:true,cancelable:true}));
    await pause();current=snapshot();
    if(current.version.id!==desired.id || current.index!==next)fail('SETTING_UNCONFIRMED');
   }
   if(current.preset.id!==request.presetId)fail('SETTING_UNCONFIRMED');
  }
  await guard();
  const final=snapshot();if(final.version.id!==current.version.id || final.preset.id!==current.preset.id)fail('SETTING_CHANGED');
  return {conversationId:request.conversationId,versionId:final.version.id,presetId:final.preset.id,
   model:final.preset.model,effort:final.preset.effort,label:final.preset.label,verified:true};
 } finally {
  // Only close the picker we opened, on the same account/chat. No rollback across
  // account/navigation changes, and no prompt submission under any circumstance.
  if(owned && trigger?.getAttribute('aria-expanded')==='true'){
   try {await guard();trigger.dispatchEvent(new runtime.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));}catch{}
  }
  delete runtime[lock];
 }
}
