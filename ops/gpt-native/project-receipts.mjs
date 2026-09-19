import {createHash} from 'node:crypto';
const fail=c=>{throw Error('NATIVE_'+c);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
export class NativeProjectReceipts {
 constructor(dispatch,projectIds=[],creationKeys=[]){this.dispatch=dispatch;this.allowed=new Set(projectIds);this.db=dispatch.db;
  if(!Array.isArray(creationKeys)||creationKeys.length>4||!creationKeys.every(uuid))fail('INVALID_CANARY');
  this.creationKeys=new Set(creationKeys);
  this.db.exec("CREATE TABLE IF NOT EXISTS project_creations(key TEXT PRIMARY KEY,name TEXT NOT NULL,projectId TEXT,state TEXT NOT NULL DEFAULT 'unknown')");
  for(const row of this.db.prepare('SELECT projectId FROM project_creations WHERE projectId IS NOT NULL').all())this.allowed.add(row.projectId);
  this.db.exec("CREATE TABLE IF NOT EXISTS project_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,uploaded TEXT)");
 }
 async create(r,reader){
  if(!this.creationKeys.has(r.key)||typeof r.name!=='string'||!r.name.trim()||r.name.length>120)fail('INVALID_CANARY');
  const old=this.db.prepare('SELECT * FROM project_creations WHERE key=?').get(r.key);
  if(old){if(old.name!==r.name)fail('KEY_CONFLICT');return {projectId:old.projectId,...(old.state==='rejected'?{rejected:true}:{})};}
  if(this.dispatch.pending())fail('PENDING_DISPATCH');
  this.db.prepare('INSERT INTO project_creations(key,name,projectId) VALUES(?,?,NULL)').run(r.key,r.name);
  const result=await reader.createProject(r);
  if(result?.rejected===true){this.db.prepare("UPDATE project_creations SET state='rejected' WHERE key=?").run(r.key);return {projectId:null,rejected:true};}
  if(!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(result?.projectId??''))fail('PROJECT_CREATE_UNKNOWN');
  this.db.prepare('UPDATE project_creations SET projectId=? WHERE key=?').run(result.projectId,r.key);
  this.allowed.add(result.projectId);return result;
 }
 admit(r){if(!uuid(r.key)||!this.allowed.has(r.projectId))fail('INVALID_CANARY');}
 async execute(r,reader,uploads,transfer){
  this.admit(r);
  if(!/^[a-f0-9]{64}$/.test(r.revision??'')||!['instructions','upload','remove'].includes(r.action)||r.action==='instructions'&&(typeof r.text!=='string'||r.text.length>100000)||r.action==='remove'&&(!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(r.fileId??'')||r.confirm!==true))fail('INVALID_PROJECT');
  const hash=createHash('sha256').update(JSON.stringify(r)).digest('hex');
  const old=this.db.prepare('SELECT * FROM project_receipts WHERE key=?').get(r.key);
  if(old){if(old.hash!==hash)fail('KEY_CONFLICT');return this.check(r,reader);}
  if(this.dispatch.pending())fail('PENDING_DISPATCH');
  const before=await reader.inspectProject(r);
  if(!before.canWrite||before.revision!==r.revision||r.action==='remove'&&!before.files.some(f=>f.id===r.fileId)){
   this.db.prepare("INSERT INTO project_receipts VALUES(?,?,?,'rejected',NULL)").run(r.key,hash,JSON.stringify(r));return {state:'rejected'};
  }
  const path=r.action==='upload'?await uploads.verified(r):null;
  this.db.prepare("INSERT INTO project_receipts VALUES(?,?,?,'unknown',NULL)").run(r.key,hash,JSON.stringify(r));
  try{
   let uploaded;
   if(path){
    uploaded=await transfer(reader,r,path);
    if(!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(uploaded?.id??'')||uploaded.name!==r.file.name||uploaded.size!==r.file.bytes||uploaded.mimeType!==r.file.mime)fail('UPLOAD_MISMATCH');
    this.db.prepare('UPDATE project_receipts SET uploaded=? WHERE key=?').run(JSON.stringify(uploaded),r.key);
   }
   // Fresh revision checked again in renderer after potentially long upload.
   const result=await reader.mutateProject({...r,...(uploaded?{uploaded}:{})});
   if(result?.dispatched===false||result?.rejected===true)this.db.prepare("UPDATE project_receipts SET state='rejected' WHERE key=?").run(r.key);
  }catch{}
  return this.check(r,reader);
 }
 async check(r,reader){
  this.admit(r);
  const row=this.db.prepare('SELECT * FROM project_receipts WHERE key=?').get(r.key);
  if(!row)fail('RECEIPT_MISSING');
  const saved=JSON.parse(row.payload);if(saved.projectId!==r.projectId)fail('PROJECT_MISMATCH');
  if(row.state!=='unknown')return {state:row.state};
  try{
   const current=await reader.inspectProject(saved),file=row.uploaded?JSON.parse(row.uploaded):null;
   const found=saved.action==='instructions'?current.instructions===saved.text:saved.action==='remove'?!current.files.some(f=>f.id===saved.fileId):file&&current.files.some(f=>[file.id,file.libraryFileId].filter(Boolean).includes(f.id)&&f.name===file.name&&f.bytes===file.size);
   if(found){this.db.prepare("UPDATE project_receipts SET state='completed' WHERE key=?").run(r.key);return {state:'completed'};}
  }catch{}
  return {state:'unknown'};
 }
}
