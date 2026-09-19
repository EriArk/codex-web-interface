// Fixed native authenticated entry/processing. The private supervisor streams the
// signed storage capability; it is never returned to the Hub/browser or logged.
export async function nativeStoredUpload(request,read,load=()=>import('app://-/assets/app-initial-430deae5a13a.js'),runtime=globalThis){
 const fail=c=>{throw Error(`NATIVE_${c}`);},f=request.file;
 if(!['prepareStoredUpload','finishStoredUpload'].includes(request.operation)||!f||typeof f.name!=='string'||!f.name||f.name.length>255||/[\\/\x00-\x1f]/.test(f.name)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>512*1024**2||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i.test(f.mime)||f.mime.startsWith('image/'))fail('INVALID_UPLOAD');
 if((await read({operation:'inspectAccount'})).accountFingerprint!==request.accountFingerprint)fail('ACCOUNT_MISMATCH');
 const m=await load(),signal=AbortSignal.timeout(60000);
 const account=async()=>{
  const value=await m.M9.accessInputs.readAccountInfo();if(value?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');
  const p=value.data,d=await runtime.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([p.accountId,p.userId,p.authenticatedUserId??null])));
  if(Array.from(new Uint8Array(d),b=>b.toString(16).padStart(2,'0')).join('')!==request.accountFingerprint)fail('ACCOUNT_CHANGED');
  return {accountId:p.accountId,userId:p.userId};
 };
 const principal=await account();let attempts=0;
 const options={expectedIdentity:principal,signal,retry:false,assertRequestCurrent:()=>{if(signal.aborted||attempts++!==0)fail('UPLOAD_REPLAY_BLOCKED');}};
 let response;
 if(request.operation==='prepareStoredUpload')response=await m.kWt.postResponse('/files',{...options,requestBody:{entry_surface:'chat_composer',file_name:f.name,file_size:f.bytes,mime_type:f.mime,reset_rate_limits:false,timezone_offset_min:0,use_case:'my_files'}});
 else {
  if(!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(request.nativeId??''))fail('INVALID_UPLOAD');
  response=await m.kWt.postResponse('/files/process_upload_stream',{...options,requestBody:{entry_surface:'chat_composer',file_id:request.nativeId,file_name:f.name,mime_type:f.mime,use_case:'my_files',index_for_retrieval:true,library_persistence_mode:'opportunistic',metadata:{store_in_library:false}}});
 }
 if(!response.ok||!response.body)fail('UPLOAD_UNAVAILABLE');
 const reader=response.body.getReader();let bytes=0;const parts=[];
 try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>65536)fail('UPLOAD_RESPONSE_TOO_LARGE');parts.push(item.value);}}finally{await reader.cancel().catch(()=>{});}
 const data=new Uint8Array(bytes);let offset=0;for(const p of parts){data.set(p,offset);offset+=p.length;}
 await account();const raw=new TextDecoder().decode(data);
 if(request.operation==='prepareStoredUpload'){
  const v=JSON.parse(raw);if(!/^file[-_][a-zA-Z0-9_-]{1,150}$/.test(v.file_id??''))fail('INVALID_UPLOAD_RESPONSE');
  const u=new URL(v.upload_url);
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||!u.search||!(/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(u.hostname)||/^[a-z0-9-]+\.oaiusercontent\.com$/.test(u.hostname)))fail('UNSUPPORTED_UPLOAD_TARGET');
  const aws=Array.from(u.searchParams.keys()).some(k=>k.toLowerCase()==='x-amz-algorithm');
  const headers=v.upload_headers??{'Content-Type':f.mime,...(aws?{}:{'x-ms-blob-type':'BlockBlob','x-ms-version':'2020-04-08','x-ms-blob-content-type':f.mime})};
  if(Object.keys(headers).some(k=>!['content-type','x-ms-blob-type','x-ms-version','x-ms-blob-content-type'].includes(k.toLowerCase()))||Object.values(headers).some(v=>typeof v!=='string'||v.length>256||/[\r\n]/.test(v)))fail('UNSUPPORTED_UPLOAD_HEADERS');
  return {nativeId:v.file_id,url:u.href,headers};
 }
 let ready=false;for(const line of raw.split('\n').filter(l=>l.trim())){
  const e=JSON.parse(line);if(typeof e.event!=='string'||/\.(error|cancelled|failed|unknown)$/.test(e.event)||e.extra?.error_code)fail('UPLOAD_PROCESSING_FAILED');
  if(e.event==='file.processing.file_ready')ready=true;
 }
 if(!ready)fail('UPLOAD_NOT_READY');
 return {id:request.nativeId,name:f.name,mimeType:f.mime,size:f.bytes,source:'local'};
}
