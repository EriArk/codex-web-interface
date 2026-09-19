// Pinned native consumer-Chat send canary. No credentials, HTTP bodies or raw events leave the renderer.
export async function nativeDispatch(request, read, control,
 load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis,
 loadActions = () => import('app://-/assets/register-app-actions-a2e5974b9821.js')) {
 const fail = code => { throw Error(`NATIVE_${code}`); };
 const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
 if (!['prepareDispatch','dispatchText','inspectDispatch'].includes(request.operation) ||
     !uuid(request.conversationId) || !uuid(request.key) || !uuid(request.userMessageId) ||
     typeof request.text !== 'string' || !request.text.trim() || new TextEncoder().encode(request.text).length > 32768 ||
     typeof request.model !== 'string' || request.model.length > 128 ||
     (request.effort !== null && (typeof request.effort !== 'string' || request.effort.length > 128))) fail('INVALID_REQUEST');
 const binding = {conversationId:request.conversationId,accountFingerprint:request.accountFingerprint};
 if ((await read({operation:'inspectAccount'})).accountFingerprint !== request.accountFingerprint) fail('ACCOUNT_MISMATCH');
 const m = await load();
 const lockKey = Symbol.for('codex-web.native-dispatch-lock');
 const stateKey = Symbol.for('codex-web.native-dispatch-state');
 if (runtime[lockKey]) fail('BUSY');
 runtime[lockKey] = true;
 try {
  const signature = JSON.stringify([request.key,request.conversationId,request.userMessageId,request.text,request.model,request.effort,request.accountFingerprint]);
  const previous = runtime[stateKey];
  if (request.operation === 'inspectDispatch') {
   if (previous?.signature !== signature) fail('DISPATCH_NOT_FOUND');
   return {key:request.key,state:previous.state,userMessageId:request.userMessageId};
  }
  if (previous?.signature === signature && previous.dispatched) return {key:request.key,state:previous.state,userMessageId:request.userMessageId};
  if (previous?.dispatched && previous.state === 'running') fail('BUSY');
  const ui = await control({operation:'inspectConversation',...binding},read,load,runtime);
  if (!ui.selected || !ui.composerReady || ui.hasDraft || ui.stopAvailable) fail('NOT_READY');
  const history = await read({operation:'readConversation',...binding});
  if (history.messages.some(x=>x.id===request.userMessageId)) fail('MESSAGE_ALREADY_EXISTS');
  if (request.operation === 'dispatchText' && (request.parentId !== history.currentNode || request.intentPersisted !== true)) fail('BRANCH_CHANGED');
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
  const id=m.eWt(request.conversationId);
  const sameRoute=()=>scope.value.routeKind==='chatgpt-thread' &&
   (scope.value.conversationId===request.conversationId || scope.get(m.lzt,scope.value.conversationId)===request.conversationId);
  const sameAccount=()=>{const p=scope.get(m.dWt);return p?.accountId===principal.accountId&&p?.userId===principal.userId;};
  const selected=scope.get(m.VNt,id);
  if(!sameRoute()||!sameAccount()||scope.get(m.gzt,id)!==history.currentNode||
     scope.get(m.Nzt,id)!=='idle'||scope.get(m.NNt,id)||scope.get(m.Pzt,id)||
     selected?.slug!==request.model||(selected?.thinkingEffort??null)!==request.effort) fail('DISPATCH_CONTEXT_CHANGED');
  if (scope.get(m.hzt,id)==='tpp') fail('CHAT_REQUIRED');
  if(request.operation==='prepareDispatch')return {parentId:history.currentNode,model:request.model,effort:request.effort};
  const state={signature,dispatched:true,state:'running'};
  // Intent was committed by Hub. From here every exception is an uncertain send.
  runtime[stateKey]=state;
  const nativeService=scope.get(m.CUt);
  let attempts=0;
  const guarded=new Proxy(nativeService,{get(target,key){
   if(key==='createCompletionStreamHandlers')return args=>target.createCompletionStreamHandlers({...args,shouldAttemptResume:()=>false});
   if(key==='startCompletionStream')return args=>{
    const body=args.request;
    const user=body?.messages?.filter(x=>x.author?.role==='user');
    if(body?.conversation_id!==request.conversationId||body?.parent_message_id!==request.parentId||body?.model!==request.model||
       (body?.thinking_effort??null)!==request.effort||user?.length!==1||user[0].id!==request.userMessageId||
       JSON.stringify(user[0].content)!==JSON.stringify({content_type:'text',parts:[request.text]}))fail('DISPATCH_CONTEXT_CHANGED');
    return Reflect.apply(target.startCompletionStream,guarded,[{...args,
     expectedIdentity:{accountId:principal.accountId,userId:principal.userId},
     assertRequestCurrent:()=>{
      // Also applies to native transport retries. A second POST is never admitted.
      if(attempts++!==0)fail('REPLAY_BLOCKED');
      if(!sameAccount()||!sameRoute())fail('DISPATCH_CONTEXT_CHANGED');
      args.assertRequestCurrent?.();
     },
    }]);
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const boundScope=new Proxy(scope,{get(target,key){
   if(key==='get')return (atom,...args)=>atom===m.CUt?guarded:target.get(atom,...args);
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const messages=m.lDt({prompt:request.text,systemHints:scope.get(m.UNt,id)});
  messages.message.id=request.userMessageId;
  // Preserve the exact submitted string, including intentional leading/trailing whitespace.
  messages.message.content={content_type:'text',parts:[request.text]};
  const startupSignal=AbortSignal.timeout(15000);
  try {
   const result=await m.mDt(boundScope,{conversationId:id,parentMessageId:request.parentId,
    model:request.model,thinkingEffort:request.effort,prompt:request.text,userCompletionMessages:messages,
    systemHints:scope.get(m.UNt,id),startupSignal,requireDispatchAcceptance:true,
    isSubmissionCurrent:()=>sameAccount()&&sameRoute(),
    onCompletion:status=>{state.state=status==='completed'?'finished':'unknown';},
   });
   if(result?.serverConversationId!==request.conversationId)fail('CONVERSATION_MISMATCH');
  } catch {state.state='unknown';}
  return {key:request.key,state:state.state,userMessageId:request.userMessageId};
 } finally {runtime[lockKey]=false;}
}
