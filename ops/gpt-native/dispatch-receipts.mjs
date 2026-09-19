import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {privatePath} from './service.mjs';

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const fail=code=>{throw Error(`NATIVE_${code}`);};
/** At-most-once dispatch receipts, not a queue. Only Hub gpt_jobs can schedule work. */
export class NativeDispatchReceipts {
 constructor({path,userId,accountFingerprint,conversationIds}){
  if(!uuid(userId)||!/^[a-f0-9]{64}$/.test(accountFingerprint)||!Array.isArray(conversationIds)||
     !conversationIds.length||conversationIds.length>4||!conversationIds.every(uuid))fail('INVALID_CANARY');
  privatePath(dirname(path),'isDirectory');
  try{privatePath(path,'isFile');}catch(e){if(e.code!=='ENOENT')throw e;}
  this.allowed=new Set(conversationIds);this.db=new DatabaseSync(path);chmodSync(path,0o600);
  this.db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);");
  const hash=this.hash([userId,accountFingerprint]);
  this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(hash);
  if(this.db.prepare('SELECT hash FROM binding WHERE id=1').get().hash!==hash){this.db.close();fail('INVALID_BINDING');}
 }
 hash(x){return createHash('sha256').update(JSON.stringify(x)).digest('hex');}
 close(){this.db.close();}
 pending(){return !!this.db.prepare("SELECT 1 FROM receipts WHERE state!='completed' LIMIT 1").get();}
 validate(r){
  if(!this.allowed.has(r.conversationId)||!uuid(r.key)||!uuid(r.userMessageId)||typeof r.text!=='string'||!r.text.trim()||Buffer.byteLength(r.text)>32768||
     typeof r.versionId!=='string'||r.versionId.length>128||!Number.isSafeInteger(r.presetId))fail('INVALID_CANARY');
 }
 async prepare(r,reader){
  this.validate(r);
  if(this.pending())fail('PENDING_DISPATCH');
  await reader.selectConversation(r);
  // Native navigation is asynchronous. Wait only for the exact idle composer;
  // never interpret a stale/home composer as the selected conversation.
  let ready=false;
  for(let attempt=0;attempt<12;attempt++){
   const ui=await reader.inspectConversation(r);
   if(ui.hasDraft||ui.stopAvailable)fail('NOT_READY');
   if(ui.selected&&ui.composerReady){ready=true;break;}
   await new Promise(resolve=>setTimeout(resolve,125));
  }
  if(!ready)fail('NOT_READY');
  await reader.selectSettings(r);
  const catalog=await reader.readModels(r);
  const preset=catalog.versions.find(v=>v.id===r.versionId&&v.enabled)?.presets.find(p=>p.id===r.presetId&&p.available);
  if(!preset)fail('INVALID_SETTINGS');
  const selected={...r,model:preset.model,effort:preset.effort};
  const prepared=await reader.prepareDispatch(selected);
  return {...prepared,versionId:r.versionId,presetId:r.presetId};
 }
 async dispatch(r,reader){
  this.validate(r);
  if(!uuid(r.parentId)||typeof r.model!=='string'||r.model.length>128||(r.effort!==null&&typeof r.effort!=='string')||r.intentPersisted!==true)fail('INVALID_REQUEST');
  const hash=this.hash(r),old=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(r.key);
  if(old){if(old.hash!==hash)fail('KEY_CONFLICT');return {state:old.state==='completed'?'completed':'unknown',userMessageId:r.userMessageId};}
  if(this.pending())fail('PENDING_DISPATCH');
  // This commit survives renderer/supervisor/Hub loss. Never invoke the writer twice.
  this.db.prepare("INSERT INTO receipts VALUES(?,?,?,'unknown')").run(r.key,hash,JSON.stringify(r));
  try{await reader.dispatchText(r);}catch{}
  return {state:'unknown',userMessageId:r.userMessageId};
 }
 async reconcile({key,conversationId},reader){
  if(!uuid(key)||!this.allowed.has(conversationId))fail('INVALID_CANARY');
  const row=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
  if(!row)fail('RECEIPT_MISSING');
  const payload=JSON.parse(row.payload);
  if(payload.conversationId!==conversationId)fail('CONVERSATION_MISMATCH');
  const result=await reader.readSubmission(payload);
  if(result.state==='completed')this.db.prepare("UPDATE receipts SET state='completed' WHERE key=?").run(key);
  return {...result,userMessageId:payload.userMessageId};
 }
}
