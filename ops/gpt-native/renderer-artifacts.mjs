// Native public sandbox results only. Signed URLs and native account data never
// leave this renderer function. Generated image-service pointers remain separate.
export async function nativeArtifacts(request, read, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail=code=>{throw Error(`NATIVE_${code}`);};
 if(!['listArtifacts','readArtifact'].includes(request?.operation))fail('UNSUPPORTED_CONTROL');
 if(request.operation==='readArtifact'&&(!/^sandbox-[a-f0-9]{64}$/.test(request.artifactId??'')||typeof request.messageId!=='string'))fail('INVALID_REQUEST');
 const digest=async bytes=>Array.from(new Uint8Array(await runtime.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const history=await read({operation:'readConversation',conversationId:request.conversationId,accountFingerprint:request.accountFingerprint,
  ...(request.operation==='readArtifact'?{messageId:request.messageId}:{before:request.before})},load,runtime);
 const artifacts=[];
 const mimeTypes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',pdf:'application/pdf',zip:'application/zip',html:'text/html'};
 for(const message of history.messages){
  if(message.role!=='assistant')continue;
  const paths=new Set();let fence='';
  for(const line of message.text.split(/(?<=\n)/)){
   const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
   if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence='';continue;}
   if(fence)continue;
   const regex=/(`+).*?\1|(\]\(\s*)(?:<sandbox:([^>\r\n]+)>|sandbox:([^\s)]+))(\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
   for(const match of line.matchAll(regex)){
    if(match[1])continue;
    let path;try{path=decodeURIComponent(match[3]??match[4]);}catch{continue;}
    if(!path.startsWith('/mnt/data/')||path.length>2048||/[\\?#%\x00-\x1f\x7f]/.test(path)||path.slice(1).split('/').some(p=>!p||p==='.'||p==='..'))continue;
    paths.add(path);if(paths.size>32)fail('TOO_MANY_ARTIFACTS');
   }
  }
  for(const path of paths){
   const id='sandbox-'+await digest(new TextEncoder().encode(JSON.stringify([history.conversationId,message.id,path])));
   const name=path.split('/').at(-1),mime=mimeTypes[name.split('.').at(-1).toLowerCase()]??'application/octet-stream';
   artifacts.push({id,conversationId:history.conversationId,messageId:message.id,path,name,mime,image:mime.startsWith('image/')});
  }
 }
 if(request.operation==='listArtifacts')return {artifacts,before:history.before,scope:'public-sandbox-links',otherMediaResolved:false};
 const artifact=artifacts.find(a=>a.id===request.artifactId&&a.messageId===request.messageId);
 if(!artifact)fail('ARTIFACT_NOT_ON_BRANCH');
 const signal=AbortSignal.timeout(12000);
 const bounded=promise=>new Promise((resolve,reject)=>{
  const abort=()=>reject(Error('NATIVE_ASSET_TIMEOUT'));
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
 });
 let m;
 const account=async()=>{
  const state=await bounded(m.M9.accessInputs.readAccountInfo());
  if(state?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');
  const {accountId,userId,authenticatedUserId}=state.data??{};
  if(![accountId,userId].every(v=>typeof v==='string'&&v.length>0&&v.length<256))fail('ACCOUNT_UNAVAILABLE');
  const fingerprint=await digest(new TextEncoder().encode(JSON.stringify([accountId,userId,authenticatedUserId??null])));
  if(fingerprint!==request.accountFingerprint)fail('ACCOUNT_CHANGED');
  return {accountId,userId};
 };
 let stream;
 try{
  m=await bounded(load());
  const principal=await account();
  const resolved=await bounded(m.kWt.safeGet('/conversation/{conversation_id}/interpreter/download',{
   parameters:{path:{conversation_id:artifact.conversationId},query:{message_id:artifact.messageId,sandbox_path:artifact.path}},
   expectedIdentity:principal,signal,
  }));
  await account();
  if(resolved.status!=null&&resolved.status!=='success')fail('ASSET_UNAVAILABLE');
  const url=new URL(resolved.download_url);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)fail('UNSAFE_ASSET_URL');
  const estuary=url.hostname==='chatgpt.com'&&url.pathname==='/backend-api/estuary/content';
  if(!estuary&&!(url.hostname==='files.oaiusercontent.com'||url.hostname.endsWith('.oaiusercontent.com')))fail('UNSAFE_ASSET_URL');
  // Estuary requires the app's own host-authenticated binary transport. This is
  // the native fixed opt-in marker, not a token. Principal checking remains in
  // the native host; only the exact resolved content route is accepted here.
  const response=await bounded(estuary
   ? m.$rn.getInstance().fetch(url.href,{headers:{'X-OpenAI-Attach-Auth':'1'},expectedIdentity:principal,signal})
   : runtime.fetch(url.href,{credentials:'omit',redirect:'error',signal,referrerPolicy:'no-referrer'}));
  stream=response.body?.getReader();
  if(!response.ok||!response.body)fail('ASSET_UNAVAILABLE');
  const maxBytes=1024*1024;
  const length=response.headers.get('content-length');if(length!=null&&Number(length)>maxBytes)fail('ASSET_TOO_LARGE');
  const chunks=[];let count=0;
  while(true){const {done,value}=await bounded(stream.read());if(done)break;count+=value.length;if(count>maxBytes)fail('ASSET_TOO_LARGE');chunks.push(value);}
  if(count===0)fail('ASSET_EMPTY');
  const bytes=new Uint8Array(count);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  await account();
  const sha256=await digest(bytes);const binary=[];for(let i=0;i<count;i+=8192)binary.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
  return {artifact,bytes:count,sha256,base64:runtime.btoa(binary.join(''))};
 }catch(error){fail(/^NATIVE_[A-Z_]+$/.test(error?.message??'')?error.message.slice(7):signal.aborted?'ASSET_TIMEOUT':'ASSET_UNAVAILABLE');}
 finally{if(stream)await bounded(stream.cancel()).catch(()=>{});}
}
