// Fixed project content adapter for the pinned native build; no generic URL/action.
export async function nativeProject(r,read,load=()=>import('app://-/assets/app-initial-430deae5a13a.js'),runtime=globalThis){
 const fail=c=>{throw Error(`NATIVE_${c}`);};
 if(!['inspectProject','mutateProject','createProject'].includes(r.operation)||(r.operation!=='createProject'&&!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(r.projectId??'')))fail('INVALID_PROJECT');
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
  let response;try{response=await m.$rn.getInstance().fetch(url,{method,headers,body:method==='GET'?undefined:m.kWt.getRequestBody(options),signal,retry:false,
   expectedIdentity:principal,assertRequestCurrent:()=>{if(signal.aborted||attempts++!==0)fail('LIBRARY_REPLAY_BLOCKED');}});
  }catch(error){
   // The pinned native transport throws on non-2xx responses. Only an actual
   // explicit HTTP rejection is terminal; timeouts/transport failures stay unknown.
   if(!signal.aborted&&[400,403,404,409,422].includes(error?.responseStatus)&&error.status===error.responseStatus){
    await account();return {ok:false,status:error.responseStatus,body:null};
   }
   throw error;
  }
  await account();return response;
 };

 if(r.operation==='createProject'){
  if(typeof r.name!=='string'||!r.name.trim()||r.name.length>120)fail('INVALID_PROJECT');
  const response=await fetchFixed('POST','/projects',{requestBody:{name:r.name,instructions:'',emoji:null,theme:null,memory_scope:'default'}});
  if(!response.ok){await response.body?.cancel();if([400,403,409,422].includes(response.status))return {projectId:null,rejected:true};fail('PROJECT_CREATE_UNKNOWN');}
  let text='';for await(const bytes of response.body){text+=new TextDecoder().decode(bytes);if(text.length>65536)fail('RESPONSE_TOO_LARGE');}
  await account();const data=JSON.parse(text),id=data.resource?.gizmo?.id;
  if(!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(id??''))fail('PROJECT_CREATE_UNKNOWN');
  return {projectId:id};
 }
 const p=await read({operation:'readProject' ,projectId:r.projectId,accountFingerprint:r.accountFingerprint},load,runtime);
 const fields={id:p.id,name:p.name,instructions:p.instructions,emoji:p.emoji,theme:p.theme,canWrite:p.canWrite,files:[...p.files].sort((a,b)=>a.id.localeCompare(b.id))};
 const digest=await runtime.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(fields)));
 const revision=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
 if(r.operation==='inspectProject')return {...fields,revision};
 if(!fields.canWrite||revision!==r.revision)return {dispatched:false};
 const visible=s=>[...runtime.document.querySelectorAll(s)].filter(e=>e.getClientRects().length&&!e.disabled);
 const editors=visible('[role="textbox"][contenteditable="true"]');
 if(editors.length!==1||editors.some(e=>e.textContent?.trim())||visible('button[aria-label="Stop"]').length||editors.some(e=>[...(e.closest?.('[data-composer-body]')?.querySelectorAll('button[aria-label]')??[])].some(b=>/^Remove /.test(b.getAttribute('aria-label')??''))))return {dispatched:false};
 let method,route,options;
 if(r.action==='instructions'&&typeof r.text==='string'&&r.text.length<=100000){
  method='PATCH';route='/projects/{project_id}';options={parameters:{path:{project_id:r.projectId}},requestBody:{name:p.name,instructions:r.text,emoji:p.emoji,theme:p.theme}};
 }else if(r.action==='remove'&&r.confirm===true&&fields.files.some(f=>f.id===r.fileId)){
  method='DELETE';route='/projects/{project_id}/files/{file_id}';options={parameters:{path:{project_id:r.projectId,file_id:r.fileId}}};
 }else if(r.action==='upload'){
  const f=r.uploaded;
  if(!f||!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(f.id??'')||typeof f.name!=='string'||f.name.length>255||!Number.isSafeInteger(f.size)||f.size<1||typeof f.mimeType!=='string'||f.libraryFileId!=null&&!/^[a-zA-Z0-9_-]{1,150}$/.test(f.libraryFileId))fail('INVALID_UPLOAD');
  method='POST';route='/projects/{project_id}/files';options={parameters:{path:{project_id:r.projectId}},requestBody:{files:[{file_id:f.id,last_modified:0,...(f.libraryFileId?{library_file_id:f.libraryFileId}:{}),location:'fs',name:f.name,size:f.size,type:f.mimeType}]}};
 }else fail('INVALID_PROJECT');
 const response=await fetchFixed(method,route,options),status=response.status;
 await response.body?.cancel();return {dispatched:true,accepted:response.ok,rejected:[400,403,409,422].includes(status)};
}
