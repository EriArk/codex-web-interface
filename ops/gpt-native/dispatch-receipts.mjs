import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {privatePath} from './service.mjs';

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const fail=code=>{throw Error(`NATIVE_${code}`);};
/** At-most-once dispatch receipts, not a queue. Only Hub gpt_jobs can schedule work. */
export class NativeDispatchReceipts {
 constructor({path,userId,accountFingerprint,conversationIds,creationKeys=[]}){
  if(!uuid(userId)||!/^[a-f0-9]{64}$/.test(accountFingerprint)||!Array.isArray(conversationIds)||
     !conversationIds.length||conversationIds.length>4||!conversationIds.every(uuid)||!Array.isArray(creationKeys)||creationKeys.length>4||!creationKeys.every(uuid))fail('INVALID_CANARY');
  privatePath(dirname(path),'isDirectory');
  try{privatePath(path,'isFile');}catch(e){if(e.code!=='ENOENT')throw e;}
  this.allowed=new Set(conversationIds);this.creationKeys=new Set(creationKeys);this.db=new DatabaseSync(path);chmodSync(path,0o600);
  this.db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);");
  this.db.exec('CREATE TABLE IF NOT EXISTS creations(key TEXT PRIMARY KEY REFERENCES receipts(key),candidate TEXT,confirmed TEXT)');
  if(!this.db.prepare('PRAGMA table_info(creations)').all().some(x=>x.name==='createdAfter'))this.db.exec('ALTER TABLE creations ADD COLUMN createdAfter INTEGER');
  const hash=this.hash([userId,accountFingerprint]);
  this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(hash);
  if(this.db.prepare('SELECT hash FROM binding WHERE id=1').get().hash!==hash){this.db.close();fail('INVALID_BINDING');}
 }
 hash(x){return createHash('sha256').update(JSON.stringify(x)).digest('hex');}
 close(){this.db.close();}
 pending(){return !!this.db.prepare("SELECT 1 FROM receipts WHERE state!='completed' LIMIT 1").get();}
 validate(r){
  if(!(r.conversationId===null?this.creationKeys.has(r.key):this.allowed.has(r.conversationId))||!uuid(r.key)||!uuid(r.userMessageId)||typeof r.text!=='string'||!r.text.trim()||Buffer.byteLength(r.text)>32768||
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
  const prepared=await reader.prepareDispatch(r.conversationId===null?{...selected,parentId:randomUUID()}:selected);
  return {...prepared,versionId:r.versionId,presetId:r.presetId};
 }
 async dispatch(r,reader){
  this.validate(r);
  if(!uuid(r.parentId)||typeof r.model!=='string'||r.model.length>128||(r.effort!==null&&typeof r.effort!=='string')||r.intentPersisted!==true)fail('INVALID_REQUEST');
  const hash=this.hash(r),old=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(r.key);
  if(old){if(old.hash!==hash)fail('KEY_CONFLICT');return {state:old.state==='completed'?'completed':'unknown',userMessageId:r.userMessageId};}
  if(this.pending())fail('PENDING_DISPATCH');
  // This commit survives renderer/supervisor/Hub loss. Never invoke the writer twice.
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare("INSERT INTO receipts VALUES(?,?,?,'unknown')").run(r.key,hash,JSON.stringify(r));
   if(r.conversationId===null)this.db.prepare('INSERT INTO creations(key,candidate,confirmed,createdAfter) VALUES(?,NULL,NULL,?)').run(r.key,Date.now());
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  try{const result=await reader.dispatchText(r);if(r.conversationId===null&&uuid(result?.conversationId))this.candidate(r.key,result.conversationId);}catch{}
  return {state:'unknown',userMessageId:r.userMessageId};
 }
 async reconcile({key,conversationId},reader){
  if(!uuid(key)||!(conversationId===null?this.creationKeys.has(key):this.allowed.has(conversationId)))fail('INVALID_CANARY');
  const row=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
  if(!row)fail('RECEIPT_MISSING');
  const payload=JSON.parse(row.payload);
  if(payload.conversationId!==conversationId)fail('CONVERSATION_MISMATCH');
  let candidate=conversationId;
  if(conversationId===null){
   const creation=this.db.prepare('SELECT candidate,confirmed,createdAfter FROM creations WHERE key=?').get(key);
   if(!creation)fail('RECEIPT_MISSING');
   candidate=creation.confirmed??creation.candidate;
   if(candidate==null){
    const resolved=await reader.resolveCreation(payload);
    if(uuid(resolved?.conversationId)){this.candidate(key,resolved.conversationId);candidate=resolved.conversationId;}
    if(candidate==null&&creation.createdAfter!=null){
     const recovered=await reader.findCreation({...payload,createdAfter:creation.createdAfter});
     if(uuid(recovered?.conversationId)){this.candidate(key,recovered.conversationId);candidate=recovered.conversationId;}
    }
   }
   if(candidate==null)return {state:'unknown',messages:[],userMessageId:payload.userMessageId,conversationId:null};
  }
  const result=await reader.readSubmission({...payload,conversationId:candidate,...(conversationId===null?{newChat:true}:{})});
  if(conversationId===null&&result.state!=='unknown')this.db.prepare('UPDATE creations SET confirmed=? WHERE key=?').run(candidate,key);
  if(result.state==='completed')this.db.prepare("UPDATE receipts SET state='completed' WHERE key=?").run(key);
  return {...result,userMessageId:payload.userMessageId,...(conversationId===null?{conversationId:result.state==='unknown'?null:candidate}: {})};
 }
 candidate(key,id){
  const row=this.db.prepare('SELECT candidate FROM creations WHERE key=?').get(key);
  if(!row||row.candidate!=null&&row.candidate!==id)fail('CONVERSATION_MISMATCH');
  this.db.prepare('UPDATE creations SET candidate=? WHERE key=?').run(id,key);
 }
}
