// Same consumer-account route used by Codex's native voice client. No API billing key,
// transcript prompt, chat selection, model change or message submission is involved.
export async function transcribeDictation(page, input) {
  const types = { 'audio/wav':'wav', 'audio/webm':'webm', 'audio/mp4':'m4a', 'audio/ogg':'ogg' };
  if (!input || typeof input.audio !== 'string' || input.audio.length > 8*1024*1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio) || !Object.hasOwn(types,input.mime) || Object.keys(input).some(k=>!['audio','mime'].includes(k)))
    return {status:400,error:'DICTATION_AUDIO'};
  if (new URL(page.url()).origin !== 'https://chatgpt.com') return {status:401,error:'GPT_LOGIN_REQUIRED'};
  return page.evaluate(async ({audio,mime,extension}) => {
    const sessionResponse=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!sessionResponse.ok)return {status:401,error:'GPT_LOGIN_REQUIRED'};
    const session=await sessionResponse.json();
    if(typeof session.accessToken!=='string')return {status:401,error:'GPT_LOGIN_REQUIRED'};
    const bytes=Uint8Array.from(atob(audio),c=>c.charCodeAt(0));
    const form=new FormData();form.append('file',new Blob([bytes],{type:mime}),'dictation.'+extension);
    const response=await fetch('/backend-api/transcribe',{method:'POST',credentials:'include',cache:'no-store',
      headers:{Authorization:'Bearer '+session.accessToken},body:form,signal:AbortSignal.timeout(120000)});
    if(!response.ok)return {status:response.status,error:'DICTATION_NATIVE_FAILED'};
    const reader=response.body.getReader(); const chunks=[]; let size=0;
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>128000){await reader.cancel();return {status:502,error:'DICTATION_RESPONSE'}}chunks.push(part.value)}
    const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length}
    try {const result=JSON.parse(new TextDecoder().decode(data));
      return typeof result.text==='string' && result.text.length<=32000 ? {status:200,text:result.text} : {status:502,error:'DICTATION_RESPONSE'};
    }catch{return {status:502,error:'DICTATION_RESPONSE'}}
  },{audio:input.audio,mime:input.mime,extension:types[input.mime]});
}
