import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {discoverSocket,requestFrame,testedBuild} from './ipc.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = text => createHash('sha256').update(text).digest('hex');

/** Disposable-chat lab only. Production must reuse Hub jobs, not this test ledger. */
export class NativeLabFollowup {
 static async open({directory,...options}) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const dir=await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode&0o077)) throw Error('NATIVE_RECEIPTS_UNSAFE');
  const path=join(directory,'followups.sqlite');
  try {
   const file=await lstat(path);
   if (!file.isFile() || file.uid!==dir.uid || (file.mode&0o077)) throw Error('NATIVE_RECEIPTS_UNSAFE');
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  const db=new DatabaseSync(path);
  await chmod(path,0o600);
  try { return new NativeLabFollowup({...options,db}); } catch(error) {db.close();throw error;}
 }
 constructor({db,reader,conversationId,accountFingerprint,callerThreadId,build,disposable,dispatch}) {
  if (build!==testedBuild || disposable!==true) throw Error('NATIVE_LAB_ONLY');
  if (!uuid(conversationId)||!uuid(callerThreadId)||!/^[a-f0-9]{64}$/.test(accountFingerprint??'')) throw Error('NATIVE_INVALID_BINDING');
  this.db=db;this.reader=reader;this.binding={conversationId,accountFingerprint};
  this.callerThreadId=callerThreadId;
  this.dispatch=dispatch??(async({prompt,callId})=>requestFrame(await discoverSocket(),{
   jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{namespace:'codex_app',tool:'send_message_to_thread',
    arguments:{threadId:conversationId,prompt},threadId:callerThreadId,callId,turnId:'codex-web-disposable-followup'},
  },{timeoutMs:15000}));
  db.exec(`PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, prompt TEXT NOT NULL, hash TEXT NOT NULL,
    state TEXT NOT NULL, baseline TEXT NOT NULL, callId TEXT NOT NULL, userMessageId TEXT, created INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS single_pending ON receipts((1)) WHERE state IN ('dispatching','acknowledged','unknown');`);
  const fingerprint=hash(JSON.stringify([build,conversationId,accountFingerprint,callerThreadId]));
  db.prepare('INSERT OR IGNORE INTO binding VALUES(1,?)').run(fingerprint);
  if(db.prepare('SELECT hash FROM binding WHERE id=1').get().hash!==fingerprint)throw Error('NATIVE_RECEIPT_BINDING_MISMATCH');
 }
 close(){this.db.close();}
 result(row){return {key:row.key,state:row.state==='dispatching'?'unknown':row.state,userMessageId:row.userMessageId??null};}
 async send({key,prompt}) {
  // Diagnostic nonce is required because this native tool has no client message ID.
  if(!uuid(key)||typeof prompt!=='string'||!prompt.includes(key)||prompt!==prompt.trim()||Buffer.byteLength(prompt)>32768)throw Error('NATIVE_INVALID_SEND');
  const digest=hash(prompt),existing=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
  if(existing){if(existing.hash!==digest)throw Error('NATIVE_KEY_CONFLICT');return this.result(existing);}
  if(this.db.prepare("SELECT key FROM receipts WHERE state IN ('dispatching','acknowledged','unknown')").get())throw Error('NATIVE_PENDING_RECEIPT');
  const state=await this.reader.inspectConversation(this.binding);
  if(!state.selected||!state.composerReady||state.hasDraft||state.stopAvailable)throw Error('NATIVE_NOT_READY');
  const history=await this.reader.readConversation(this.binding);
  if(history.conversationId!==this.binding.conversationId)throw Error('NATIVE_CONVERSATION_MISMATCH');
  const callId=randomUUID();
  // SQLite commits the dispatch intention before IPC. Lost acknowledgements never replay.
  try {this.db.prepare('INSERT INTO receipts(key,prompt,hash,state,baseline,callId,created) VALUES(?,?,?,\'dispatching\',?,?,?)')
   .run(key,prompt,digest,history.currentNode,callId,Date.now());}
  catch {
   const concurrent=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
   if(concurrent&&concurrent.hash===digest)return this.result(concurrent);
   if(concurrent)throw Error('NATIVE_KEY_CONFLICT');
   throw Error('NATIVE_PENDING_RECEIPT');
  }
  let next='unknown';
  try {const response=await this.dispatch({prompt,callId});if(response?.success===true)next='acknowledged';}catch{}
  this.db.prepare('UPDATE receipts SET state=? WHERE key=?').run(next,key);
  return this.result(this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key));
 }
 async reconcile(key) {
  if(!uuid(key))throw Error('NATIVE_INVALID_REQUEST');
  const receipt=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
  if(!receipt)throw Error('NATIVE_RECEIPT_MISSING');
  if(receipt.state==='confirmed')return this.result(receipt);
  // Bounded scan. If the baseline is absent, do not guess by text or replay.
  let before, found=false;const later=[];
  for(let page=0;page<5;page++){
   const history=await this.reader.readConversation({...this.binding,before});
   if(history.conversationId!==this.binding.conversationId)throw Error('NATIVE_CONVERSATION_MISMATCH');
   for(const message of [...history.messages].reverse()){
    if(message.nodeId===receipt.baseline){found=true;break;}
    later.push(message);
   }
   if(found||!history.before)break;
   before=history.before;
  }
  const matches=later.filter(m=>m.role==='user'&&m.text===receipt.prompt);
  const canonicalUsers=later.filter(m=>m.role==='user');
  if(found&&matches.length===1&&canonicalUsers.length===1){
   this.db.prepare("UPDATE receipts SET state='confirmed',userMessageId=? WHERE key=?").run(matches[0].id,key);
  } else this.db.prepare("UPDATE receipts SET state='unknown' WHERE key=?").run(key);
  return this.result(this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key));
 }
}
