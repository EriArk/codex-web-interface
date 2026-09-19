import {createHash} from 'node:crypto';
const fail=c=>{throw Error('NATIVE_'+c);};
export class NativeWorkspaceReceipts{
 constructor(dispatch){this.dispatch=dispatch;this.db=dispatch.db;this.db.exec("CREATE TABLE IF NOT EXISTS workspace_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,expected TEXT,state TEXT NOT NULL)");}
 async run(r,reader,check=false){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(r.key??''))fail('INVALID_REQUEST');
  let row=this.db.prepare('SELECT * FROM workspace_receipts WHERE key=?').get(r.key);
  const hash=createHash('sha256').update(JSON.stringify(r.input)).digest('hex');
  if(row&&row.hash!==hash)fail('KEY_CONFLICT');
  if(!row){
   if(check)fail('RECEIPT_MISSING');if(this.dispatch.pending())fail('PENDING_DISPATCH');
   const i=r.input;let expected=null;
   if(i.kind==='canvas'){
    const before=(await reader.workspace({...r,operation:'canvasList',conversationId:i.conversationId})).items.find(x=>x.id===i.id);
    if(!before||before.revision!==i.revision)fail('BRANCH_CHANGED');
    expected={...await reader.workspace({...r,operation:'canvasVersion',conversationId:i.conversationId,id:i.id,version:i.version}),baselineVersion:before.version};
   }
   this.db.prepare("INSERT INTO workspace_receipts VALUES(?,?,?,?,'unknown')").run(r.key,hash,JSON.stringify(r),expected?JSON.stringify(expected):null);
   try{const v=await reader.workspace({...r,operation:'workspaceMutation'});if(v.dispatched===false)this.db.prepare("UPDATE workspace_receipts SET state='rejected' WHERE key=?").run(r.key);}catch{}
   row=this.db.prepare('SELECT * FROM workspace_receipts WHERE key=?').get(r.key);
  }
  if(row.state==='unknown'){
   try{
    const saved=JSON.parse(row.payload),i=saved.input;
    const current=i.kind==='schedule'?(await reader.workspace({...saved,operation:'scheduledRead',id:i.id})).item:(await reader.workspace({...saved,operation:'canvasList',conversationId:i.conversationId})).items.find(x=>x.id===i.id);
    const expected=row.expected?JSON.parse(row.expected):null;
    const match=i.kind==='canvas'?current&&expected&&current.version>expected.baselineVersion&&current.content===expected.content:i.action==='delete'?current===null:current&&(i.action==='save'?['title','prompt','schedule','timezone','enabled'].every(k=>current[k]===i[k]):current.enabled===(i.action==='resume'));
    if(match){this.db.prepare("UPDATE workspace_receipts SET state='completed' WHERE key=?").run(r.key);row.state='completed';}
   }catch{}
  }
  if(r.review===true&&row.state==='unknown'){
   const a=await reader.workspace({...JSON.parse(row.payload),operation:'activity'});if(!a.ready||a.generating)fail('NOT_READY');
   this.db.prepare("UPDATE workspace_receipts SET state='checked' WHERE key=?").run(r.key);row.state='checked';
  }
  return {state:row.state,dispatched:row.state!=='rejected'};
 }
}
