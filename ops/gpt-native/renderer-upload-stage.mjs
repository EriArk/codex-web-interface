// Fixed data-only staging inside the native main renderer. No URLs, paths or code.
export function nativeUploadStage(request, runtime = globalThis) {
 const fail=code=>{throw Error(`NATIVE_${code}`);};
 const key=Symbol.for('codex-web.native-upload-bytes');
 if(!/^[a-f0-9-]{36}$/.test(request?.stageId??''))fail('INVALID_UPLOAD');
 const previous=runtime[key];
 if(request.operation==='clearUpload'){
  if(previous?.stageId===request.stageId){runtime.clearTimeout(previous.timer);delete runtime[key];}
  return {ready:true};
 }
 if(request.operation==='beginUpload'){
  if(previous)fail('UPLOAD_BUSY');
  if(!Number.isSafeInteger(request.bytes)||request.bytes<1||request.bytes>25*1024*1024||!/^[a-f0-9]{64}$/.test(request.sha256??'')||!/^[a-f0-9]{64}$/.test(request.accountFingerprint??''))fail('INVALID_UPLOAD');
  const state={stageId:request.stageId,bytes:new Uint8Array(request.bytes),sha256:request.sha256,accountFingerprint:request.accountFingerprint,offset:0};
  runtime[key]=state;
  state.timer=runtime.setTimeout(()=>{if(runtime[key]===state)delete runtime[key];},120000);
  return {offset:0};
 }
 if(request.operation!=='appendUpload'||previous?.stageId!==request.stageId||previous.accountFingerprint!==request.accountFingerprint||request.offset!==previous.offset||typeof request.base64!=='string'||request.base64.length>131072)fail('INVALID_UPLOAD');
 let bytes;try{bytes=Uint8Array.from(runtime.atob(request.base64),c=>c.charCodeAt(0));}catch{fail('INVALID_UPLOAD');}
 if(!bytes.length||previous.offset+bytes.length>previous.bytes.length)fail('INVALID_UPLOAD');
 previous.bytes.set(bytes,previous.offset);previous.offset+=bytes.length;
 return {offset:previous.offset};
}
