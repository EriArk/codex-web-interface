// Uses the pinned native client's /transcribe transport, without chat or model mutations.
export async function nativeDictation(r,read,load=()=>import('app://-/assets/app-initial-430deae5a13a.js'),runtime=globalThis){
 const fail=c=>{throw Error('NATIVE_'+c);},types={'audio/wav':'wav','audio/webm':'webm','audio/mp4':'m4a','audio/ogg':'ogg'};
 if(!Object.hasOwn(types,r.mime)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>6*1024**2)fail('INVALID_AUDIO');
 const key=Symbol.for('codex-web.native-upload-bytes'),state=runtime[key];
 if(!state||state.stageId!==r.stageId||state.offset!==r.bytes||state.bytes.length!==r.bytes||state.sha256!==r.sha256||state.accountFingerprint!==r.accountFingerprint)fail('UPLOAD_CHANGED');
 runtime.clearTimeout(state.timer);delete runtime[key];
 const digest=async bytes=>Array.from(new Uint8Array(await runtime.crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 if(await digest(state.bytes)!==r.sha256)fail('UPLOAD_CHANGED');
 if((await read({operation:'inspectAccount'},load,runtime)).accountFingerprint!==r.accountFingerprint)fail('ACCOUNT_MISMATCH');
 const m=await load(),signal=AbortSignal.timeout(90000);
 const account=async()=>{const v=await m.M9.accessInputs.readAccountInfo();if(v?.status!=='ready')fail('ACCOUNT_UNAVAILABLE');const p=v.data;
 if(await digest(new TextEncoder().encode(JSON.stringify([p.accountId,p.userId,p.authenticatedUserId??null])))!==r.accountFingerprint)fail('ACCOUNT_CHANGED');return {accountId:p.accountId,userId:p.userId};};
 const principal=await account(),boundary='----codex-web-'+runtime.crypto.randomUUID(),e=new TextEncoder();
 const head=e.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.${types[r.mime]}"\r\nContent-Type: ${r.mime}\r\n\r\n`),tail=e.encode(`\r\n--${boundary}--\r\n`),body=new Uint8Array(head.length+state.bytes.length+tail.length);
 body.set(head);body.set(state.bytes,head.length);body.set(tail,head.length+state.bytes.length);
 const target=m.kWt.getRequestTarget('/transcribe',{});let attempts=0;
 const response=await m.$rn.getInstance().fetch(target.url,{method:'POST',headers:{...target.headers,'Content-Type':`multipart/form-data; boundary=${boundary}`},body,signal,retry:false,expectedIdentity:principal,assertRequestCurrent:()=>{if(signal.aborted||attempts++!==0)fail('DICTATION_REPLAY_BLOCKED');}});
 await account();if(!response.ok)fail('DICTATION_FAILED');
 const reader=response.body.getReader(),chunks=[];let size=0;
 for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>128000){await reader.cancel();fail('RESPONSE_TOO_LARGE');}chunks.push(part.value);}
 const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
 const result=JSON.parse(new TextDecoder().decode(raw));await account();if(typeof result.text!=='string'||result.text.length>32000)fail('DICTATION_RESPONSE');return {text:result.text};
}
