// Pinned native consumer-Chat send canary. No credentials, HTTP bodies or raw events leave the renderer.
export async function nativeDispatch(request, read, control,
 load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis,
 loadActions = () => import('app://-/assets/register-app-actions-a2e5974b9821.js')) {
 const fail = code => { throw Error(`NATIVE_${code}`); };
 const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
 if (!['prepareDispatch','dispatchText','inspectDispatch','resolveCreation'].includes(request.operation) ||
     (request.conversationId!==null&&!uuid(request.conversationId)) || !uuid(request.key) || !uuid(request.userMessageId) ||
     typeof request.text !== 'string' || new TextEncoder().encode(request.text).length > 32768 ||
     typeof request.model !== 'string' || request.model.length > 128 ||
     (request.effort !== null && (typeof request.effort !== 'string' || request.effort.length > 128))) fail('INVALID_REQUEST');
 if(request.projectId!=null&&!/^g-p-[a-zA-Z0-9-]{1,80}$/.test(request.projectId))fail('INVALID_PROJECT');
 const attachments=(request.attachments??[]).map(f=>f.native);
 if(!Array.isArray(request.attachments??[])||attachments.length>8)fail('INVALID_UPLOAD');
 if(request.operation==='dispatchText'&&!request.text.trim()&&!attachments.length)fail('EMPTY_MESSAGE');
 const expectedContent={content_type:attachments.some(f=>f.mimeType.startsWith('image/'))?'multimodal_text':'text',parts:[
  ...attachments.filter(f=>f.mimeType.startsWith('image/')).map(f=>({asset_pointer:(f.id.startsWith('file_')?'sediment://':'file-service://')+f.id,content_type:'image_asset_pointer',height:f.height,size_bytes:f.size,width:f.width})),request.text]};
 const matchesAttachments=message=>{
  const actual=message.metadata?.attachments??[];
  return actual.length===attachments.length&&attachments.every((f,i)=>actual[i].id===f.id&&actual[i].name===f.name&&actual[i].size===f.size&&actual[i].mime_type===f.mimeType);
 };
 const binding = {conversationId:request.conversationId,accountFingerprint:request.accountFingerprint};
 const creating=request.conversationId===null;
 if ((await read({operation:'inspectAccount'})).accountFingerprint !== request.accountFingerprint) fail('ACCOUNT_MISMATCH');
 const m = await load();
 const lockKey = Symbol.for('codex-web.native-dispatch-lock');
 const stateKey = Symbol.for('codex-web.native-dispatch-state');
 if (runtime[lockKey]) fail('BUSY');
 runtime[lockKey] = true;
 try {
  const signature = JSON.stringify([request.key,request.conversationId,request.userMessageId,request.text,request.model,request.effort,request.accountFingerprint,request.attachments??[],request.projectId??null]);
  const previous = runtime[stateKey];
  if (request.operation === 'inspectDispatch') {
   if (previous?.signature !== signature) fail('DISPATCH_NOT_FOUND');
   return {key:request.key,state:previous.state,userMessageId:request.userMessageId};
  }
  if (request.operation!=='resolveCreation'&&previous?.signature === signature && previous.dispatched) return {key:request.key,state:previous.state,userMessageId:request.userMessageId};
  if (request.operation!=='resolveCreation'&&previous?.dispatched && previous.state === 'running' && previous.conversationId===request.conversationId) fail('BUSY');
  if(request.operation==='resolveCreation'&&!creating)fail('INVALID_REQUEST');
  if(request.projectId)await read({operation:'readProject',projectId:request.projectId,accountFingerprint:request.accountFingerprint});
  const history = creating?{messages:[],currentNode:request.parentId}:await read({operation:'readConversation',...binding});
  if(!creating&&request.projectId!=null&&history.projectId!==request.projectId)fail('PROJECT_MISMATCH');
  if (history.messages.some(x=>x.id===request.userMessageId)) fail('MESSAGE_ALREADY_EXISTS');
  if (request.operation === 'dispatchText' && (!uuid(request.parentId)||request.parentId !== history.currentNode || request.intentPersisted !== true)) fail('BRANCH_CHANGED');
  // Obtain only the native action's route scope. Restore its read handler immediately;
  // never inspect React internals or leave a custom action registered.
  const registry = (await loadActions()).appActionRegistry;
  const original = registry?.get('app.get_summary');
  if (typeof original !== 'function' || typeof m.mDt !== 'function' || typeof m.lDt !== 'function') fail('INCOMPATIBLE');
  let scope;
  const capture = (input,context) => { scope=context?.scope; return original(input,context); };
  registry.set('app.get_summary',capture);
  try { await m.M9.appActions.runInPrimaryWindow({action:{type:'app.get_summary'}}); }
  finally { if(registry.get('app.get_summary')===capture)registry.set('app.get_summary',original); }
  if (!scope?.get) fail('INCOMPATIBLE');
  const info = await m.M9.accessInputs.readAccountInfo();
  if(info?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');
  const principal = info.data;
  const digest = await runtime.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([
   principal?.accountId,principal?.userId,principal?.authenticatedUserId??null,
  ])));
  if (Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('') !== request.accountFingerprint) fail('ACCOUNT_CHANGED');
  // A caller-owned local identity is committed with the Hub receipt before the
  // native creation. It is never mistaken for a confirmed server conversation.
  const id=creating?`local-chatgpt:${request.userMessageId}`:m.eWt(request.conversationId);
  const sameRoute=()=>creating?scope.value.routeKind==='home':scope.value.routeKind==='chatgpt-thread' &&
   (scope.value.conversationId===request.conversationId || scope.get(m.lzt,scope.value.conversationId)===request.conversationId);
  const sameAccount=()=>{const p=scope.get(m.dWt);return p?.accountId===principal.accountId&&p?.userId===principal.userId;};
  if(request.operation==='resolveCreation'){
   if(!sameAccount())fail('ACCOUNT_CHANGED');
   const candidate=scope.get(m.lzt,id)??(previous?.signature===signature?previous.conversationId:null);
   return {conversationId:uuid(candidate)?candidate:null};
  }
  // The completion action receives an explicit canonical parent and selected
  // model/effort. UI hydration, picker defaults and background fetches are not
  // submission requirements. Verify the actual outgoing request below instead.
  if(!sameRoute())fail('SELECTED_CHAT_MISMATCH');
  if(!sameAccount())fail('ACCOUNT_CHANGED');
  if(creating&&(scope.get(m.gzt,id)!=null||scope.get(m.lzt,id)!=null))fail('DISPATCH_CONTEXT_CHANGED');
  if(scope.get(m.Nzt,id)!=='idle')fail('CONVERSATION_BUSY');
  if (scope.get(m.hzt,id)==='tpp'||(creating&&scope.get(m.Tzt,id)!=null)) fail('CHAT_REQUIRED');
  if(request.operation==='prepareDispatch')return {parentId:history.currentNode,model:request.model,effort:request.effort};
  const state={signature,dispatched:true,state:'running',conversationId:request.conversationId};
  // Intent was committed by Hub. From here every exception is an uncertain send.
  runtime[stateKey]=state;
  const nativeService=scope.get(m.CUt);
  let attempts=0;
  const guarded=new Proxy(nativeService,{get(target,key){
   if(key==='createCompletionStreamHandlers')return args=>target.createCompletionStreamHandlers({...args,shouldAttemptResume:()=>false});
   if(key==='startCompletionStream')return args=>{
    const body=args.request;
    const user=body?.messages?.filter(x=>x.author?.role==='user');
    if((creating?body?.conversation_id!=null:body?.conversation_id!==request.conversationId)||
       (creating&&((body?.gizmo_id??null)!==(request.projectId??null)||body?.conversation_origin!=null||body?.conversation_mode!=null||body?.history_and_training_disabled===true))||body?.parent_message_id!==request.parentId||body?.model!==request.model||
       (body?.thinking_effort??null)!==request.effort||user?.length!==1||user[0].id!==request.userMessageId||
       JSON.stringify(user[0].content)!==JSON.stringify(expectedContent)||!matchesAttachments(user[0]))fail('DISPATCH_CONTEXT_CHANGED');
    return Reflect.apply(target.startCompletionStream,guarded,[{...args,
     expectedIdentity:{accountId:principal.accountId,userId:principal.userId},
     assertRequestCurrent:()=>{
      // Also applies to native transport retries. A second POST is never admitted.
      if(attempts++!==0)fail('REPLAY_BLOCKED');
      if(!sameAccount()||!sameRoute())fail('DISPATCH_CONTEXT_CHANGED');
      args.assertRequestCurrent?.();
      runtime[Symbol.for('codex-web.native-history')]?.delete(request.accountFingerprint+':'+request.conversationId);
     },
    }]);
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const boundScope=new Proxy(scope,{get(target,key){
   if(key==='get')return (atom,...args)=>atom===m.CUt?guarded:target.get(atom,...args);
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const messages=m.lDt({attachments,prompt:request.text,systemHints:scope.get(m.UNt,id)});
  messages.message.id=request.userMessageId;
  // Preserve the exact submitted string, including intentional leading/trailing whitespace.
  messages.message.content=expectedContent;
  const startupSignal=AbortSignal.timeout(15000);
  try {
   const result=await m.mDt(boundScope,{conversationId:id,parentMessageId:request.parentId,
    model:request.model,thinkingEffort:request.effort,prompt:request.text,userCompletionMessages:messages,
    systemHints:scope.get(m.UNt,id),startupSignal,requireDispatchAcceptance:true,
    isSubmissionCurrent:()=>sameAccount()&&sameRoute(),
    onCompletion:status=>{state.state=status==='completed'?'finished':'unknown';},
    ...(creating?{projectId:request.projectId??null,conversationOrigin:null,isTemporaryChat:false,onServerThreadIdChange:candidate=>{if(uuid(candidate))state.conversationId=candidate;}}:{}),
   });
   if(creating){if(uuid(result?.serverConversationId))state.conversationId=result.serverConversationId;}
   else if(result?.serverConversationId!==request.conversationId)fail('CONVERSATION_MISMATCH');
  } catch {state.state='unknown';}
  return {key:request.key,state:state.state,userMessageId:request.userMessageId,...(creating?{conversationId:state.conversationId}: {})};
 } finally {runtime[lockKey]=false;}
}
