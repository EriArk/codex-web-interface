import {createHash} from 'node:crypto';
const fail=c=>{throw Error(`NATIVE_${c}`);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
/** Uses the dispatch database/binding, making mutations and sends mutually exclusive. */
export class NativeLibraryReceipts {
 constructor(dispatch,projectIds=[]){
  if(!Array.isArray(projectIds)||projectIds.length>4||!projectIds.every(x=>/^g-p-[a-zA-Z0-9-]{1,80}$/.test(x)))fail('INVALID_CANARY');
  this.dispatch=dispatch;this.projects=dispatch.ownerMode?{has:id=>/^g-p-[a-zA-Z0-9-]{1,80}$/.test(id),add:()=>{}}:new Set(projectIds);this.db=dispatch.db;
  this.db.exec('CREATE TABLE IF NOT EXISTS library_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,baseline TEXT NOT NULL,state TEXT NOT NULL)');
 }
 pending(){return !!this.db.prepare("SELECT 1 FROM library_receipts WHERE state='unknown' LIMIT 1").get();}
 validate(r){
  if(!uuid(r.key)||!['thread','project'].includes(r.kind)||!(r.kind==='thread'?this.dispatch.allowed.has(r.id):this.projects.has(r.id))||
   !['rename','pin','archive','delete'].includes(r.action)||r.kind==='project'&&r.action==='archive'||
   r.action==='rename'&&(typeof r.name!=='string'||!r.name.trim()||r.name!==r.name.trim()||r.name.length>120)||
   ['pin','archive'].includes(r.action)&&typeof r.value!=='boolean'||r.action==='delete'&&r.confirm!==true)fail('INVALID_CANARY');
 }
 async run(r,reader,checkOnly=false){
  this.validate(r);
  const hash=createHash('sha256').update(JSON.stringify(r)).digest('hex');
  let row=this.db.prepare('SELECT * FROM library_receipts WHERE key=?').get(r.key);
  if(row&&row.hash!==hash)fail('KEY_CONFLICT');
  if(!row){
   if(checkOnly)fail('RECEIPT_MISSING');
   if(this.dispatch.pending())fail('PENDING_DISPATCH');
   const baseline=await reader.readLibrary(r);
   if(!baseline.exists&&r.kind==='thread'&&r.action==='delete'){
    this.db.prepare("INSERT INTO library_receipts VALUES(?,?,?,?,'completed')").run(r.key,hash,JSON.stringify(r),JSON.stringify(baseline));
    return {state:'completed',name:baseline.name,projectId:baseline.projectId};
   }
   if(!baseline.exists||!baseline.canWrite)fail('LIBRARY_NOT_WRITABLE');
   this.db.prepare("INSERT INTO library_receipts VALUES(?,?,?,?,'unknown')").run(r.key,hash,JSON.stringify(r),JSON.stringify(baseline));
   // A crash after this commit is intentionally unknown, never an automatic retry.
   try{
    const result=await reader.mutateLibrary({...r,baseline});
    if(result?.dispatched===false||result?.rejected===true)this.db.prepare("UPDATE library_receipts SET state='rejected' WHERE key=?").run(r.key);
    // Deletion of a project may prevent any later authorized metadata read. Only a
    // confirmed native success can finish it; a lost acknowledgement stays unknown.
    else if(r.kind==='project'&&r.action==='delete'&&result?.accepted===true)this.db.prepare("UPDATE library_receipts SET state='completed' WHERE key=?").run(r.key);
   }catch{}
   row=this.db.prepare('SELECT * FROM library_receipts WHERE key=?').get(r.key);
  }
  if(row.state==='unknown'){
   try{
    const current=await reader.readLibrary(r);
    const confirmed=r.action==='delete'?!current.exists:r.action==='rename'?current.exists&&current.name===r.name:r.action==='pin'?current.exists&&current.pinned===r.value:current.exists&&current.archived===r.value;
    if(confirmed){this.db.prepare("UPDATE library_receipts SET state='completed' WHERE key=?").run(r.key);row.state='completed';}
   }catch{}
  }
  const baseline=JSON.parse(row.baseline);
  return {state:row.state,name:baseline.name,projectId:baseline.projectId};
 }
}
