// Version-specific, private research adapter. No sends, navigation or generic RPC.
// Keep this function self-contained: it also runs inside the native renderer.
export async function nativeRead(request, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail = code => { throw Error(`NATIVE_${code}`); };
 const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
 if (!request || !['inspectAccount', 'readConversation', 'readModels'].includes(request.operation)) fail('READ_ONLY');
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
 return {conversationId:request.conversationId, currentNode:conversation.current_node,
  messages:messages.reverse(), before:hasMore ? messages[0].nodeId : null, mediaResolved:false};
}
