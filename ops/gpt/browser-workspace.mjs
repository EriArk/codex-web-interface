import {createHash} from 'node:crypto';
const identifier=/^[a-zA-Z0-9_-]{1,100}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checkId=value=>{if(typeof value!=='string'||!identifier.test(value))throw Error('GPT_WORKSPACE_INPUT');return value;};
const text=(value,max)=>{if(typeof value!=='string'||value.length>max)throw Error('GPT_WORKSPACE_SHAPE');return value;};
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
/** Fixed native routes only; credentials and raw native metadata never leave the connector. */
async function native(page,path,body){
 if(new URL(page.url()).origin!=='https://chatgpt.com')throw Error('GPT_LOGIN_REQUIRED');
 return page.evaluate(async({path,body})=>{
  const session=await(await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(10000)})).json();
  if(typeof session.accessToken!=='string')return {status:401,data:null,dispatched:false};
  const response=await fetch('/backend-api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+session.accessToken,'content-type':'application/json'},credentials:'include',cache:'no-store',...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();return {status:response.status,data:null,dispatched:body!==undefined&&response.status>=500};}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4*1024*1024)throw Error('GPT_WORKSPACE_SIZE');chunks.push(part.value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return {status:response.status,data:size?JSON.parse(new TextDecoder().decode(bytes)):null,dispatched:body!==undefined};
 },{path,body});
}
const success=result=>{if(result.status!==200)throw Error(result.status===404?'GPT_WORKSPACE_MISSING':'GPT_WORKSPACE_UNAVAILABLE');return result.data;};
export function scheduledFields(raw){
 const item={id:checkId(raw.id),title:text(raw.title,500),prompt:text(raw.prompt,100000),enabled:raw.is_enabled,schedule:text(raw.schedule,8000),displaySchedule:typeof raw.display_schedule==='string'?raw.display_schedule.slice(0,1000):'',timezone:text(raw.default_timezone,120),timing:text(raw.timing_mode,80),nextRuns:Array.isArray(raw.next_run_times)?raw.next_run_times.filter(date).slice(0,5):[],lastRun:date(raw.last_run_time),conversationId:typeof raw.conversation_id==='string'?checkId(raw.conversation_id):null,eventDriven:Array.isArray(raw.webhook_triggers)&&raw.webhook_triggers.length>0,canEdit:['owner','editor'].includes(raw.current_user_role),canDelete:raw.can_delete===true};
 if(typeof item.enabled!=='boolean')throw Error('GPT_WORKSPACE_SHAPE');
 return {...item,revision:hash({...item,updatedAt:raw.updated_at,components:raw.schedule_components,triggers:raw.webhook_triggers})};
}
export async function scheduledList(page,cursor){
 if(cursor!=null&&(typeof cursor!=='string'||cursor.length>4000))throw Error('GPT_WORKSPACE_INPUT');
 const raw=success(await native(page,'/automations'+(cursor?'?cursor='+encodeURIComponent(cursor):'')));
 if(!Array.isArray(raw?.items)||raw.items.length>200||(raw.cursor!=null&&typeof raw.cursor!=='string'))throw Error('GPT_WORKSPACE_SHAPE');
 return {items:raw.items.map(scheduledFields),cursor:raw.cursor??null};
}
async function scheduledRaw(page,id){const r=await native(page,'/automation/'+checkId(id));return [404,410].includes(r.status)?null:success(r);}
export async function scheduledRead(page,id){const raw=await scheduledRaw(page,id);return raw===null?null:scheduledFields(raw);}
export function canvasFields(raw,conversationId){
 if(!Number.isSafeInteger(raw.version)||raw.version<1)throw Error('GPT_WORKSPACE_SHAPE');
 const item={id:checkId(raw.id),conversationId:checkId(conversationId),title:text(raw.title,500),type:text(raw.textdoc_type,100),content:text(raw.content,250000),version:raw.version};
 return {...item,revision:hash(item)};
}
export async function canvasList(page,conversationId){
 const raw=success(await native(page,'/conversation/'+checkId(conversationId)+'/textdocs'));
 if(!Array.isArray(raw)||raw.length>100)throw Error('GPT_WORKSPACE_SHAPE');
 return {items:raw.map(v=>canvasFields(v,conversationId))};
}
export async function mutateSchedule(page,input){
 let dispatched=false;
 try{
  checkId(input.id);
  if(!['save','pause','resume','delete'].includes(input.action))throw Error('GPT_WORKSPACE_INPUT');
  const raw=await scheduledRaw(page,input.id),before=raw&&scheduledFields(raw);
  if(!before||before.revision!==input.revision||!before.canEdit||(input.action==='delete'&&!before.canDelete))return {dispatched:false,code:'GPT_WORKSPACE_CHANGED'};
  if(await page.locator('[data-testid="stop-button"]').isVisible())return {dispatched:false,code:'GPT_BUSY'};
  let path,body;
  if(input.action==='save'){
   if(before.eventDriven)return {dispatched:false,code:'GPT_SCHEDULE_EVENT_EDIT'};
   text(input.title,500);text(input.prompt,100000);text(input.schedule,8000);text(input.timezone,120);
   if(!input.title.trim()||!input.prompt.trim()||typeof input.enabled!=='boolean')throw Error('GPT_WORKSPACE_INPUT');
   new Intl.DateTimeFormat('en',{timeZone:input.timezone});
   path='/automations/save';body={jawbone_id:before.id,title:input.title,prompt:input.prompt,schedule:input.schedule,is_enabled:input.enabled,default_timezone:input.timezone,notifications_enabled:raw.notifications_enabled===true,email_enabled:raw.email_enabled===true,last_run_time:raw.last_run_time,timing_mode:{exact_schedule:0,flexible_schedule:1,condition_watch:2}[before.timing]};
   if(body.timing_mode===undefined)throw Error('GPT_WORKSPACE_SHAPE');
  }else if(input.action==='delete'){path='/automations/remove';body={automation_id:before.id};}
  else{path='/automations/set_status';body={jawbone_id:before.id,is_enabled:input.action==='resume'};}
  dispatched=true;
  const result=await native(page,path,body);
  return {dispatched:result.dispatched,code:result.status>=200&&result.status<300?null:'GPT_WORKSPACE_UNAVAILABLE'};
 }catch{return {dispatched,code:dispatched?'GPT_WORKSPACE_UNKNOWN':'GPT_WORKSPACE_UNAVAILABLE'};}
}

