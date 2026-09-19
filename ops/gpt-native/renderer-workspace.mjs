// Fixed consumer workspace contracts through the signed-in native transport.
export async function nativeWorkspace(r,read,load=()=>import('app://-/assets/app-initial-430deae5a13a.js'),runtime=globalThis){
 const fail=c=>{throw Error('NATIVE_'+c);};
 const id=x=>{if(typeof x!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(x))fail('INVALID_REQUEST');return x;};
 const text=(x,n)=>{if(typeof x!=='string'||x.length>n)fail('INVALID_WORKSPACE');return x;};
 const hash=async x=>Array.from(new Uint8Array(await runtime.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(x)))),b=>b.toString(16).padStart(2,'0')).join('');
 if(!['scheduledList','scheduledRead','canvasList','canvasVersion','workspaceMutation','activity'].includes(r.operation))fail('INVALID_REQUEST');
 const m=await load(),signal=AbortSignal.timeout(15000);
 const account=async()=>{
  if((await read({operation:'inspectAccount'},load,runtime)).accountFingerprint!==r.accountFingerprint)fail('ACCOUNT_CHANGED');
  const a=await m.M9.accessInputs.readAccountInfo();if(a?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');return {accountId:a.data.accountId,userId:a.data.userId};
 };
 await account();
 const activity=()=>({ready:!!runtime.document.querySelector('[data-testid=app-shell-header-context-menu-surface]'),generating:[...runtime.document.querySelectorAll('button[aria-label="Stop"]')].some(e=>e.getClientRects().length)});
 if(r.operation==='activity')return activity();
 const request=async(route,body)=>{
  const principal=await account();
  // Fixed caller branches below are the sole route source. No external route input.
  const {url,headers}=m.kWt.getRequestTarget(route,{});let attempts=0,response;
  try{response=await m.$rn.getInstance().fetch(url,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),expectedIdentity:principal,signal,retry:false,assertRequestCurrent:()=>{if(signal.aborted||attempts++!==0)fail('REPLAY_BLOCKED');}});}
  catch(e){
   if(body===undefined&&[404,410].includes(e?.responseStatus)&&e.status===e.responseStatus){await account();return null;}
   if(body!==undefined&&[400,401,403,404,409,410,422,429].includes(e?.responseStatus)&&e.status===e.responseStatus)fail('WORKSPACE_REJECTED');
   throw e;
  }
  if(!response.ok){await response.body?.cancel();if(body===undefined&&[404,410].includes(response.status)){await account();return null;}if(body!==undefined&&[400,401,403,404,409,410,422,429].includes(response.status))fail('WORKSPACE_REJECTED');fail('WORKSPACE_UNAVAILABLE');}
  let size=0;const parts=[];for await(const b of response.body){size+=b.length;if(size>1500000)fail('RESPONSE_TOO_LARGE');parts.push(b);}
  const bytes=new Uint8Array(size);let offset=0;for(const b of parts){bytes.set(b,offset);offset+=b.length;}
  await account();return size?JSON.parse(new TextDecoder().decode(bytes)):null;
 };
 const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;
 const schedule=async raw=>{
  if(typeof raw?.is_enabled!=='boolean')fail('INVALID_WORKSPACE');
  const item={id:id(raw.id),title:text(raw.title,500),prompt:text(raw.prompt,100000),enabled:raw.is_enabled,schedule:text(raw.schedule??'',8000),displaySchedule:text(raw.display_schedule??'',1000),timezone:text(raw.default_timezone,120),timing:text(raw.timing_mode,80),nextRuns:Array.isArray(raw.next_run_times)?raw.next_run_times.filter(date).slice(0,5):[],lastRun:date(raw.last_run_time),conversationId:raw.conversation_id?id(raw.conversation_id):null,eventDriven:!!raw.webhook_triggers?.length,canEdit:['owner','editor'].includes(raw.current_user_role),canDelete:raw.can_delete===true};
  return {...item,revision:await hash({...item,updatedAt:raw.updated_at,components:raw.schedule_components,triggers:raw.webhook_triggers})};
 };
 const canvas=async(raw,conversationId)=>{
  if(!Number.isSafeInteger(raw.version)||raw.version<1)fail('INVALID_WORKSPACE');
  const item={id:id(raw.id),conversationId:id(conversationId),title:text(raw.title,500),type:text(raw.textdoc_type,100),content:text(raw.content,250000),version:raw.version};return {...item,revision:await hash(item)};
 };
 const canvases=async c=>{const v=await request('/conversation/'+id(c)+'/textdocs');if(!Array.isArray(v)||v.length>100)fail('INVALID_WORKSPACE');return Promise.all(v.map(x=>canvas(x,c)));};
 const version=async(c,d,v)=>{
  const current=(await canvases(c)).find(x=>x.id===id(d));if(!current||!Number.isSafeInteger(v)||v<1||v>current.version)fail('INVALID_REQUEST');
  if(v===current.version)return current;
  const diff=await request('/textdoc/'+id(d)+'/diff/'+(v===1?2:v));return {...current,content:text(v===1?diff?.content_before:diff?.content_after,250000),version:v};
 };
 if(r.operation==='scheduledList'){
  if(r.cursor!=null&&(typeof r.cursor!=='string'||r.cursor.length>4000))fail('INVALID_REQUEST');
  const v=await request('/automations?limit=100'+(r.cursor?'&cursor='+encodeURIComponent(r.cursor):''));
  if(!Array.isArray(v?.items)||v.items.length>200||(v.cursor!=null&&(typeof v.cursor!=='string'||v.cursor.length>4000)))fail('INVALID_WORKSPACE');
  return {items:await Promise.all(v.items.map(schedule)),cursor:v.cursor??null};
 }
 if(r.operation==='scheduledRead'){const v=await request('/automation/'+id(r.id));return {item:v===null?null:await schedule(v)};}
 if(r.operation==='canvasList')return {items:await canvases(r.conversationId)};
 if(r.operation==='canvasVersion')return version(r.conversationId,r.id,r.version);
 const input=r.input;if(!input||typeof input!=='object'||!/^[a-f0-9]{64}$/.test(input.revision??''))fail('INVALID_REQUEST');
 const a=activity();if(!a.ready||a.generating)return {dispatched:false};
 let route,body;
 if(input.kind==='schedule'){
  const raw=await request('/automation/'+id(input.id)),before=raw&&await schedule(raw);
  if(!before||before.revision!==input.revision||!before.canEdit)return {dispatched:false};
  if(input.action==='save'){
   if(before.eventDriven)return {dispatched:false};
   new Intl.DateTimeFormat('en',{timeZone:input.timezone});
   const timing={exact_schedule:0,flexible_schedule:1,condition_watch:2}[before.timing];if(timing===undefined||typeof input.enabled!=='boolean')fail('INVALID_REQUEST');
   route='/automations/save';body={jawbone_id:before.id,title:text(input.title,500),prompt:text(input.prompt,100000),schedule:text(input.schedule,8000),default_timezone:text(input.timezone,120),is_enabled:input.enabled,notifications_enabled:raw.notifications_enabled===true,email_enabled:raw.email_enabled===true,last_run_time:raw.last_run_time,timing_mode:timing};
  }else if(input.action==='delete'&&input.confirm===true&&before.canDelete){route='/automations/remove';body={automation_id:before.id};}
  else if(['pause','resume'].includes(input.action)){route='/automations/set_status';body={jawbone_id:before.id,is_enabled:input.action==='resume'};}
  else fail('INVALID_REQUEST');
 }else if(input.kind==='canvas'&&input.action==='restore'&&input.confirm===true){
  const before=(await canvases(input.conversationId)).find(x=>x.id===id(input.id));if(!before||before.revision!==input.revision)return {dispatched:false};
  await version(input.conversationId,input.id,input.version);route='/textdoc/'+id(input.id)+'/restore';body={version:before.version,restore_from_version:input.version};
 }else fail('INVALID_REQUEST');
 try{await request(route,body);return {dispatched:true};}
 catch(e){if(e?.message==='NATIVE_WORKSPACE_REJECTED')return {dispatched:false};throw e;}
}
