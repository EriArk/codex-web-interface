// Version-specific, private research adapter. No sends, navigation or generic RPC.
// Keep this function self-contained: it also runs inside the native renderer.
export async function nativeRead(request, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail = code => { throw Error(`NATIVE_${code}`); };
 const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
 if (!request || !['inspectAccount', 'readConversation', 'readModels', 'readSubmission','readCatalog','findCreation'].includes(request.operation)) fail('READ_ONLY');
 if(request.operation==='readCatalog'&&(!/^[a-f0-9]{64}$/.test(request.accountFingerprint??'')||!Number.isSafeInteger(request.offset??0)||(request.offset??0)<0||(request.offset??0)>10000))fail('INVALID_REQUEST');
 if(request.operation==='findCreation'&&(!uuid(request.userMessageId)||!uuid(request.parentId)||typeof request.text!=='string'||
   new TextEncoder().encode(request.text).length>32768||!Number.isSafeInteger(request.createdAfter)||request.createdAfter<0||!/^[a-f0-9]{64}$/.test(request.accountFingerprint??'')))fail('INVALID_REQUEST');
 if(request.operation==='readSubmission'&&(!uuid(request.conversationId)||!uuid(request.userMessageId)||!uuid(request.parentId)||
    typeof request.text!=='string'||new TextEncoder().encode(request.text).length>32768||!/^[a-f0-9]{64}$/.test(request.accountFingerprint??'')))fail('INVALID_REQUEST');
 if (request.operation === 'readModels' && !/^[a-f0-9]{64}$/.test(request.accountFingerprint ?? '')) fail('INVALID_REQUEST');
 if (request.operation === 'readConversation' && (!uuid(request.conversationId) ||
     !/^[a-f0-9]{64}$/.test(request.accountFingerprint ?? '') ||
     (request.before != null && !uuid(request.before)) ||
     (request.messageId != null && (typeof request.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.messageId) || request.before != null)))) fail('INVALID_REQUEST');
 if (runtime.electronBridge?.getSentryInitOptions?.().appVersion !== '26.915.31945') fail('UNSUPPORTED_BUILD');
 const signal = AbortSignal.timeout(15000);
 const bounded = promise => new Promise((resolve, reject) => {
  const abort = () => reject(Error('NATIVE_TIMEOUT'));
  signal.addEventListener('abort', abort, {once:true});
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  if (signal.aborted) abort();
 });
 const m = await bounded(load());
 if (typeof m.kWt?.safeGet !== 'function' || !m.M9?.accessInputs) fail('INCOMPATIBLE');
 const account = async () => {
  const result = await bounded(m.M9.accessInputs.readAccountInfo());
  if (result?.status !== 'ready') fail('ACCOUNT_UNAVAILABLE');
  const {accountId, userId, authenticatedUserId} = result.data ?? {};
  if (![accountId, userId].every(v => typeof v === 'string' && v.length > 0 && v.length < 256)) fail('ACCOUNT_UNAVAILABLE');
  const digest = await runtime.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([accountId, userId, authenticatedUserId ?? null])));
  return {principal:{accountId,userId}, fingerprint:Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('')};
 };
 const before = await account();
 // Inspection proposes a binding; the caller must explicitly persist/approve it.
 if (request.operation === 'inspectAccount') return {build:'26.915.31945', accountFingerprint:before.fingerprint, writesEnabled:false};
 if (before.fingerprint !== request.accountFingerprint) fail('ACCOUNT_MISMATCH');
 if(request.operation==='readCatalog'||request.operation==='findCreation'){
  const offset=request.operation==='readCatalog'?(request.offset??0):0;
  let result;
  try{result=await bounded(m.kWt.safeGet('/conversations',{parameters:{query:{offset,limit:20,order:'updated',is_archived:false,hide_snorlax:false}},expectedIdentity:before.principal,signal}));}
  catch{fail(signal.aborted?'TIMEOUT':'READ_UNAVAILABLE');}
  if((await account()).fingerprint!==before.fingerprint)fail('ACCOUNT_CHANGED');
  if(!Array.isArray(result?.items)||result.items.length>20)fail('INVALID_CATALOG');
  const time=x=>{const ms=typeof x==='string'?Date.parse(x):NaN;if(!Number.isFinite(ms)||ms<0)fail('INVALID_CATALOG');return ms;};
  const items=result.items.map(x=>{
   if(!uuid(x?.id)||typeof x.title!=='string'||x.title.length>4096||
      x.gizmo_id!=null&&(typeof x.gizmo_id!=='string'||x.gizmo_id.length>128)||
      x.conversation_origin!=null&&(typeof x.conversation_origin!=='string'||x.conversation_origin.length>128))fail('INVALID_CATALOG');
   return {id:x.id,title:x.title,createdAt:time(x.create_time),updatedAt:time(x.update_time),projectId:x.gizmo_id??null,origin:x.conversation_origin??null};
  });
  if(new Set(items.map(x=>x.id)).size!==items.length)fail('INVALID_CATALOG');
  if(request.operation==='readCatalog')return {items,nextOffset:items.length===20?offset+20:null};
  // Recovery is read-only and bounded. Never identify a new chat by title/text
  // alone, and never crawl the owner's entire history after a lost creation ID.
  const candidates=items.filter(x=>x.createdAt>=request.createdAfter-60000&&x.projectId===null&&x.origin===null);
  if(candidates.length>5)return {conversationId:null};
  let found=null;
  for(const candidate of candidates){
   if(signal.aborted)fail('TIMEOUT');
   const proof=await bounded(nativeRead({...request,operation:'readSubmission',conversationId:candidate.id,newChat:true},load,runtime));
   if(proof.state!=='unknown'){
    if(found!==null)fail('CREATION_AMBIGUOUS');
    found=candidate.id;
   }
  }
  if((await account()).fingerprint!==before.fingerprint)fail('ACCOUNT_CHANGED');
  return {conversationId:found};
 }
 if (request.operation === 'readModels') {
  let catalog;
  try { catalog = await bounded(m.kWt.safeGet('/models', {
   parameters:{query:{iim:false,include_icons:false}}, expectedIdentity:before.principal, signal,
  })); } catch { fail(signal.aborted ? 'TIMEOUT' : 'READ_UNAVAILABLE'); }
  if ((await account()).fingerprint !== before.fingerprint) fail('ACCOUNT_CHANGED');
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (!Array.isArray(catalog?.versions) || !catalog.versions.length || catalog.versions.length > 32) fail('INVALID_MODELS');
  const versions = catalog.versions.map(v => {
   if (!text(v.id) || !text(v.display_text_for_intelligence) || typeof v.enabled !== 'boolean' ||
       !Array.isArray(v.intelligence_presets) || !v.intelligence_presets.length || v.intelligence_presets.length > 16) fail('INVALID_MODELS');
   const presets = v.intelligence_presets.map(p => {
    if (!Number.isSafeInteger(p.id) || p.id < 0 || !text(p.title) || !text(p.model_slug) ||
        (p.thinking_effort != null && !text(p.thinking_effort)) || !['available','locked'].includes(p.preset_type)) fail('INVALID_MODELS');
    return {id:p.id,label:p.title,model:p.model_slug,effort:p.thinking_effort ?? null,available:p.preset_type === 'available'};
   });
   if (new Set(presets.map(p=>p.id)).size !== presets.length) fail('INVALID_MODELS');
   return {id:v.id,label:v.display_text_for_intelligence,enabled:v.enabled,presets};
  });
  if (new Set(versions.map(v=>v.id)).size !== versions.length || new Set(versions.map(v=>v.label)).size !== versions.length) fail('INVALID_MODELS');
  return {versions};
 }
 let conversation;
 try {
  // Do not pass retry:false: this build's alternate request path drops expectedIdentity.
  conversation = await bounded(m.kWt.safeGet('/conversation/{conversation_id}', {
   parameters:{path:{conversation_id:request.conversationId}},
   expectedIdentity:before.principal, signal,
  }));
 } catch { fail(signal.aborted ? 'TIMEOUT' : 'READ_UNAVAILABLE'); }
 if ((await account()).fingerprint !== before.fingerprint) fail('ACCOUNT_CHANGED');
 if (conversation?.conversation_id !== request.conversationId) fail('CONVERSATION_MISMATCH');
 const mapping = conversation.mapping;
 if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length > 10000) fail('INVALID_HISTORY');
 const chain = [], seen = new Set();
 let id = conversation.current_node;
 if (typeof id !== 'string') fail('INVALID_HISTORY');
 while (id != null) {
  if (typeof id !== 'string' || seen.has(id) || !Object.hasOwn(mapping, id)) fail('INVALID_HISTORY');
  const node = mapping[id];
  if (!node || node.id !== id || (node.parent != null && typeof node.parent !== 'string')) fail('INVALID_HISTORY');
  seen.add(id); chain.push(node); id = node.parent;
 }
 let start = 0;
 if (request.before != null) {
  start = chain.findIndex(n => n.id === request.before);
  if (start < 0) fail('CURSOR_NOT_ON_BRANCH');
  start++;
 }
 const messages = [];
 let hasMore = false, bytes = 0;
 const selected=request.messageId == null ? chain.slice(start) : chain.filter(n=>n.message?.id===request.messageId);
 if(request.messageId != null && selected.length!==1)fail('MESSAGE_NOT_ON_BRANCH');
 for (const node of selected) {
  const message = node.message, role = message?.author?.role;
  if (!['user','assistant'].includes(role) || message.metadata?.is_visually_hidden_from_conversation === true ||
      (message.channel != null && !['final','commentary'].includes(message.channel)) ||
      (message.recipient != null && message.recipient !== 'all')) continue;
  const content = message.content;
  if (typeof message.id !== 'string' || !content || !Array.isArray(content.parts)) continue;
  // Unknown structured content is not stringified. Media resolution is a later gate.
  const parts = ['text','multimodal_text'].includes(content.content_type) ? content.parts.filter(p => typeof p === 'string') : [];
  const text = parts.join('\n');
  const hasAttachments = content.parts.some(p => typeof p !== 'string') || !!message.metadata?.attachments?.length;
  if (!text && !hasAttachments) continue;
  if (messages.length === 20) { hasMore = true; break; }
  bytes += new TextEncoder().encode(text).length;
  if (bytes > 1024 * 1024) fail('HISTORY_TOO_LARGE');
  messages.push({nodeId:node.id, id:message.id, role, channel:message.channel ?? 'final', text, hasAttachments,
   createdAt:typeof message.create_time==='number'&&Number.isFinite(message.create_time)&&message.create_time>=0 ? message.create_time : 0,
   model:typeof message.metadata?.model_slug === 'string' && message.metadata.model_slug.length <= 128 ? message.metadata.model_slug : null,
   effort:typeof message.metadata?.thinking_effort === 'string' && message.metadata.thinking_effort.length <= 128 ? message.metadata.thinking_effort : null,
   complete:message.status === 'finished_successfully'});
 }
 const page={conversationId:request.conversationId, currentNode:conversation.current_node,
  messages:messages.reverse(), before:hasMore ? messages[0].nodeId : null, mediaResolved:false};
 if(request.operation==='readSubmission'){
  const index=chain.findIndex(n=>n.message?.id===request.userMessageId);
  const node=chain[index];
  if(index<0)return {state:'unknown',messages:[]};
  const attachments=(request.attachments??[]).map(f=>f.native);
  const expectedContent={content_type:attachments.some(f=>f.mimeType==='image/png')?'multimodal_text':'text',parts:[
   ...attachments.filter(f=>f.mimeType==='image/png').map(f=>({asset_pointer:(f.id.startsWith('file_')?'sediment://':'file-service://')+f.id,content_type:'image_asset_pointer',height:f.height,size_bytes:f.size,width:f.width})),request.text]};
  const actual=node.message.metadata?.attachments??[];
  if(actual.length!==attachments.length||attachments.some((f,i)=>actual[i].id!==f.id||actual[i].name!==f.name||actual[i].size!==f.size||actual[i].mime_type!==f.mimeType))fail('SUBMISSION_MISMATCH');
  const content=node.message.content;
  const sameContent=content?.content_type===expectedContent.content_type&&Array.isArray(content.parts)&&content.parts.length===expectedContent.parts.length&&
   expectedContent.parts.every((p,i)=>typeof p==='string'?content.parts[i]===p:
    content.parts[i]&&Object.keys(p).every(k=>content.parts[i][k]===p[k]));
  if(chain.filter(n=>n.message?.id===request.userMessageId).length!==1||node.parent!==request.parentId||node.message.author?.role!=='user'||
     !sameContent||
     node.message.metadata?.is_visually_hidden_from_conversation===true)fail('SUBMISSION_MISMATCH');
  if(request.newChat===true&&(chain.slice(index+1).some(n=>n.message?.author?.role==='user')||conversation.gizmo_id!=null||conversation.conversation_origin==='tpp'))fail('SUBMISSION_MISMATCH');
  // A later user turn or more than one public page is not guessed into this receipt.
  const later=chain.slice(0,index);
  if(later.some(n=>n.message?.author?.role==='user')||!page.messages.some(m=>m.id===request.userMessageId))return {state:'unknown',messages:[]};
  const ids=new Set(later.map(n=>n.message?.id));
  const visible=page.messages.filter(m=>ids.has(m.id)&&m.role==='assistant');
  const latest=visible.at(-1);
  const finished=latest?.nodeId===conversation.current_node&&latest?.complete&&latest.channel==='final'&&
   later.some(n=>n.message?.id===latest.id&&n.message.end_turn===true);
  return {state:finished?'completed':'running',messages:visible};
 }
 return page;
}
