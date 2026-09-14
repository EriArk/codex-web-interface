import {dismissPromotions} from './browser-obstructions.mjs';
export function projectPath(path,id) {
 const parts=path.split('/').filter(Boolean);
 return parts.length===3&&parts[0]==='g'&&parts[2]==='project'&&(parts[1]===id||parts[1].startsWith(id+'-'));
}
export async function projectComposer(page,projectId) {
 return page.evaluate(id=>{
  const match=(path,id)=>{const parts=path.split('/').filter(Boolean);return parts.length===3&&parts[0]==='g'&&parts[2]==='project'&&(parts[1]===id||parts[1].startsWith(id+'-'));};
  const url=new URL(location.href);
  if(url.origin!=='https://chatgpt.com'||!match(url.pathname,id))return false;
  const editor=document.querySelector('#prompt-textarea');
  return !!editor?.isContentEditable&&!!editor.getClientRects().length&&!editor.textContent.trim()&&!document.querySelector('[data-message-author-role], [data-testid="stop-button"]');
 },projectId);
}
export async function prepareProjectSession({activePage,health,projectId,clearOverlays=dismissPromotions,timeoutMs=22000,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
 if(typeof projectId!=='string'||!/^g-p-[a-zA-Z0-9-]{8,90}$/.test(projectId))throw Error('GPT_PROJECT_INVALID');
 const until=now()+timeoutMs;
 const probe=async()=>{
  const state=await health();if(state.activeRequests?.length)throw Error('GPT_BUSY');
  const page=await activePage();
  if(!state.activeClient?.ready||!state.activeClient?.pageReady||state.activeClient.url!==page.url())return null;
  await clearOverlays(page);return page;
 };
 let page;
 while(now()<until&&!page){try{page=await probe();}catch(e){if(['GPT_BUSY','GPT_UI_ATTENTION'].includes(e?.message))throw e;}if(!page)await sleep(150);}
 if(!page)throw Error('GPT_SESSION_NOT_READY');
 if(await projectComposer(page,projectId))return {ok:true};
 const paths=await page.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
 const target=paths.map(h=>{try{return new URL(h,'https://chatgpt.com');}catch{return null;}}).find(u=>u?.origin==='https://chatgpt.com'&&projectPath(u.pathname,projectId));
 if(!target)throw Error('GPT_PROJECT_NOT_VISIBLE');
 // One navigation; retry is only allowed before a prompt has been sent.
 if(now()>=until)throw Error('GPT_SESSION_NOT_READY');
 await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:Math.max(1,Math.min(15000,until-now()))}).catch(()=>{});
 while(now()<until){try{const current=await probe();if(current&&await projectComposer(current,projectId))return {ok:true};}catch(e){if(['GPT_BUSY','GPT_UI_ATTENTION'].includes(e?.message))throw e;}await sleep(150);}
 throw Error('GPT_SESSION_NOT_READY');
}
