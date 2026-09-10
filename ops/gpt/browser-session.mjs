import {dismissPromotions} from './browser-obstructions.mjs';
// Verify navigation itself: replacing the content-script document can lose its ack.
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
export async function prepareSession({activePage,health,command,sessionId=null,clearOverlays=dismissPromotions,timeoutMs=22000,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
 if(sessionId!==null&&(typeof sessionId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(sessionId)))throw Error('GPT_SESSION_INVALID');
 const until=now()+timeoutMs;
 const probe=async()=>{
  try {
   const state=await health();
   if(state.activeRequests?.length)throw Error('GPT_BUSY');
   const page=await activePage();
   // Do not touch an unbound tab or a page still replacing its JS context.
   if(!state.activeClient?.ready||!state.activeClient?.pageReady||state.activeClient.url!==page.url())return {ready:false,navigable:false};
   await clearOverlays(page);
   return {ready:await sessionReady(page,sessionId),navigable:true};
  } catch(error) {
   if(['GPT_BUSY','GPT_UI_ATTENTION'].includes(error?.message))throw error;
   // Target/DOM/extension may disappear briefly during normal navigation.
   return {ready:false,navigable:false};
  }
 };
 let state=await probe();
 if(state.ready)return {ok:true};
 while(!state.navigable&&now()<until){await sleep(150);state=await probe();if(state.ready)return {ok:true};}
 if(!state.navigable)throw Error('GPT_SESSION_NOT_READY');
 let accepted=false;
 // Exactly one command. Never repeat a navigation with an unknown outcome.
 try{accepted=await command(sessionId);}catch{}
 while(now()<until){
  if((await probe()).ready)return {ok:true};
  await sleep(150);
 }
 throw Error(accepted?'GPT_SESSION_NOT_READY':'GPT_SESSION_NOT_CONFIRMED');
}
