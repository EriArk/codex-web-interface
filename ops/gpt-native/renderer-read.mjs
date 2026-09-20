// Version-specific, private research adapter. No sends, navigation or generic RPC.
// Keep this function self-contained: it also runs inside the native renderer.
export async function nativeRead(request, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail = code => { throw Error(`NATIVE_${code}`); };
 const projectId = value => typeof value==='string'&&/^g-p-[a-zA-Z0-9-]{1,80}$/.test(value);
 const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
 if (!request || !['inspectAccount', 'readConversation', 'readModels', 'readPins', 'readSubmission','readCatalog','findCreation','readProjects','readProject','readProjectConversations','readConversationGraph'].includes(request.operation)) fail('READ_ONLY');
 if(request.archived!=null&&typeof request.archived!=='boolean')fail('INVALID_REQUEST');
 if(request.operation==='readCatalog'&&(!/^[a-f0-9]{64}$/.test(request.accountFingerprint??'')||!Number.isSafeInteger(request.offset??0)||(request.offset??0)<0||(request.offset??0)>10000))fail('INVALID_REQUEST');
 if(request.operation==='findCreation'&&(!uuid(request.userMessageId)||!uuid(request.parentId)||typeof request.text!=='string'||
   new TextEncoder().encode(request.text).length>32768||!Number.isSafeInteger(request.createdAfter)||request.createdAfter<0||!/^[a-f0-9]{64}$/.test(request.accountFingerprint??'')))fail('INVALID_REQUEST');
 if(request.operation==='readSubmission'&&(!uuid(request.conversationId)||!uuid(request.userMessageId)||!uuid(request.parentId)||
    typeof request.text!=='string'||new TextEncoder().encode(request.text).length>32768||!/^[a-f0-9]{64}$/.test(request.accountFingerprint??'')))fail('INVALID_REQUEST');
 if (request.operation === 'readModels' && !/^[a-f0-9]{64}$/.test(request.accountFingerprint ?? '')) fail('INVALID_REQUEST');
 if (['readConversation','readConversationGraph'].includes(request.operation) && (!uuid(request.conversationId) ||
     !/^[a-f0-9]{64}$/.test(request.accountFingerprint ?? '') ||
     (request.before != null && !uuid(request.before)) ||
     (request.messageId != null && (typeof request.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.messageId) || request.before != null)))) fail('INVALID_REQUEST');
 if (runtime.electronBridge?.getSentryInitOptions?.().appVersion !== '26.915.31945') fail('UNSUPPORTED_BUILD');
 if(['readProject','readProjectConversations'].includes(request.operation)&&!projectId(request.projectId))fail('INVALID_PROJECT');
 if(request.cursor!=null&&(typeof request.cursor!=='string'||request.cursor.length>4000))fail('INVALID_CURSOR');
 if(request.projectId!=null&&!projectId(request.projectId))fail('INVALID_PROJECT');
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
 if(['readProjects','readProject','readProjectConversations'].includes(request.operation)){
  const route=request.operation==='readProjects'?'/gizmos/snorlax/sidebar':request.operation==='readProject'?'/gizmos/{gizmo_id_or_short_url}':'/gizmos/{gizmo_id}/conversations';
  const parameters=request.operation==='readProjects'?{query:{conversations_per_gizmo:5,cursor:request.cursor??null,limit:20,owned_only:false}}:
   request.operation==='readProject'?{path:{gizmo_id_or_short_url:request.projectId},query:{include_file_limits:true}}:
   {path:{gizmo_id:request.projectId},query:{cursor:request.cursor??null,limit:20,owned_only:false}};
  const raw=await bounded(m.kWt.safeGet(route,{parameters,expectedIdentity:before.principal,signal}));
  if((await account()).fingerprint!==before.fingerprint)fail('ACCOUNT_CHANGED');
  const text=(v,max)=>{if(typeof v!=='string'||v.length>max)fail('INVALID_PROJECT');return v;};
  const number=v=>typeof v==='number'?v*1000:Date.parse(v);
  const conversation=(v,p)=>{if(!uuid(v?.id))fail('INVALID_PROJECT');const t=number(v.update_time);if(!Number.isFinite(t)||t<0)fail('INVALID_PROJECT');return {id:v.id,title:text(v.title??'',4096),updatedAt:t,projectId:p};};
  const project=v=>{
   const g=v?.gizmo?.gizmo??v?.gizmo;
   if(!projectId(g?.id))fail('INVALID_PROJECT');
   if(v.files!=null&&!Array.isArray(v.files))fail('INVALID_PROJECT');
   const files=(v.files??[]).map(f=>{const id=text(f.file_id??f.id,150);if(!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(id))fail('INVALID_PROJECT');return {id,name:text(f.name,500),bytes:Number.isSafeInteger(f.size)&&f.size>=0?f.size:null};});
   if(files.length>500)fail('INVALID_PROJECT');
   const conversations=v.conversations?.items??v.conversations??[];
   if(!Array.isArray(conversations)||conversations.length>20)fail('INVALID_PROJECT');
   return {id:g.id,name:text(g.display?.name,500),instructions:text(g.instructions??'',100000),canWrite:g.current_user_permission?.can_write===true,
    emoji:g.display?.emoji==null?null:text(g.display.emoji,128),theme:g.display?.theme==null?null:text(g.display.theme,128),files,conversations:conversations.map(c=>conversation(c,g.id))};
  };
  if(request.operation==='readProject'){const result=project(raw);if(result.id!==request.projectId)fail('PROJECT_MISMATCH');return result;}
  if(!Array.isArray(raw?.items)||raw.items.length>20||(raw.cursor!=null&&(typeof raw.cursor!=='string'||raw.cursor.length>4000)))fail('INVALID_PROJECT');
  return {items:request.operation==='readProjects'?raw.items.map(project):raw.items.map(c=>conversation(c,request.projectId)),cursor:raw.cursor??null};
 }
 if(request.operation==='readPins'){
  if(!/^[a-f0-9]{64}$/.test(request.accountFingerprint??''))fail('INVALID_REQUEST');
  const raw=await bounded(m.kWt.safeGet('/pins',{expectedIdentity:before.principal,signal}));
  if((await account()).fingerprint!==before.fingerprint)fail('ACCOUNT_CHANGED');
  const rows=Array.isArray(raw)?raw:raw?.items;
  if(!Array.isArray(rows)||rows.length>100)fail('INVALID_PINS');
  const items=rows.filter(x=>['project','conversation'].includes(x?.item_type)).map(x=>{
   const item=x.item,g=item?.gizmo?.gizmo??item?.gizmo??item;
   const id=g?.id,title=x.item_type==='project'?g?.display?.name:item?.title;
   if(!(x.item_type==='project'?projectId(id):uuid(id))||typeof title!=='string'||title.length>4096)fail('INVALID_PINS');
   const date=typeof item.update_time==='number'?item.update_time*1000:Date.parse(item.update_time);
   return {id,kind:x.item_type==='project'?'project':'thread',title,updatedAt:Number.isFinite(date)&&date>=0?date:0,projectId:projectId(item.gizmo_id)?item.gizmo_id:null};
  });
  return {items};
 }
 if(request.operation==='readCatalog'||request.operation==='findCreation'){
  const offset=request.operation==='readCatalog'?(request.offset??0):0;
  let result;
  try{result=await bounded(m.kWt.safeGet('/conversations',{parameters:{query:{offset,limit:20,order:'updated',is_archived:request.operation==='readCatalog'&&request.archived===true,hide_snorlax:false}},expectedIdentity:before.principal,signal}));}
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
  const candidates=items.filter(x=>x.createdAt>=request.createdAfter-60000&&x.projectId===(request.projectId??null)&&x.origin===null);
  if(candidates.length>5)return {conversationId:null};
  let found=null;
  for(const candidate of candidates){
   if(signal.aborted)fail('TIMEOUT');
   const proof=await bounded(nativeRead({...request,operation:'readSubmission',conversationId:candidate.id,newChat:request.fork!==true},load,runtime));
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
 // Share canonical history between visible paging and receipt reconciliation.
 // In particular, a rate-limited read must not be repeated by each web poller.
 const cacheKey=Symbol.for('codex-web.native-history'),cache=runtime[cacheKey]??=new Map();
 const key=before.fingerprint+':'+request.conversationId,now=Date.now();
 for(const [k,v] of cache)if(now-v.at>300000)cache.delete(k);
 if(cache.size>=20&&!cache.has(key))cache.delete(cache.keys().next().value);
 let saved=cache.get(key),conversation;
 if(saved?.retryAt>now)fail('RATE_LIMITED');
 if(saved?.value&&now-saved.at<15000)conversation=saved.value;
 else try {
  const principal=before.principal;
  // The default safeGet retries history failures internally; use the pinned,
  // principal-bound native transport once and respect its rate-limit response.
  const {url,headers}=m.kWt.getRequestTarget('/conversation/{conversation_id}',{parameters:{path:{conversation_id:request.conversationId}}});
  const response=await bounded(m.$rn.getInstance().fetch(url,{headers,expectedIdentity:principal,signal,retry:false}));
  if(!response.ok){const status=response.status;await response.body?.cancel();throw {status,responseStatus:status};}
  let bytes=0,text='';const decoder=new TextDecoder();
  for await(const part of response.body){if(signal.aborted)fail('TIMEOUT');bytes+=part.length;if(bytes>16*1024**2)fail('HISTORY_TOO_LARGE');text+=decoder.decode(part,{stream:true});}
  text+=decoder.decode();conversation=JSON.parse(text);
  if((await account()).fingerprint!==before.fingerprint)fail('ACCOUNT_CHANGED');
  cache.set(key,{value:conversation,bytes,at:Date.now(),retryAt:0});
  let total=0;for(const v of cache.values())total+=v.bytes??0;
  for(const [k,v] of cache){if(total<=64*1024**2)break;if(k!==key){cache.delete(k);total-=v.bytes??0;}}
 } catch(e) {
  if(e?.responseStatus===429&&e.status===429){cache.set(key,{at:Date.now(),retryAt:Date.now()+60000});fail('RATE_LIMITED');}
  if(/^NATIVE_[A-Z_]+$/.test(e?.message??''))throw e;
  fail(signal.aborted ? 'TIMEOUT' : 'READ_UNAVAILABLE');
 }
 if ((await account()).fingerprint !== before.fingerprint) fail('ACCOUNT_CHANGED');
 if (conversation?.conversation_id !== request.conversationId) fail('CONVERSATION_MISMATCH');
 const mapping = conversation.mapping;
 if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length > 10000) fail('INVALID_HISTORY');
 // Preserve public branch topology for the existing Hub paging/versions/results code.
 // Hidden nodes retain only edges: their content, metadata and tool payload never cross IPC.
 if(request.operation==='readConversationGraph'){
  const identity=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x);
  const scalar=(x,max)=>typeof x==='string'&&x.length<=max?x:undefined;
  const publicUrl=x=>{try{const u=new URL(x);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.href.length<=8192?u.href:undefined;}catch{return undefined;}};
  const webpage=x=>{const url=publicUrl(x?.url);return url?{url,title:scalar(x.title,500),attribution:scalar(x.attribution,500)}:null;};
  const refs=values=>!Array.isArray(values)?[]:values.slice(0,2000).flatMap(r=>{
   if(!['url','webpage','grouped_webpages'].includes(r?.type)||!scalar(r.matched_text,2000))return [];
   return [{type:r.type,matched_text:r.matched_text,title:scalar(r.title,500),item:webpage(r.item??r),items:[...(Array.isArray(r.items)?r.items:[]),...(Array.isArray(r.fallback_items)?r.fallback_items:[])].slice(0,64).flatMap(v=>[v,...(Array.isArray(v?.supporting_websites)?v.supporting_websites:[])]).map(webpage).filter(Boolean)}];
  });
  const clean={};let size=0;
  for(const [id,node] of Object.entries(mapping)){
   if(!identity(id)||node?.id!==id||(node.parent!=null&&!identity(node.parent)))fail('INVALID_HISTORY');
   const n={id,parent:node.parent??null,children:Array.isArray(node.children)?node.children.filter(identity):[],message:null};
   const m=node.message,role=m?.author?.role,meta=m?.metadata??{},content=m?.content;
   const generated=role==='tool'&&m.channel==='final'&&typeof meta.image_gen_title==='string';
   const publicMessage=(['user','assistant'].includes(role)||generated)&&identity(m?.id)&&meta.is_visually_hidden_from_conversation!==true&&meta.tool_invoking_message!==true&&
    (m.channel==null||['final','commentary'].includes(m.channel))&&(m.recipient==null||m.recipient==='all')&&
    !['thoughts','reasoning','reasoning_recap','tool_call','computer_output'].includes(content?.content_type);
   if(publicMessage){
    const parts=Array.isArray(content?.parts)?content.parts.flatMap(p=>{
     if(typeof p==='string')return generated?[]:[p];
     if(p?.content_type==='image_asset_pointer'&&typeof p.asset_pointer==='string'&&/^(sediment|file-service):\/\/file[-_][a-zA-Z0-9_-]{1,150}$/.test(p.asset_pointer))return [{content_type:'image_asset_pointer',asset_pointer:p.asset_pointer,size_bytes:Number.isSafeInteger(p.size_bytes)?p.size_bytes:0,...(Number.isSafeInteger(p.width)&&p.width>0?{width:p.width}:{}),...(Number.isSafeInteger(p.height)&&p.height>0?{height:p.height}:{})}];
     return [{content_type:/audio/.test(p?.content_type)?'audio':/video/.test(p?.content_type)?'video':/canvas|widget|interactive/.test(p?.content_type)?'interactive':'other'}];
    }):[];
    const attachments=Array.isArray(meta.attachments)?meta.attachments.slice(0,100).flatMap(f=>/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(f?.id??'')?[{id:f.id,name:scalar(f.name,500)??'File',mime_type:scalar(f.mime_type,150)??'application/octet-stream',size:Number.isSafeInteger(f.size)&&f.size>=0?f.size:0}]:[]):[];
    n.message={id:m.id,author:{role:generated?'assistant':role},channel:m.channel??'final',recipient:'all',content:{content_type:scalar(content?.content_type,100)??'other',parts},
     create_time:Number.isFinite(m.create_time)&&m.create_time>=0?m.create_time:0,status:m.status==='finished_successfully'?'finished_successfully':'in_progress',end_turn:m.end_turn===true,
     metadata:{attachments,content_references:refs(meta.content_references),model_slug:scalar(meta.model_slug,128),thinking_effort:scalar(meta.thinking_effort,128),is_complete:meta.is_complete===true||(m.end_turn===true&&m.status==='finished_successfully')}};
   }
   size+=new TextEncoder().encode(JSON.stringify(n)).length;if(size>1500000)fail('HISTORY_TOO_LARGE');
   clean[id]=n;
  }
  if(!identity(conversation.current_node)||!clean[conversation.current_node])fail('INVALID_HISTORY');
  return {conversation_id:request.conversationId,current_node:conversation.current_node,mapping:clean,title:scalar(conversation.title,4096)??'',gizmo_id:projectId(conversation.gizmo_id)?conversation.gizmo_id:null};
 }
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
// Keep receipt text aligned with canonical Hub history (gpt-links.ts).
 const record = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
 const text = v => typeof v === 'string' ? v : '';
 const rows = v => Array.isArray(v) ? v : [];
