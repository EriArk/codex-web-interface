import {createHash} from 'node:crypto';
const id=/^[a-zA-Z0-9_-]{1,100}$/;
export async function projectResource(page,projectId){
 if(!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(projectId)||new URL(page.url()).origin!=='https://chatgpt.com')throw Error('GPT_PROJECT_INVALID');
 return page.evaluate(async projectId=>{
  const session=await(await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(10000)})).json();
  if(typeof session.accessToken!=='string')throw Error('GPT_LOGIN_REQUIRED');
  const response=await fetch('/backend-api/gizmos/'+projectId,{headers:{Authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('GPT_PROJECT_READ');
  const text=await response.text();if(text.length>4*1024*1024)throw Error('GPT_PROJECT_SIZE');return JSON.parse(text);
 },projectId);
}
export function projectFields(raw){
 const g=raw.gizmo?.gizmo??raw.gizmo;
 if(!g?.display||typeof g.instructions!=='string'||g.instructions.length>100000)throw Error('GPT_PROJECT_SHAPE');
 const files=(Array.isArray(raw.files)?raw.files:[]).map(f=>({id:f.file_id??f.id,name:f.name,bytes:Number.isSafeInteger(f.size)&&f.size>=0?f.size:null}));
 if(files.length>500||files.some(f=>!id.test(f.id)||typeof f.name!=='string'||f.name.length>500))throw Error('GPT_PROJECT_FILES');
 return {id:g.id,name:g.display.name,instructions:g.instructions,emoji:g.display.emoji??null,theme:g.display.theme??null,canWrite:g.current_user_permission?.can_write===true,files};
}
export const projectRevision=fields=>createHash('sha256').update(JSON.stringify(fields)).digest('hex');
export async function mutateProjectContent(page,input){
 let dispatched=false;
 try{
  const {projectId,revision,action}=input??{};
  if(!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(projectId)||!['instructions','upload','remove'].includes(action)||!/^\w{64}$/.test(revision??''))throw Error('GPT_PROJECT_INVALID');
  const before=projectFields(await projectResource(page,projectId));
  if(!before.canWrite||projectRevision(before)!==revision)return {dispatched:false,code:'GPT_PROJECT_CHANGED'};
  if(action==='instructions'){
   if(typeof input.text!=='string'||input.text.length>100000)throw Error('GPT_PROJECT_INVALID');
   dispatched=true;
   const result=await page.evaluate(async body=>{
    const session=await(await fetch('/api/auth/session',{credentials:'include',signal:AbortSignal.timeout(10000)})).json();
    if(typeof session.accessToken!=='string')return {rejected:true};
    const response=await fetch('/backend-api/projects/'+body.id,{method:'PATCH',headers:{Authorization:'Bearer '+session.accessToken,'Content-Type':'application/json'},body:JSON.stringify({name:body.name,instructions:body.instructions,emoji:body.emoji,theme:body.theme}),signal:AbortSignal.timeout(20000)});
    await response.body?.cancel();return {rejected:response.status>=400&&response.status<500};
   },{...before,instructions:input.text});
   return {dispatched:!result.rejected};
  }
  if(action==='upload'&&(!input.file||!id.test(input.file.id)||typeof input.file.base64!=='string'||input.file.base64.length>35*1024*1024||typeof input.file.name!=='string'||input.file.name.length>240||/[\\/\x00-\x1f]/.test(input.file.name)))throw Error('GPT_PROJECT_INVALID');
  const target=action==='remove'?before.files.find(f=>f.id===input.fileId):null;
  if(action==='remove'&&(!target||before.files.filter(f=>f.name===target.name).length!==1))return {dispatched:false,code:'GPT_PROJECT_FILE_AMBIGUOUS'};
  if(await page.locator('[data-testid=stop-button]').isVisible()||(await page.locator('#prompt-textarea').textContent().catch(()=>''))?.trim())return {dispatched:false,code:'GPT_BUSY'};
  const url='https://chatgpt.com/g/'+projectId+'/project';
  if(page.url()!==url)await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  await page.getByRole('tab',{name:'Sources',exact:true}).click({timeout:10000});
  // Revalidate after navigation; an owner may have changed the native project meanwhile.
  if(projectRevision(projectFields(await projectResource(page,projectId)))!==revision)return {dispatched:false,code:'GPT_PROJECT_CHANGED'};
  if(action==='upload'){
   await page.getByRole('button',{name:'Add sources',exact:true}).click({timeout:5000});
   const dialog=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'Upload',exact:true})});
   await dialog.locator('input[type=file]').waitFor({state:'attached',timeout:5000});
   dispatched=true;
   await dialog.locator('input[type=file]').setInputFiles({name:input.file.name,mimeType:'application/octet-stream',buffer:Buffer.from(input.file.base64,'base64')});
  }else{
   const row=page.locator('[class~="group/file-row"]').filter({has:page.getByLabel(target.name,{exact:true})});
   if(await row.count()!==1)return {dispatched:false,code:'GPT_PROJECT_FILE_AMBIGUOUS'};
   await row.hover();await row.getByRole('button',{name:'Source actions',exact:true}).click({timeout:5000});
   const remove=page.getByRole('menuitem',{name:'Delete',exact:true});await remove.waitFor({state:'visible',timeout:5000});
   dispatched=true;await remove.click({timeout:5000});
  }
  return {dispatched:true};
 }catch{return {dispatched,code:dispatched?'GPT_PROJECT_UNKNOWN':'GPT_PROJECT_UNAVAILABLE'};}
}
