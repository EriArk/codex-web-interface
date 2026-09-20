import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {privatePath} from './service.mjs';

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const fail=code=>{throw Error(`NATIVE_${code}`);};
/** At-most-once dispatch receipts, not a queue. Only Hub gpt_jobs can schedule work. */
export class NativeDispatchReceipts {
 constructor({path,userId,accountFingerprint,conversationIds,creationKeys=[],ownerMode=false}){
  if(!uuid(userId)||!/^[a-f0-9]{64}$/.test(accountFingerprint)||!Array.isArray(conversationIds)||
     (!ownerMode&&!conversationIds.length)||conversationIds.length>4||!conversationIds.every(uuid)||!Array.isArray(creationKeys)||creationKeys.length>4||!creationKeys.every(uuid))fail('INVALID_CANARY');
  privatePath(dirname(path),'isDirectory');
  try{privatePath(path,'isFile');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(typeof ownerMode!=="boolean")fail("INVALID_ADMISSION");this.ownerMode=ownerMode;
  this.allowed=ownerMode?{has:uuid}:new Set(conversationIds);this.creationKeys=ownerMode?{has:uuid}:new Set(creationKeys);this.db=new DatabaseSync(path);chmodSync(path,0o600);
  this.db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);");
  this.db.exec("CREATE TABLE IF NOT EXISTS project_creations(key TEXT PRIMARY KEY,name TEXT NOT NULL,projectId TEXT,state TEXT NOT NULL DEFAULT 'unknown')");
  this.db.exec("CREATE TABLE IF NOT EXISTS project_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,uploaded TEXT)");
  this.db.exec("CREATE TABLE IF NOT EXISTS operation_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,baseline TEXT NOT NULL,resultId TEXT,state TEXT NOT NULL)");
  this.db.exec("CREATE TABLE IF NOT EXISTS workspace_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,expected TEXT,state TEXT NOT NULL)");
  this.db.exec('CREATE TABLE IF NOT EXISTS creations(key TEXT PRIMARY KEY REFERENCES receipts(key),candidate TEXT,confirmed TEXT)');
  if(!this.db.prepare('PRAGMA table_info(creations)').all().some(x=>x.name==='createdAfter'))this.db.exec('ALTER TABLE creations ADD COLUMN createdAfter INTEGER');
  this.db.exec('CREATE TABLE IF NOT EXISTS uploads(key TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT,PRIMARY KEY(key,id))');
  this.db.exec('CREATE TABLE IF NOT EXISTS stops(key TEXT PRIMARY KEY REFERENCES receipts(key)); CREATE TABLE IF NOT EXISTS library_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,baseline TEXT NOT NULL,state TEXT NOT NULL)');
  const hash=this.hash([userId,accountFingerprint]);
  this.db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(hash);
  if(this.db.prepare('SELECT hash FROM binding WHERE id=1').get().hash!==hash){this.db.close();fail('INVALID_BINDING');}
 }
 hash(x){return createHash('sha256').update(JSON.stringify(x)).digest('hex');}
 close(){this.db.close();}
 pending(){return !!this.db.prepare("SELECT 1 FROM operation_receipts WHERE state='unknown' LIMIT 1").get() || !!this.db.prepare("SELECT 1 FROM workspace_receipts WHERE state='unknown' LIMIT 1").get() || !!this.db.prepare("SELECT 1 FROM project_creations WHERE projectId IS NULL AND state='unknown' LIMIT 1").get() || !!this.db.prepare("SELECT 1 FROM project_receipts WHERE state='unknown' LIMIT 1").get() || !!this.db.prepare("SELECT 1 FROM library_receipts WHERE state='unknown' LIMIT 1").get() || !!this.db.prepare("SELECT 1 FROM receipts WHERE state NOT IN ('completed','cancelled','checked') LIMIT 1").get();}
 blocksDispatch(conversationId){
  if(this.db.prepare("SELECT 1 FROM operation_receipts WHERE state='unknown' LIMIT 1").get()||this.db.prepare("SELECT 1 FROM workspace_receipts WHERE state='unknown' LIMIT 1").get()||this.db.prepare("SELECT 1 FROM project_receipts WHERE state='unknown' LIMIT 1").get()||this.db.prepare("SELECT 1 FROM library_receipts WHERE state='unknown' LIMIT 1").get()||this.db.prepare("SELECT 1 FROM project_creations WHERE projectId IS NULL AND state='unknown' LIMIT 1").get())return true;
  return this.db.prepare("SELECT payload,state FROM receipts WHERE state NOT IN ('completed','cancelled','checked')").all().some(x=>JSON.parse(x.payload).conversationId===conversationId);
 }
 validate(r){
  if(r.projectId!=null&&!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(r.projectId))fail('INVALID_PROJECT');
  if(!(r.conversationId===null?this.creationKeys.has(r.key):this.allowed.has(r.conversationId))||!uuid(r.key)||!uuid(r.userMessageId)||typeof r.text!=='string'||Buffer.byteLength(r.text)>32768||
     typeof r.versionId!=='string'||r.versionId.length>128||!Number.isSafeInteger(r.presetId))fail('INVALID_CANARY');
 }
 admitUpload(r){if(!(r.conversationId===null?this.creationKeys.has(r.key):this.allowed.has(r.conversationId))||!uuid(r.key)||!uuid(r.file?.id))fail('INVALID_CANARY');}
 async upload(r,reader,stored){
  if(!(r.conversationId===null?this.creationKeys.has(r.key):this.allowed.has(r.conversationId))||!uuid(r.key))fail('INVALID_CANARY');
  const f=r.file;
  const max=f?.mime?.startsWith('image/')?20*1024**2:512*1024**2;
  if(!f||!uuid(f.id)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>max||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i.test(f.mime)||typeof f.name!=='string'||!f.name||f.name.length>255||/[\\/\x00-\x1f]/.test(f.name)||!/^[a-f0-9]{64}$/.test(f.sha256??''))fail('INVALID_UPLOAD');
  const hash=this.hash([r.conversationId,f.id,f.name,f.mime,f.bytes,f.sha256]);
  const old=this.db.prepare('SELECT hash,result FROM uploads WHERE key=? AND id=?').get(r.key,f.id);
  if(old){if(old.hash!==hash)fail('UPLOAD_CHANGED');if(!old.result)fail('UPLOAD_UNKNOWN');return JSON.parse(old.result);}
  let path;
  if(stored)path=await stored.verified(r);
  else {
   if(typeof f.base64!=='string'||f.base64.length>27962028||f.bytes>20*1024**2)fail('INVALID_UPLOAD');
   const bytes=Buffer.from(f.base64,'base64');
   if(bytes.length!==f.bytes||bytes.toString('base64')!==f.base64||createHash('sha256').update(bytes).digest('hex')!==f.sha256)fail('UPLOAD_CHANGED');
  }

  if(this.blocksDispatch(r.conversationId)||this.db.prepare('SELECT 1 FROM receipts WHERE key=?').get(r.key))fail('PENDING_DISPATCH');
  if(this.db.prepare('SELECT count(*) AS n FROM uploads WHERE key=?').get(r.key).n>=8)fail('TOO_MANY_UPLOADS');
  this.db.prepare('INSERT INTO uploads(key,id,hash) VALUES(?,?,?)').run(r.key,f.id,hash);
  const native=await (path?reader.uploadStoredFile(r,path):reader.uploadFile(r));
  if(!native||typeof native.id!=='string'||!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(native.id)||native.name!==f.name||native.mimeType!==f.mime||native.size!==f.bytes||native.source!=='local'||
     (f.mime.startsWith('image/')&&(!Number.isSafeInteger(native.width)||!Number.isSafeInteger(native.height)||native.width<1||native.height<1||native.width>8192||native.height>8192||native.width*native.height>32000000)))fail('INVALID_UPLOAD_RESPONSE');
  const result={id:f.id,sha256:f.sha256,native:{id:native.id,name:f.name,mimeType:f.mime,size:f.bytes,source:'local',...(f.mime.startsWith('image/')?{width:native.width,height:native.height}:{})}};
  this.db.prepare('UPDATE uploads SET result=? WHERE key=? AND id=?').run(JSON.stringify(result),r.key,f.id);
  return result;
 }
 async prepare(r,reader){
  this.validate(r);
  if(this.blocksDispatch(r.conversationId))fail('PENDING_DISPATCH');
  let ui=await reader.selectConversation(r);
  // Native navigation is asynchronous. Wait only for the exact idle composer;
  // never interpret a stale/home composer as the selected conversation.
  let ready=false;
  for(let attempt=0;attempt<12;attempt++){
   if(attempt)ui=await reader.inspectConversation(r);
   if(ui.hasDraft||ui.stopAvailable)fail('NOT_READY');
   if(ui.selected&&ui.composerReady){ready=true;break;}
   await new Promise(resolve=>setTimeout(resolve,125));
  }
  if(!ready)fail('NOT_READY');
  // Model and effort are passed directly to the native completion action.
  // Do not drive the visual picker or gate sends on its asynchronously derived state.
  const catalog=await reader.readModels(r);
  const preset=catalog.versions.find(v=>v.id===r.versionId&&v.enabled)?.presets.find(p=>p.id===r.presetId&&p.available);
  if(!preset)fail('INVALID_SETTINGS');
  const selected={...r,model:preset.model,effort:preset.effort};
  const prepared=await reader.prepareDispatch(r.conversationId===null?{...selected,parentId:randomUUID()}:selected);
  return {...prepared,versionId:r.versionId,presetId:r.presetId};
 }
 async dispatch(r,reader){
  this.validate(r);
  if(!r.text.trim()&&!r.attachments?.length)fail('EMPTY_MESSAGE');
  if(!uuid(r.parentId)||typeof r.model!=='string'||r.model.length>128||(r.effort!==null&&typeof r.effort!=='string')||r.intentPersisted!==true)fail('INVALID_REQUEST');
  if(r.attachments!=null){
   if(!Array.isArray(r.attachments)||r.attachments.length>8||new Set(r.attachments.map(f=>f.id)).size!==r.attachments.length)fail('INVALID_UPLOAD');
   for(const f of r.attachments){
    const saved=this.db.prepare('SELECT hash,result FROM uploads WHERE key=? AND id=?').get(r.key,f.id);
    if(!saved?.result||this.hash(JSON.parse(saved.result))!==this.hash(f)||saved.hash!==this.hash([r.conversationId,f.id,f.native.name,f.native.mimeType,f.native.size,f.sha256]))fail('UPLOAD_MISMATCH');
   }
  }
  const uploaded=this.db.prepare('SELECT id,result FROM uploads WHERE key=?').all(r.key);
  if(uploaded.length!==(r.attachments??[]).length||uploaded.some(x=>!x.result))fail('UPLOAD_MISMATCH');
  const hash=this.hash(r),old=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(r.key);
  if(old){if(old.hash!==hash)fail('KEY_CONFLICT');return {state:old.state==='completed'?'completed':'unknown',userMessageId:r.userMessageId};}
  if(this.blocksDispatch(r.conversationId))fail('PENDING_DISPATCH');
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
  if(result.state==='running'&&this.db.prepare('SELECT 1 FROM stops WHERE key=?').get(key)){
   const ui=await reader.inspectConversation({...payload,conversationId:candidate});
   if(ui.selected&&ui.composerReady&&!ui.stopAvailable&&!ui.hasDraft){
    // Inspect is only the idle proof; canonical exact-user read protects a newer turn.
    const checked=await reader.readSubmission({...payload,conversationId:candidate,...(conversationId===null?{newChat:true}:{})});
    if(checked.state==='running'){result.state='cancelled';result.messages=checked.messages;}
    else {result.state=checked.state;result.messages=checked.messages;}
   }
  }
  if(conversationId===null&&result.state!=='unknown')this.db.prepare('UPDATE creations SET confirmed=? WHERE key=?').run(candidate,key);
  if(['running','completed','cancelled'].includes(result.state))this.db.prepare("UPDATE receipts SET state=? WHERE key=?").run(result.state,key);
  return {...result,userMessageId:payload.userMessageId,...(conversationId===null?{conversationId:result.state==='unknown'?null:candidate}: {})};
 }
 async review(r,reader){
  const result=await this.reconcile(r,reader);
  if(result.state!=='unknown')return {reviewed:false};
  const payload=JSON.parse(this.db.prepare('SELECT payload FROM receipts WHERE key=?').get(r.key).payload);
  if(payload.conversationId!==null){
   await reader.selectConversation(payload);
   for(let n=0;n<12;n++){
    const ui=await reader.inspectConversation(payload);
    if(ui.selected&&ui.composerReady&&!ui.hasDraft&&!ui.stopAvailable)break;
    if(n===11||ui.hasDraft||ui.stopAvailable)fail('NOT_READY');
    await new Promise(ok=>setTimeout(ok,125));
   }
  }else{const a=await reader.workspace({...payload,operation:'activity'});if(!a.ready||a.generating)fail('NOT_READY');}
  const again=await this.reconcile(r,reader);if(again.state!=='unknown')return {reviewed:false};
  const updated=this.db.prepare("UPDATE receipts SET state='checked' WHERE key=? AND state IN ('unknown','running')").run(r.key);
  return {reviewed:updated.changes===1};
 }
 async stop(r,reader){
  const result=await this.reconcile(r,reader);
  if(['completed','cancelled'].includes(result.state))return {stopIssued:false};
  if(result.state!=='running')fail('TURN_UNCONFIRMED');
  const payload=JSON.parse(this.db.prepare('SELECT payload FROM receipts WHERE key=?').get(r.key).payload);
  const conversationId=result.conversationId??payload.conversationId;
  if(!uuid(conversationId))fail('TURN_UNCONFIRMED');
  if(this.db.prepare('SELECT 1 FROM stops WHERE key=?').get(r.key))return {stopIssued:true};
  await reader.selectConversation({...payload,conversationId});
  for(let n=0;n<12;n++){
   const ui=await reader.inspectConversation({...payload,conversationId});
   if(ui.selected&&ui.composerReady&&ui.stopAvailable&&!ui.hasDraft)break;
   if(n===11||ui.hasDraft)fail('NOT_READY');
   await new Promise(ok=>setTimeout(ok,125));
  }
  this.db.prepare('INSERT INTO stops VALUES(?)').run(r.key);
  await reader.stopResponse({...payload,conversationId});
  return {stopIssued:true};
 }
 candidate(key,id){
  const row=this.db.prepare('SELECT candidate FROM creations WHERE key=?').get(key);
  if(!row||row.candidate!=null&&row.candidate!==id)fail('CONVERSATION_MISMATCH');
  this.db.prepare('UPDATE creations SET candidate=? WHERE key=?').run(id,key);
 }
}