function publicUrl(value) {
  const raw = text(value);
  if (
    !/^https?:\/\//i.test(raw) ||
    raw.length > 8192 ||
    [...raw].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    return;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return;
    return url.href;
  } catch {
    return;
  }
}
function link(value, label, source) {
  const url = publicUrl(value);
  if (!url) return "";
  // Encode Markdown syntax, keeping labels literal and destinations out of HTML.
  const title = (text(label).trim() || new URL(url).hostname)
    .slice(0, 400)
    .replace(/./gs, (c) => (c.charCodeAt(0) < 32 ? " " : c))
    .replace(/[\ue200-\ue203]/g, " ")
    .replace(/[\\\x60*_[\]<>!]/g, "\\$&");
  const destination = url.replace(
    /[<>"\\]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return "[" + title + "](<" + destination + ">" + (source ? ' "Источник"' : "") + ")";
}

/** Resolve public native reference markers before discarding unsupported UI tokens. */
function gptLinkedText(body, metadata) {
  const references = new Map();
  for (const value of rows(record(metadata).content_references).slice(0, 2000)) {
    const ref = record(value),
      match = text(ref.matched_text);
    if (/^\ue200[^\ue201]*\ue201$/.test(match)) references.set(match, ref);
  }
  return body.replace(/\ue200([^\ue201]*)\ue201/g, (match, inner) => {
    const ref = references.get(match);
    if (ref?.type === "url") {
      const item = record(ref.item);
      return link(item.url, ref.title || item.title, false);
    }
    if (ref?.type === "grouped_webpages" || ref?.type === "webpage") {
      const items =
        ref.type === "webpage"
          ? [ref.item ?? ref]
          : [...rows(ref.items), ...rows(ref.fallback_items)];
      const seen = new Set();
      const links = [];
      for (const value of items
        .flatMap((v) => [v, ...rows(record(v).supporting_websites)])
        .slice(0, 64)) {
        const item = record(value),
          url = publicUrl(item.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        links.push(link(url, item.attribution || item.title, true));
      }
      return links.join(" ");
    }
    // During streaming, a direct URL can precede its metadata. Never guess search IDs.
    const parts = inner.split("\ue202");
    if (!ref && parts[0] === "url" && parts.length === 3) return link(parts[2], parts[1], false);
    return "";
  });
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
  const text = role === 'assistant' ? gptLinkedText(parts.join('\n'), message.metadata) : parts.join('\n');
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
  ...(conversation.gizmo_id?{projectId:conversation.gizmo_id}:{}),messages:messages.reverse(), before:hasMore ? messages[0].nodeId : null, mediaResolved:false};
 if(request.operation==='readSubmission'){
  const index=chain.findIndex(n=>n.message?.id===request.userMessageId);
  const node=chain[index];
  if(index<0)return {state:'unknown',messages:[]};
  const attachments=(request.attachments??[]).map(f=>f.native);
  const expectedContent={content_type:attachments.some(f=>f.mimeType.startsWith('image/'))?'multimodal_text':'text',parts:[
   ...attachments.filter(f=>f.mimeType.startsWith('image/')).map(f=>({asset_pointer:(f.id.startsWith('file_')?'sediment://':'file-service://')+f.id,content_type:'image_asset_pointer',height:f.height,size_bytes:f.size,width:f.width})),request.text]};
  const actual=node.message.metadata?.attachments??[];
  if(actual.length!==attachments.length||attachments.some((f,i)=>actual[i].id!==f.id||actual[i].name!==f.name||actual[i].size!==f.size||actual[i].mime_type!==f.mimeType))fail('SUBMISSION_MISMATCH');
  const content=node.message.content;
  const sameContent=content?.content_type===expectedContent.content_type&&Array.isArray(content.parts)&&content.parts.length===expectedContent.parts.length&&
   expectedContent.parts.every((p,i)=>typeof p==='string'?content.parts[i]===p:
    content.parts[i]&&Object.keys(p).every(k=>content.parts[i][k]===p[k]));
  if(chain.filter(n=>n.message?.id===request.userMessageId).length!==1||node.parent!==request.parentId||node.message.author?.role!=='user'||
     !sameContent||
     node.message.metadata?.is_visually_hidden_from_conversation===true)fail('SUBMISSION_MISMATCH');
  if(request.newChat===true&&(chain.slice(index+1).some(n=>n.message?.author?.role==='user')||(conversation.gizmo_id??null)!==(request.projectId??null)||conversation.conversation_origin==='tpp'))fail('SUBMISSION_MISMATCH');
  // Receipt identity is checked against the bounded canonical branch, not its
  // latest UI page: long-running turns can have far more than 20 public updates.
  const later=chain.slice(0,index);
  if(later.some(n=>n.message?.author?.role==='user'))return {state:'unknown',messages:[]};
  const ids=new Set(later.map(n=>n.message?.id));
  const visible=page.messages.filter(m=>ids.has(m.id)&&m.role==='assistant');
  const latest=visible.at(-1);
  const finished=latest?.nodeId===conversation.current_node&&latest?.complete&&latest.channel==='final'&&
   later.some(n=>n.message?.id===latest.id&&n.message.end_turn===true);
  return {state:finished?'completed':'running',messages:visible};
 }
 return page;
}
