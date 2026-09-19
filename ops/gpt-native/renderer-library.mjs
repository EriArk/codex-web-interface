// Fixed library operations in the pinned consumer client. No caller URLs or generic RPC.
export async function nativeLibrary(r, read, load=()=>import('app://-/assets/app-initial-430deae5a13a.js'), runtime=globalThis) {
 const fail=c=>{throw Error(`NATIVE_${c}`);};
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
 if(!['readLibrary','mutateLibrary'].includes(r.operation)||!['thread','project'].includes(r.kind)||
  !(r.kind==='thread'?uuid(r.id):/^g-p-[a-zA-Z0-9-]{1,80}$/.test(r.id??''))||
  !['rename','pin','archive','delete'].includes(r.action)||r.kind==='project'&&r.action==='archive'||
  r.action==='rename'&&(typeof r.name!=='string'||!r.name.trim()||r.name!==r.name.trim()||r.name.length>120)||
  ['pin','archive'].includes(r.action)&&typeof r.value!=='boolean'||r.action==='delete'&&r.confirm!==true)fail('INVALID_LIBRARY');
 if((await read({operation:'inspectAccount'},load,runtime)).accountFingerprint!==r.accountFingerprint)fail('ACCOUNT_MISMATCH');
 const m=await load(),signal=AbortSignal.timeout(15000);
 if(typeof m.kWt?.getRequestTarget!=='function'||typeof m.kWt?.getRequestBody!=='function'||typeof m.$rn?.getInstance!=='function')fail('INCOMPATIBLE');
 const account=async()=>{
  const v=await m.M9.accessInputs.readAccountInfo();if(v?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');
  const p=v.data,d=await runtime.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([p.accountId,p.userId,p.authenticatedUserId??null])));
  if(Array.from(new Uint8Array(d),x=>x.toString(16).padStart(2,'0')).join('')!==r.accountFingerprint)fail('ACCOUNT_CHANGED');
  return {accountId:p.accountId,userId:p.userId};
 };
 const fetchFixed=async(method,route,options={})=>{
  const principal=await account(),{url,headers}=m.kWt.getRequestTarget(route,options);let attempts=0;
  const response=await m.$rn.getInstance().fetch(url,{method,headers,body:method==='GET'?undefined:m.kWt.getRequestBody(options),signal,retry:false,
   expectedIdentity:principal,assertRequestCurrent:()=>{if(signal.aborted||attempts++!==0)fail('LIBRARY_REPLAY_BLOCKED');}});
  await account();return response;
 };
 const metadata=async()=>{
  if(r.kind==='project'){
   const p=await read({operation:'readProject',projectId:r.id,accountFingerprint:r.accountFingerprint},load,runtime);
   return {exists:true,name:p.name,projectId:null,archived:false,canWrite:p.canWrite,instructions:p.instructions,emoji:p.emoji,theme:p.theme};
  }
  const response=await fetchFixed('GET','/conversation/{conversation_id}',{parameters:{path:{conversation_id:r.id}}});
  if(response.status===404){await response.body?.cancel();return {exists:false,name:'',projectId:null,archived:false,canWrite:false};}
  if(!response.ok){await response.body?.cancel();fail('LIBRARY_READ_UNAVAILABLE');}
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)fail('RESPONSE_TOO_LARGE');chunks.push(chunk);}
  const joined=new Uint8Array(bytes);let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.length;}
  const v=JSON.parse(new TextDecoder().decode(joined));
  if((v.conversation_id??v.id)!==r.id||typeof v.title!=='string'||v.title.length>4096||typeof v.is_archived!=='boolean'||v.gizmo_id!=null&&!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(v.gizmo_id))fail('INVALID_LIBRARY');
  await account();
  return {exists:v.is_visible!==false,name:v.title,projectId:v.gizmo_id??null,archived:v.is_archived,canWrite:true};
 };
 const state=await metadata();
 if(r.action==='pin')state.pinned=(await read({operation:'readPins',accountFingerprint:r.accountFingerprint},load,runtime)).items.some(p=>p.id===r.id&&p.kind===r.kind);
 if(r.operation==='readLibrary')return state;
 if(JSON.stringify(state)!==JSON.stringify(r.baseline)||!state.exists||!state.canWrite)return {dispatched:false};
 // Shared desktop remains untouched if it contains a draft or running response.
 const visible=s=>[...runtime.document.querySelectorAll(s)].filter(e=>e.getClientRects().length&&!e.disabled);
 const editors=visible('[role="textbox"][contenteditable="true"]');
 if(editors.length!==1||editors.some(e=>e.textContent?.trim())||visible('button[aria-label="Stop"]').length||
  editors.some(e=>[...(e.closest?.('[data-composer-body]')?.querySelectorAll('button[aria-label]')??[])].some(b=>/^Remove /.test(b.getAttribute('aria-label')??''))))return {dispatched:false};
 let method='PATCH',route,options;
 if(r.action==='pin'){
  method=r.value?'POST':'DELETE';route='/pins/{item_type}/{item_id}';options={parameters:{path:{item_type:r.kind==='thread'?'conversation':'project',item_id:r.id}}};
 }else if(r.kind==='thread'){
  route='/conversation/{conversation_id}';options={parameters:{path:{conversation_id:r.id}},requestBody:r.action==='rename'?{title:r.name}:r.action==='archive'?{is_archived:r.value}:{is_visible:false}};
 }else if(r.action==='rename'){
  route='/projects/{project_id}';options={parameters:{path:{project_id:r.id}},requestBody:{name:r.name,instructions:state.instructions,emoji:state.emoji,theme:state.theme}};
 }else {method='DELETE';route='/gizmos/{gizmo_id}';options={parameters:{path:{gizmo_id:r.id}}};}
 const response=await fetchFixed(method,route,options),status=response.status;
 await response.body?.cancel();
 return {dispatched:true,accepted:response.ok,rejected:[400,403,409,422].includes(status)};
}
