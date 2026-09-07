// Verify the navigation effect itself; the extension can lose its acknowledgement
// when opening an already-new chat or replacing its content-script document.
export async function sessionReady(page, sessionId) {
 return page.evaluate(id=>{
  const url=new URL(location.href),match=url.pathname.match(/\/c\/([a-zA-Z0-9-]+)\/?$/);
  if(url.origin!=='https://chatgpt.com')return false;
  if(id?match?.[1]!==id:url.pathname!=='/')return false;
  const editor=document.querySelector('#prompt-textarea');
  if(!editor?.isContentEditable||!editor.getClientRects().length)return false;
  if(document.querySelector('[data-testid="stop-button"]'))return false;
  return !!id||(!editor.textContent.trim()&&!document.querySelector('[data-message-author-role]'));
 },sessionId);
}
export async function prepareSession({activePage,health,command,sessionId=null}) {
 if(sessionId!==null&&(typeof sessionId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(sessionId)))throw Error('GPT_SESSION_INVALID');
 const ready=async()=>{
  const state=await health();
  if(state.activeRequests?.length)throw Error('GPT_BUSY');
  const page=await activePage();
  return state.activeClient?.ready===true&&state.activeClient?.pageReady===true&&
   state.activeClient.url===page.url()&&await sessionReady(page,sessionId);
 };
 if(await ready())return {ok:true};
 let accepted=false;
 try{accepted=await command(sessionId);}catch{/* Only a verified postcondition can confirm this navigation. */}
 const until=Date.now()+8000;
 while(Date.now()<until){
  if(await ready())return {ok:true};
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 throw Error(accepted?'GPT_SESSION_NOT_READY':'GPT_SESSION_NOT_CONFIRMED');
}
