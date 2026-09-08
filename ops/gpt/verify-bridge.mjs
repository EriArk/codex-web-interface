// Build-time acceptance against the actual pinned HTTP router, with no browser/account.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
process.env.API_TOKEN='fixture-only-token';
process.env.BRIDGE_TOKEN='fixture-only-token';
process.env.DATA_DIR='/tmp/gpt-bridge-verification';
const {createApp}=await import('/opt/bridge/src/server.js');
const sent=[];
const bridge={authorized:()=>true,isAuthorized:()=>true,sendRequest:async(request,callbacks)=>{
 sent.push(request);
 callbacks.onEvent?.({type:'request.started',requestId:'fixture-request'});
 callbacks.onEvent?.({type:'prompt.sent'});
 callbacks.onEvent?.({type:'request.done',session:{id:'fixture-chat'},artifacts:[]});
 return {requestId:'fixture-request',answer:'Fixture answer'};
}};
const server=createServer(createApp(bridge,{}));server.listen(0,'127.0.0.1');await once(server,'listening');
try{
 for(const route of ['/chat','/sessions/fixture-chat/messages']){
  for(const text of ['','  ','Describe these images']){
   const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{Authorization:'Bearer fixture-only-token','Content-Type':'application/json'},body:JSON.stringify({message:text,attachments:['file_one','file_two','file_three'],stream:true})});
   assert.equal(response.status,200);assert.match(await response.text(),/prompt.sent/);
   assert.equal(sent.at(-1).message,text);assert.deepEqual(sent.at(-1).attachments,['file_one','file_two','file_three']);
  }
  const before=sent.length;
  const empty=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{Authorization:'Bearer fixture-only-token','Content-Type':'application/json'},body:JSON.stringify({message:'  ',attachments:[],stream:true})});
  assert.equal(empty.status,400);assert.equal((await empty.json()).detail,'No message provided');assert.equal(sent.length,before);
 }
 assert.equal(sent.length,6);
 console.log('Pinned bridge verified: image-only, whitespace + images, text + images; truly empty rejected before dispatch.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
