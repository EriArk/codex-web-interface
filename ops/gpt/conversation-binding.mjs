// Defer only a new chat's provisional WEB id while its one submission is being
// observed. This is neither a confirmed binding nor permission to send again.
export function pendingConversationBinding({state,observation,requestId,clientId,submittedUserTurnKey}) {
 const source=state?.source, active=observation?.activeRequest;
 const previous=String(source?.conversationId||''), next=String(observation?.conversationId||'');
 const pending=String(state?.lastObservation?.data?.pendingConversationId||'');
 return state?.submission==='accepted' && !submittedUserTurnKey &&
  /^WEB:[a-zA-Z0-9_-]{1,100}$/.test(previous) &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(next) &&
  (!pending||pending===next) && !!source?.clientId && source.clientId===clientId &&
  !!requestId && active?.requestId===requestId &&
  !!source.leaseId && active?.leaseId===source.leaseId &&
  !!source.ownerServerInstanceId && active?.ownerServerInstanceId===source.ownerServerInstanceId;
}


export function activeConversation(health) {
 const client=health?.activeClient;
 const active=health?.activeRequests?.find(r=>r.clientId===client?.id);
 let visible=null;
 try {const url=new URL(client?.url);if(url.origin==='https://chatgpt.com')visible=url.pathname.match(/\/c\/([a-f0-9-]+)\/?$/i)?.[1]??null;}catch{}
 if(!active)return {requestId:null,nativeId:visible,generating:false};
 const state=active.canonicalState;
 const confirmed=state?.requestId===active.requestId && state?.submission==='submitted' &&
  !!state?.response?.userTurnKey && state?.source?.clientId===client?.id &&
  state?.source?.conversationId===visible;
 return {requestId:active.requestId,nativeId:confirmed?visible:null,generating:active.currentGenerationActive===true};
}
