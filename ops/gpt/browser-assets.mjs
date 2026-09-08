// Account credentials never leave the browser origin.
export async function readAsset(page,id,sandbox){
 return page.evaluate(async ({id,sandbox})=>{
  const session=await(await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(10000)})).json();
  if(typeof session.accessToken!=='string')return {status:401};
  const endpoint=sandbox?'/backend-api/conversation/'+encodeURIComponent(sandbox.conversationId)+'/interpreter/download?'+new URLSearchParams({message_id:sandbox.messageId,sandbox_path:sandbox.path}):'/backend-api/files/'+encodeURIComponent(id)+'/download';
  const response=await fetch(endpoint,{credentials:'include',headers:{Authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(20000)});
  if(!response.ok)return {status:response.status};
  const data=await response.json(),url=new URL(data.download_url,location.origin);
  if(url.protocol!=='https:'||!(url.hostname==='chatgpt.com'||url.hostname==='files.oaiusercontent.com'||url.hostname.endsWith('.oaiusercontent.com')))return {status:502};
  const binary=await fetch(url.href,{credentials:url.origin===location.origin?'include':'omit',redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!binary.ok)return {status:binary.status};
  const reader=binary.body.getReader(),parts=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>32*1024*1024){await reader.cancel();return {status:413}}parts.push(value)}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}
  const chunks=[];for(let i=0;i<length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return {status:200,mime:binary.headers.get('content-type')||'application/octet-stream',base64:btoa(chunks.join(''))};
 },{id,sandbox});
}
