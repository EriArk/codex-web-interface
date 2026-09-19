// Fixed native upload contract. Bytes enter the app; auth and signed URLs never leave it.
export async function nativeUpload(request, read, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail=code=>{throw Error(`NATIVE_${code}`);};
 const signal=AbortSignal.timeout(60000);
 const f=request.file;
 if(!f||!['text/plain','text/markdown','text/csv','application/json','application/pdf','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/png','image/jpeg','image/webp','image/gif'].includes(f.mime)||typeof f.name!=='string'||!f.name||f.name.length>255||/[\\/\x00-\x1f]/.test(f.name)||
    !Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>20*1024*1024||(!f.stageId&&(typeof f.base64!=='string'||f.base64.length>1398104))||!/^[a-f0-9]{64}$/.test(f.sha256??''))fail('INVALID_UPLOAD');
 let bytes;
 if(f.stageId){
  const key=Symbol.for('codex-web.native-upload-bytes'),state=runtime[key];
  if(!state||state.stageId!==f.stageId||state.offset!==f.bytes||state.bytes.length!==f.bytes||state.sha256!==f.sha256||state.accountFingerprint!==request.accountFingerprint)fail('UPLOAD_CHANGED');
  runtime.clearTimeout(state.timer);delete runtime[key];bytes=state.bytes;
 }else bytes=Uint8Array.from(runtime.atob(f.base64),x=>x.charCodeAt(0));
 const digest=async b=>Array.from(new Uint8Array(await runtime.crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
 if(bytes.length!==f.bytes||await digest(bytes)!==f.sha256)fail('UPLOAD_CHANGED');
 if((await read({operation:'inspectAccount'})).accountFingerprint!==request.accountFingerprint)fail('ACCOUNT_MISMATCH');
 let dimensions={};
 if(f.mime.startsWith('image/')){
  // Uploaded images are bounded again in the renderer; a file cannot masquerade as another MIME.
  if(f.mime==='image/png'&&(bytes.length<24||![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)))fail('INVALID_IMAGE');
  if(f.mime==='image/png'){const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),w=d.getUint32(16),h=d.getUint32(20);if(!w||!h||w>8192||h>8192||w*h>32000000)fail('INVALID_IMAGE');}
  if(f.mime==='image/jpeg'&&(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255))fail('INVALID_IMAGE');
  if(f.mime==='image/gif'&&!['GIF87a','GIF89a'].includes(new TextDecoder().decode(bytes.subarray(0,6))))fail('INVALID_IMAGE');
  if(f.mime==='image/webp'&&(new TextDecoder().decode(bytes.subarray(0,4))!=='RIFF'||new TextDecoder().decode(bytes.subarray(8,12))!=='WEBP'))fail('INVALID_IMAGE');
  const bitmap=await runtime.createImageBitmap(new Blob([bytes],{type:f.mime}));
  try{
   const {width,height}=bitmap;
   if(width<1||height<1||width>8192||height>8192||width*height>32000000)fail('INVALID_IMAGE');
   dimensions={width,height};
  }finally{bitmap.close();}
 }
 const m=await load();
 if(signal.aborted)fail('UPLOAD_TIMEOUT');
 const account=async()=>{
  const info=await m.M9.accessInputs.readAccountInfo();
  if(info?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');
  const p=info.data;
  if(await digest(new TextEncoder().encode(JSON.stringify([p?.accountId,p?.userId,p?.authenticatedUserId??null])))!==request.accountFingerprint)fail('ACCOUNT_CHANGED');
  return {accountId:p.accountId,userId:p.userId};
 };
 const principal=await account();
 const bounded=promise=>new Promise((resolve,reject)=>{
  const abort=()=>reject(Error('NATIVE_UPLOAD_TIMEOUT'));
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
 });
 // Each native transport operation may run once. The host checks expectedIdentity
 // immediately before authenticated IO; retry:false on postResponse preserves it.
 const options=()=>{let calls=0;return {signal,expectedIdentity:principal,retry:false,assertRequestCurrent:()=>{if(signal.aborted||calls++!==0)fail('UPLOAD_REPLAY_BLOCKED');}};};
 let stream,stage='CREATE';
 const responseBytes=async response=>{
  if(!response.ok||!response.body)fail('UPLOAD_UNAVAILABLE');
  stream=response.body.getReader();let size=0;const chunks=[];
  while(true){const {done,value}=await bounded(stream.read());if(done)break;size+=value.length;if(size>65536)fail('UPLOAD_RESPONSE_TOO_LARGE');chunks.push(value);}
  stream.releaseLock();stream=null;
  const result=new Uint8Array(size);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}return result;
 };
 try{
  const useCase=f.mime.startsWith('image/')?'multimodal':'my_files';
  const created=JSON.parse(new TextDecoder().decode(await responseBytes(await bounded(m.kWt.postResponse('/files',{
   ...options(),requestBody:{entry_surface:'chat_composer',file_name:f.name,file_size:f.bytes,mime_type:f.mime,
    reset_rate_limits:false,timezone_offset_min:0,use_case:useCase},
  })))));
  await bounded(account());
  if(typeof created?.file_id!=='string'||!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(created.file_id))fail('INVALID_UPLOAD_RESPONSE');
  const url=new URL(created.upload_url);
  stage='TRANSFER';
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash)fail('UNSUPPORTED_UPLOAD_TARGET');
  let uploaded;
  if(url.hostname==='chatgpt.com'&&url.pathname==='/backend-api/estuary/upload_content_bytes'&&url.searchParams.get('upload_url')){
   const form=new FormData();form.append('file',new File([bytes],f.name,{type:f.mime}));form.append('upload_url',url.searchParams.get('upload_url'));
   const encoded=new Response(form),body=new Uint8Array(await encoded.arrayBuffer());
   await bounded(account());
   uploaded=await bounded(m.$rn.getInstance().fetch(url.href,{...options(),method:'POST',body,
    headers:{'Content-Type':encoded.headers.get('content-type'),'X-OpenAI-Attach-Auth':'1'}}));
  }else if((/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)||/^[a-z0-9-]+\.oaiusercontent\.com$/.test(url.hostname))&&url.search){
   // The native host validates expectedIdentity against an attached auth token;
   // object-storage PUT has none. Its signed capability already belongs to the
   // authenticated /files response. Check the account around this fixed upload,
   // then require host principal validation again for processing and submission.
   const aws=Array.from(url.searchParams.keys()).some(k=>k.toLowerCase()==='x-amz-algorithm');
   const headers=created.upload_headers??{'Content-Type':f.mime,...(aws?{}:{'x-ms-blob-type':'BlockBlob','x-ms-version':'2020-04-08','x-ms-blob-content-type':f.mime})};
   if(Object.keys(headers).some(k=>!['content-type','x-ms-blob-type','x-ms-version','x-ms-blob-content-type'].includes(k.toLowerCase()))||Object.values(headers).some(v=>typeof v!=='string'||v.length>256))fail('UNSUPPORTED_UPLOAD_HEADERS');
   await bounded(account());
   const {expectedIdentity:unused,...uploadOptions}=options();
   uploaded=await bounded(m.$rn.getInstance().fetch(url.href,{...uploadOptions,method:'PUT',body:bytes,headers}));
  }else fail('UNSUPPORTED_UPLOAD_TARGET');
  if(!uploaded.ok)fail('UPLOAD_TRANSFER_FAILED');
  if(uploaded.body)await responseBytes(uploaded);await bounded(account());
  stage='PROCESS';
  const processed=await bounded(m.kWt.postResponse('/files/process_upload_stream',{...options(),requestBody:{
   entry_surface:'chat_composer',file_id:created.file_id,file_name:f.name,index_for_retrieval:useCase==='my_files',
   library_persistence_mode:'opportunistic',metadata:{store_in_library:false},mime_type:f.mime,use_case:useCase,
  }}));
  const raw=new TextDecoder().decode(await responseBytes(processed));
  let ready=false;
  for(const line of raw.split('\n').filter(x=>x.trim())){
   const event=JSON.parse(line);
   if(typeof event.event!=='string'||/\.(error|cancelled|failed|unknown)$/.test(event.event)||event.extra?.error_code)fail('UPLOAD_PROCESSING_FAILED');
   if(event.event==='file.processing.file_ready')ready=true;
  }
  if(!ready)fail('UPLOAD_NOT_READY');
  await bounded(account());
  return {id:created.file_id,name:f.name,mimeType:f.mime,size:f.bytes,source:'local',...dimensions};
 }catch(error){
  const code=typeof error?.errorCode==='string'&&/^[a-z_]{1,80}$/.test(error.errorCode)?error.errorCode.toUpperCase():error?.errorKind==='network'?'NETWORK':error?.name==='TypeError'?'TYPE_ERROR':'UNAVAILABLE';
  fail(/^NATIVE_[A-Z_]+$/.test(error?.message??'')?error.message.slice(7):signal.aborted?'UPLOAD_TIMEOUT':'UPLOAD_'+stage+(error?.responseStatus===403||error?.status===403?'_FORBIDDEN':error?.responseStatus===400||error?.status===400?'_BAD_REQUEST':'_'+code));
 }
 finally{if(stream)await stream.cancel().catch(()=>{});}
}
