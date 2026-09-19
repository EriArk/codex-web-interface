// Native reply actions over the pinned application's own completion service.
export async function nativeOperation(r,read,control,load=()=>import('app://-/assets/app-initial-430deae5a13a.js'),runtime=globalThis,loadActions=()=>import('app://-/assets/register-app-actions-a2e5974b9821.js')){
 const fail=c=>{throw Error('NATIVE_'+c);};
 if(!['edit','regenerate','fork'].includes(r.action)||!r.intentPersisted)fail('INVALID_REQUEST');
 const bound={conversationId:r.conversationId,accountFingerprint:r.accountFingerprint};
 const graph=await read({operation:'readConversationGraph',...bound},load,runtime);
 if(graph.current_node!==r.currentNode)fail('BRANCH_CHANGED');
 const ui=await control({operation:'inspectConversation',...bound},read,load,runtime);
 if(!ui.selected||!ui.composerReady||ui.hasDraft||ui.stopAvailable)fail('NOT_READY');
 const m=await load(),registry=(await loadActions()).appActionRegistry,original=registry?.get('app.get_summary');
 if(typeof original!=='function'||typeof m.mDt!=='function'||typeof m.z$!=='function'||typeof m.czt!=='function')fail('INCOMPATIBLE');
 let scope;const capture=(i,c)=>{scope=c?.scope;return original(i,c);};registry.set('app.get_summary',capture);
 try{await m.M9.appActions.runInPrimaryWindow({action:{type:'app.get_summary'}});}finally{if(registry.get('app.get_summary')===capture)registry.set('app.get_summary',original);}
 if(!scope?.get)fail('INCOMPATIBLE');
 const principal=(await m.M9.accessInputs.readAccountInfo())?.data;
 if((await read({operation:'inspectAccount'},load,runtime)).accountFingerprint!==r.accountFingerprint)fail('ACCOUNT_CHANGED');
 const selected=scope.get(m.VNt,m.eWt(r.conversationId));if(selected?.slug!==r.nativeModel||(selected.thinkingEffort??null)!==r.nativeEffort)fail('INVALID_SETTINGS');
 if(scope.get(m.gzt,m.eWt(r.conversationId))!==r.currentNode)fail('BRANCH_CHANGED');
 const sameAccount=()=>{const p=scope.get(m.dWt);return p?.accountId===principal.accountId&&p?.userId===principal.userId;};
 let localId=m.eWt(r.conversationId),nativeId=r.conversationId,attempts=0,dispatched=false,admitted=true;
 const startupSignal=AbortSignal.timeout(15000);
 if(r.action==='fork'){const branch=await m.czt(scope,{conversationId:localId,messageId:r.targetMessageId});localId=branch.clientThreadId;nativeId=null;}
 const source=Object.values(graph.mapping).find(n=>n.message?.id===r.messageId),target=Object.values(graph.mapping).find(n=>n.message?.id===r.targetMessageId);
 const parent=r.action==='edit'?source?.parent:r.action==='fork'?target?.id:r.promptId;
 if(typeof parent!=='string')fail('INVALID_REQUEST');
 const service=scope.get(m.CUt);
 const guarded=new Proxy(service,{get(t,k){
  if(k==='createCompletionStreamHandlers')return args=>t.createCompletionStreamHandlers({...args,shouldAttemptResume:()=>false});
  if(k==='startCompletionStream')return args=>{
   const b=args.request,users=b?.messages?.filter(x=>x.author?.role==='user')??[];
   if(!sameAccount()||b.model!==r.nativeModel||(b.thinking_effort??null)!==r.nativeEffort||b.parent_message_id!==parent||
      (r.action==='fork'?(b.conversation_id!=null||b.branching_from_conversation_id!==r.conversationId||b.branching_from_message_id!==r.targetMessageId):b.conversation_id!==r.conversationId)||
      (r.action==='regenerate'?(b.action!=='variant'||users.length!==0):(b.action!=='next'||users.length!==1||users[0].id!==r.userMessageId||users[0].content.parts.filter(x=>typeof x==='string').join('\n')!==r.text)))fail('OPERATION_CHANGED');
   return Reflect.apply(t.startCompletionStream,guarded,[{...args,expectedIdentity:{accountId:principal.accountId,userId:principal.userId},assertRequestCurrent:()=>{if(!admitted||startupSignal.aborted||attempts++!==0)fail('REPLAY_BLOCKED');if(!sameAccount())fail('ACCOUNT_CHANGED');args.assertRequestCurrent?.();dispatched=true;runtime[Symbol.for('codex-web.native-history')]?.delete(r.accountFingerprint+':'+r.conversationId);}}]);
  }
  const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;
 }});
 const proxy=new Proxy(scope,{get(t,k){if(k==='get')return(a,...args)=>a===m.CUt?guarded:t.get(a,...args);const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
 try{
 if(r.action==='regenerate')await m.z$(proxy,{conversationId:localId,isTemporaryChat:false,messageId:r.messageId,retry:{source:'regenerate',model:{slug:r.nativeModel,thinkingEffort:r.nativeEffort}}});
 else{
  const messages=m.lDt({attachments:[],prompt:r.text,systemHints:scope.get(m.UNt,localId)});
  if(r.action==='edit')messages.message={...messages.message,...source.message,metadata:{...source.message.metadata}};
  messages.message.id=r.userMessageId;messages.message.content={content_type:source?.message?.content?.content_type==='multimodal_text'&&r.action==='edit'?'multimodal_text':'text',parts:[...(r.action==='edit'?source.message.content.parts.filter(x=>typeof x!=='string'):[]),r.text]};
  const result=await m.mDt(proxy,{conversationId:localId,parentMessageId:parent,model:r.nativeModel,thinkingEffort:r.nativeEffort,prompt:r.text,userCompletionMessages:messages,systemHints:scope.get(m.UNt,localId),startupSignal,requireDispatchAcceptance:true,isSubmissionCurrent:()=>admitted&&!startupSignal.aborted&&sameAccount(),onServerThreadIdChange:id=>{nativeId=id;}});
  nativeId=result?.serverConversationId??nativeId;
 }
 }finally{admitted=false;}
 return {dispatched,nativeId:r.action==='fork'?nativeId:r.conversationId};
}