export async function canvasVersion(page,conversationId,id,version){
 const current=(await canvasList(page,conversationId)).items.find(v=>v.id===checkId(id));
 if(!current)throw Error('GPT_WORKSPACE_MISSING');
 if(!Number.isSafeInteger(version)||version<1||version>current.version)throw Error('GPT_WORKSPACE_INPUT');
 if(version===current.version)return current;
 const raw=success(await native(page,'/textdoc/'+id+'/diff/'+(version===1?2:version)));
 return {...current,content:text(version===1?raw.content_before:raw.content_after,250000),version,revision:current.revision};
}
export async function restoreCanvas(page,input){
 let dispatched=false;
 try{
  const before=(await canvasList(page,input.conversationId)).items.find(v=>v.id===input.id);
  if(!before||before.revision!==input.revision)return {dispatched:false,code:'GPT_WORKSPACE_CHANGED'};
  if(await page.locator('[data-testid="stop-button"]').isVisible())return {dispatched:false,code:'GPT_BUSY'};
  await canvasVersion(page,input.conversationId,input.id,input.version);
  dispatched=true;
  const result=await native(page,'/textdoc/'+checkId(input.id)+'/restore',{version:before.version,restore_from_version:input.version});
  return {dispatched:result.dispatched,code:result.status>=200&&result.status<300?null:'GPT_WORKSPACE_UNAVAILABLE'};
 }catch{return {dispatched,code:dispatched?'GPT_WORKSPACE_UNKNOWN':'GPT_WORKSPACE_UNAVAILABLE'};}
}
