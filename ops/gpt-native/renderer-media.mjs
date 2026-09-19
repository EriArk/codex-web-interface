// Account-bound streamed downloads. Only native file identities cross the pipe;
// upstream URLs, authentication and response streams remain inside the renderer.
export async function nativeMedia(r, read, artifacts, load=()=>import('app://-/assets/app-initial-430deae5a13a.js'), runtime=globalThis) {
 const fail=c=>{throw Error('NATIVE_'+c);};
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
 const fileId=x=>typeof x==='string'&&/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(x);
 if(!['openMedia','readMedia','closeMedia'].includes(r.operation)||!uuid(r.transferId))fail('INVALID_REQUEST');
 const key=Symbol.for('codex-web.native-media'), streams=runtime[key]??=new Map();
 const drop=id=>{const s=streams.get(id);if(s){streams.delete(id);clearTimeout(s.timer);s.controller.abort();void s.reader.cancel().catch(()=>{});}};
 for(const [id,s] of streams)if(Date.now()-s.touched>60000)drop(id);
 const account=async()=>{if((await read({operation:'inspectAccount'},load,runtime)).accountFingerprint!==r.accountFingerprint){for(const [id,s] of streams)if(s.account===r.accountFingerprint)drop(id);fail('ACCOUNT_CHANGED');}};
 await account();
 if(r.operation!=='openMedia'){
  const s=streams.get(r.transferId);if(!s&&r.operation==='closeMedia')return {closed:true};if(!s||s.account!==r.accountFingerprint)fail('TRANSFER_MISSING');
  if(r.operation==='closeMedia'){streams.delete(r.transferId);clearTimeout(s.timer);s.controller.abort();await s.reader.cancel().catch(()=>{});return {closed:true};}
  try{
  if(r.offset!==s.offset)fail('TRANSFER_OFFSET');
  s.touched=Date.now();
  const next=s.pending?.length?{value:s.pending,done:false}:await s.reader.read();
  const bytes=next.value?.subarray(0,262144)??new Uint8Array();
  s.pending=next.value?.subarray(bytes.length);s.offset+=bytes.length;
  if(s.offset>512*1024**2||(s.length!==null&&s.offset>s.length))fail('ASSET_TOO_LARGE');
  await account();
  if(next.done&&s.length!==null&&s.offset!==s.length)fail('ASSET_TRUNCATED');
  const digest=await runtime.crypto.subtle.digest('SHA-256',bytes);
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  if(next.done){clearTimeout(s.timer);streams.delete(r.transferId);await s.reader.cancel().catch(()=>{});}
  return {offset:s.offset,done:next.done,base64:runtime.btoa(binary),sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
  }catch(e){drop(r.transferId);throw e;}
 }
 if(streams.has(r.transferId)||streams.size>=2)fail('BUSY');
 let file, route, parameters;
 if(r.projectId!=null){
  if(!fileId(r.fileId))fail('INVALID_REQUEST');
  const p=await read({operation:'readProject',projectId:r.projectId,accountFingerprint:r.accountFingerprint},load,runtime);
  const f=p.files.find(f=>f.id===r.fileId);if(!f)fail('ARTIFACT_NOT_ON_BRANCH');
  file={id:f.id,name:f.name,mime:'application/octet-stream',image:false};
  route='/files/download/{file_id}';parameters={path:{file_id:f.id},query:{gizmo_id:p.id,download_intent:'download'}};
 }else{
  if(!uuid(r.conversationId)||typeof r.messageId!=='string')fail('INVALID_REQUEST');
  if(/^sandbox-[a-f0-9]{64}$/.test(r.fileId??'')){
   const found=await artifacts({operation:'listArtifacts',conversationId:r.conversationId,messageId:r.messageId,accountFingerprint:r.accountFingerprint},read,load,runtime);
   file=found.artifacts.find(f=>f.id===r.fileId&&f.messageId===r.messageId);
   if(!file)fail('ARTIFACT_NOT_ON_BRANCH');
   route='/conversation/{conversation_id}/interpreter/download';parameters={path:{conversation_id:r.conversationId},query:{message_id:r.messageId,sandbox_path:file.path}};
  }else{
   if(!fileId(r.fileId))fail('INVALID_REQUEST');
   const graph=await read({operation:'readConversationGraph',conversationId:r.conversationId,accountFingerprint:r.accountFingerprint},load,runtime);
   let id=graph.current_node,m=null;const seen=new Set();
   while(id&&!seen.has(id)){seen.add(id);const n=graph.mapping[id];if(n?.message?.id===r.messageId){m=n.message;break;}id=n?.parent;}
   if(!m)fail('ARTIFACT_NOT_ON_BRANCH');
   const a=m.metadata?.attachments?.find(f=>f.id===r.fileId),p=m.content?.parts?.find(p=>typeof p==='object'&&p?.asset_pointer?.replace(/^(sediment|file-service):\/\//,'')===r.fileId);
   if(!a&&!p)fail('ARTIFACT_NOT_ON_BRANCH');
   file={id:r.fileId,name:a?.name??'Image.png',mime:a?.mime_type??'image/png',image:(a?.mime_type??'image/png').startsWith('image/')};
   route='/files/download/{file_id}';parameters={path:{file_id:r.fileId},query:{conversation_id:r.conversationId,check_context_scopes_for_conversation_id:r.conversationId,inline:'false'}};
  }
 }
 const m=await load(),controller=new AbortController(),timer=setTimeout(()=>{controller.abort();drop(r.transferId);},15*60000);
 try{
  const identity=await m.M9.accessInputs.readAccountInfo();if(identity?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');
  const principal={accountId:identity.data.accountId,userId:identity.data.userId};await account();
  const resolved=await m.kWt.safeGet(route,{parameters,expectedIdentity:principal,signal:controller.signal});await account();
  const url=new URL(resolved.download_url);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)fail('UNSAFE_ASSET_URL');
  const native=url.hostname==='chatgpt.com'&&(url.pathname==='/backend-api/estuary/content'||/^\/backend-api\/files\/library\/files\/[^/]+\/(content_redirect|download_redirect|project_content)$/.test(url.pathname));
  if(!native&&!(url.hostname==='files.oaiusercontent.com'||url.hostname.endsWith('.oaiusercontent.com')))fail('UNSAFE_ASSET_URL');
  const response=await(native?m.$rn.getInstance().fetch(url.href,{headers:{'X-OpenAI-Attach-Auth':'1'},expectedIdentity:principal,signal:controller.signal}):runtime.fetch(url.href,{credentials:'omit',redirect:'error',signal:controller.signal,referrerPolicy:'no-referrer'}));
  if(!response.ok||!response.body)fail('ASSET_UNAVAILABLE');
  const raw=response.headers.get('content-length'),length=raw===null?null:Number(raw);
  if(length!==null&&(!Number.isSafeInteger(length)||length<1||length>512*1024**2))fail('ASSET_TOO_LARGE');
  await account();
  const mime=response.headers.get('content-type')?.split(';')[0]??file.mime;
  file={id:file.id,name:file.name,mime:/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)?mime:'application/octet-stream',image:/^image\/(png|jpeg|gif|webp|avif)$/.test(mime)};
  streams.set(r.transferId,{reader:response.body.getReader(),controller,account:r.accountFingerprint,offset:0,length,touched:Date.now(),timer});
  return {file,bytes:length};
 }catch(e){clearTimeout(timer);controller.abort();throw e;}
}
