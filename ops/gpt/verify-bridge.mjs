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

// Exercise the pinned content-script observer with virtual time, including a
// 26-second image acknowledgement. No second click is scheduled by the waiter.
const { readFileSync } = await import('node:fs');
const vm = await import('node:vm');
let now=0, nextTimer=0, observer, turns=[];
const timers=new Map();
const document={querySelectorAll:()=>[],querySelector:()=>null,body:{}};
const context=vm.createContext({document,console,Date:{now:()=>now},
 setTimeout:(fn,ms)=>{timers.set(++nextTimer,{fn,at:now+ms});return nextTimer;},
 clearTimeout:id=>timers.delete(id),
 MutationObserver:class{constructor(fn){observer=fn;}observe(){}disconnect(){observer=null;}},
});
vm.runInContext(readFileSync('/opt/bridge/tools/chrome-bridge-extension/content/runtimeConfig.js','utf8'),context);
vm.runInContext(readFileSync('/opt/bridge/tools/chrome-bridge-extension/content/composerCommands.js','utf8'),context);
const config=context.ChatGptContentRuntimeConfig.DEFAULT_CONFIG;
const api=context.ChatGptComposerCommands.createComposerCommands({
 CONFIG:config,DOM_PARSER:{userTurnMatchesExpectedText:(actual,expected)=>!expected.trim()||actual===expected},
 getTurnNodes:()=>turns,turnKey:turn=>turn.key,turnRole:turn=>turn.role,visibleText:turn=>turn.text,
 isGenerating:()=>false,isVisible:()=>true,isPrimaryChatSurfaceElement:()=>true,diagnostic:()=>{},
});
assert.equal(api.resolveSubmissionAckTimeoutMs({}),60000);
for(const message of ['', 'Describe these images']) {
 turns=[];const waiter=api.createPromptSubmissionEvidenceWaiter({},new Set(),message,null,api.resolveSubmissionAckTimeoutMs({}));
 let done=false;const result=waiter.wait().then(value=>{done=true;return value;});
 now+=26000;await Promise.resolve();assert.equal(done,false);
 turns=[{key:'image-user-'+now,role:'user',text:message}];observer();
 const evidence=await result;assert.equal(evidence.confirmed,true);assert.equal(evidence.reason,'new_user_turn');assert.equal(evidence.waitedMs,26000);
 assert.equal(timers.size,0);
}
turns=[];
const uncertain=api.createPromptSubmissionEvidenceWaiter({},new Set(),'missing',null,60000).wait();
now+=60000;for(const timer of [...timers.values()])if(timer.at<=now)timer.fn();
assert.equal((await uncertain).confirmed,false);
console.log('Pinned composer verified: late image-only/text+image acceptance, bounded unknown state without replay.');


// Test the actual pinned observation adapter AND reducer, not a replacement.
const {tabObservationToCanonicalEvent}=await import('/opt/bridge/src/bridge/adapters/tabObservationAdapter.js');
const {createInitialRequestState}=await import('/opt/bridge/src/bridge/state/requestPolicy.js');
const {reduceRequestState}=await import('/opt/bridge/src/bridge/state/requestMachine.js');
const provisional='WEB:11111111-1111-4111-8111-111111111111',canonical='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const base=createInitialRequestState({requestId:'binding-fixture',sourceClientId:'fixture-tab',leaseId:'fixture-lease',ownerServerInstanceId:'fixture-owner',conversationId:provisional,at:1});
base.submission='accepted';base.lifecycle='preparing';
const observation={conversationId:canonical,observedAt:10,activeRequest:{requestId:base.requestId,leaseId:base.source.leaseId,ownerServerInstanceId:base.source.ownerServerInstanceId,submittedUserTurnKey:''},turn:{state:'placeholder',phase:'ASSISTANT_PLACEHOLDER',count:0},generation:{state:'stopped'},output:{state:'none'},artifact:{state:'none'},blocker:{state:'none'}};
const pendingEvent=tabObservationToCanonicalEvent(base.requestId,'fixture-tab',{observation},base,10);
assert.equal(pendingEvent.data.conversationChanged,false);
assert.equal(pendingEvent.data.conversationCanonicalized,false);
assert.equal(pendingEvent.data.conversationId,provisional);
assert.equal(pendingEvent.data.pendingConversationId,canonical);
assert.equal(pendingEvent.data.answer,'');assert.equal(pendingEvent.data.scopedToRequest,false);
const pendingState=reduceRequestState(base,pendingEvent);
assert.equal(pendingState.state.terminal,null);assert.equal(pendingState.state.source.conversationId,provisional);
assert.deepEqual(pendingState.effects,[]);assert.deepEqual(pendingState.deadlines,[]);
const submitted={...pendingState.state,submission:'submitted'};
const confirmed={...observation,observedAt:20,activeRequest:{...observation.activeRequest,submittedUserTurnKey:'fixture-user'},turn:{...observation.turn,userKey:'fixture-user'}};
const confirmedEvent=tabObservationToCanonicalEvent(base.requestId,'fixture-tab',{observation:confirmed},submitted,20);
assert.equal(confirmedEvent.data.conversationCanonicalized,true);
const confirmedState=reduceRequestState(submitted,confirmedEvent);
assert.equal(confirmedState.state.terminal,null);assert.equal(confirmedState.state.source.conversationId,canonical);
for(const [state,observed] of [[{...base,source:{...base.source,conversationId:other}},observation],[base,{...observation,activeRequest:{...observation.activeRequest,leaseId:'other'}}],[pendingState.state,{...observation,conversationId:other}]]){
 const event=tabObservationToCanonicalEvent(base.requestId,'fixture-tab',{observation:observed},state,30);
 assert.equal(event.data.conversationChanged,true);
 assert.equal(reduceRequestState(state,event).state.terminal.code,'conversation_changed');
}
console.log('Pinned canonical binding verified: wait for new-chat user evidence; retain existing-chat, lease and candidate identity guards; no prompt effects.');
