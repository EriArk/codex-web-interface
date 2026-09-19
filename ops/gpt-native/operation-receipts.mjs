import {randomUUID,createHash} from 'node:crypto';
const fail=c=>{throw Error('NATIVE_'+c);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const chain=g=>{const a=[],seen=new Set();let id=g.current_node;while(id&&!seen.has(id)){seen.add(id);const n=g.mapping[id];if(!n)fail('INVALID_HISTORY');a.push(n);id=n.parent;}return a.reverse();};
export class NativeOperationReceipts{
 constructor(dispatch){this.dispatch=dispatch;this.db=dispatch.db;this.db.exec("CREATE TABLE IF NOT EXISTS operation_receipts(key TEXT PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL,baseline TEXT NOT NULL,resultId TEXT,state TEXT NOT NULL)");}
 async run(r,reader,check=false){
  if(!uuid(r.key)||!uuid(r.conversationId)||!['edit','regenerate','fork'].includes(r.action)||typeof r.text!=='string'||r.text.length>100000)fail('INVALID_REQUEST');
  const hash=createHash('sha256').update(JSON.stringify({...r,review:undefined})).digest('hex');let row=this.db.prepare('SELECT * FROM operation_receipts WHERE key=?').get(r.key);
  if(row&&row.hash!==hash)fail('KEY_CONFLICT');
  if(!row){
   if(check)fail('RECEIPT_MISSING');if(this.dispatch.pending())fail('PENDING_DISPATCH');
   const graph=await reader.readConversationGraph(r),nodes=chain(graph),index=nodes.findIndex(n=>n.message?.id===r.messageId),source=nodes[index];
   if(graph.current_node!==r.currentNode||!source||source.message.author.role!==(r.action==='edit'?'user':'assistant'))fail('BRANCH_CHANGED');
   const prompt=nodes.slice(0,index+1).reverse().find(n=>n.message?.author?.role==='user');if(!prompt)fail('INVALID_REQUEST');
   if(r.action==='fork'&&!Object.values(graph.mapping).some(n=>n.message?.id===r.targetMessageId))fail('INVALID_REQUEST');
   await reader.selectConversation(r);
   for(let n=0;n<12;n++){const ui=await reader.inspectConversation(r);if(ui.composerReady&&!ui.hasDraft&&!ui.stopAvailable)break;if(n===11||ui.hasDraft||ui.stopAvailable)fail('NOT_READY');await new Promise(ok=>setTimeout(ok,125));}
   await reader.selectSettings({...r,versionId:r.model,presetId:Number(r.effort)});
   const models=await reader.readModels(r),preset=models.versions.find(v=>v.enabled&&v.id===r.model)?.presets.find(p=>p.id===Number(r.effort)&&p.available);if(!preset)fail('INVALID_SETTINGS');
   const payload={...r,createdAt:Date.now(),parentId:r.action==='fork'?r.targetMessageId:source.parent,projectId:graph.gizmo_id??null,fork:r.action==='fork',userMessageId:randomUUID(),promptId:prompt.id,nativeModel:preset.model,nativeEffort:preset.effort,intentPersisted:true};
   this.db.prepare("INSERT INTO operation_receipts VALUES(?,?,?,?,NULL,'unknown')").run(r.key,hash,JSON.stringify(payload),JSON.stringify({ids:Object.keys(graph.mapping),parent:source.parent,prompt:prompt.id}));
   try{const result=await reader.mutateOperation(payload);if(result.dispatched===false)this.db.prepare("UPDATE operation_receipts SET state='rejected' WHERE key=?").run(r.key);if(uuid(result.nativeId))this.db.prepare('UPDATE operation_receipts SET resultId=? WHERE key=?').run(result.nativeId,r.key);}catch{}
   row=this.db.prepare('SELECT * FROM operation_receipts WHERE key=?').get(r.key);
  }
  const saved=JSON.parse(row.payload),baseline=JSON.parse(row.baseline);
  if(row.state==='unknown'){
   try{
    if(r.action==='fork'&&!row.resultId){
     const found=await reader.findCreation({...saved,text:saved.text,model:saved.nativeModel,effort:saved.nativeEffort,createdAfter:saved.createdAt??0});
     if(uuid(found.conversationId)){row.resultId=found.conversationId;this.db.prepare('UPDATE operation_receipts SET resultId=? WHERE key=?').run(row.resultId,r.key);}
    }
    const nativeId=r.action==='fork'?row.resultId:r.conversationId;
    if(nativeId){
     const graph=await reader.readConversationGraph({...saved,conversationId:nativeId}),nodes=chain(graph);
     const userIndex=nodes.findIndex(n=>n.message?.id===(r.action==='regenerate'?saved.promptId:saved.userMessageId));
     const user=nodes[userIndex],tail=nodes.slice(userIndex+1);
     const matched=userIndex>=0&&(r.action==='regenerate'||user.message.content.parts.filter(x=>typeof x==='string').join('\n')===saved.text)&&(r.action!=='edit'||user.parent===baseline.parent)&&!tail.some(n=>n.message?.author.role==='user')&&tail.some(n=>!baseline.ids.includes(n.id)&&n.message?.author.role==='assistant'&&n.message.channel==='final'&&n.message.status==='finished_successfully'&&n.message.end_turn===true);
     if(matched){row.state='completed';this.db.prepare("UPDATE operation_receipts SET state='completed' WHERE key=?").run(r.key);}
    }
   }catch{}
  }
  if(r.review===true&&row.state==='unknown'){
   const conversationId=r.action==='fork'?row.resultId:r.conversationId;
   if(!uuid(conversationId))fail('TURN_UNCONFIRMED');
   await reader.selectConversation({...saved,conversationId});
   const a=await reader.inspectConversation({...saved,conversationId});
   if(!a.selected||!a.composerReady||a.stopAvailable||a.hasDraft)fail('NOT_READY');
   this.db.prepare("UPDATE operation_receipts SET state='checked' WHERE key=?").run(r.key);row.state='checked';
  }
  return {state:row.state,dispatched:row.state!=='rejected',nativeId:row.resultId};
 }
}
