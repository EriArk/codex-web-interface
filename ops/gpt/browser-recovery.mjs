// The pinned extension can retain a quarantined lease after native cancellation.
// Retire that document only when both the bridge and the page prove it idle.
// Never edit a lease, replay a command, clear a composer draft, or restart the profile.
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const statePrefix = 'chatgptBridgeV6:tab:';
const cleanupTimeout = 'Content runtime did not prove request cleanup before the release deadline';

export async function readTabLease(context, client) {
 if (!Number.isInteger(client?.browserTabId)) throw Error('GPT_RECOVERY_UNVERIFIED');
 const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'));
 if (!worker) throw Error('GPT_RECOVERY_UNVERIFIED');
 return worker.evaluate(async key=>{
  const value=(await chrome.storage.session.get(key))[key];
  if (!value || value.schemaVersion!==6) return {known:false};
  const lease=value.lease;
  return {known:true,contentEpoch:value.contentEpoch,lease:lease&&{
   requestId:lease.requestId,leaseId:lease.leaseId,status:lease.status,quarantineReason:lease.quarantineReason,
  },pending:Object.values(value.commands||{}).some(c=>['registered','dispatched','accepted'].includes(c.status))
   ||Object.values(value.effects||{}).some(e=>!['succeeded','failed','cancelled'].includes(e.status))
   ||Object.values(value.downloads||{}).some(d=>!['completed','failed','released'].includes(d.status))};
 },statePrefix+client.browserTabId);
}

export async function idleDocument(page) {
 return page.evaluate(()=>{
  const visible=n=>!!n?.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
  const editor=document.querySelector('#prompt-textarea'),form=editor?.closest('form');
  if (!editor?.isContentEditable||!visible(editor)||!form||editor.textContent.trim()) return false;
  if (document.querySelector('[data-testid="stop-button"], [data-is-streaming="true"]')) return false;
  if ([...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')].some(visible)) return false;
  if ([...document.querySelectorAll('textarea,input:not([type="file"]),[contenteditable="true"]')]
   .some(n=>n!==editor&&visible(n)&&String(n.value??n.textContent??'').trim()
    &&(!n.matches('.writing-block-editor [contenteditable="true"]')
      ||!n.closest('[data-message-author-role="assistant"]')||n.contains(document.activeElement)))) return false;
  if ([...form.querySelectorAll('input[type="file"]')].some(n=>n.files?.length)) return false;
  return !form.querySelector('[role="group"][aria-label], [data-testid*="attachment"], [aria-busy="true"], [role="progressbar"]');
 });
}

// Native writing blocks are editable even when merely displaying an old answer.
// Preserve their current DOM text/markup before retiring the document, including
// possible changes not yet reflected in canonical history. Other editors block it.
export async function preserveWritingBlocks(page) {
 const blocks=await page.evaluate(()=>[...document.querySelectorAll('.writing-block-editor [contenteditable="true"]')]
  .filter(n=>n.closest('[data-message-author-role="assistant"]'))
  .map(n=>({messageId:n.closest('[data-message-id]')?.getAttribute('data-message-id'),text:n.textContent,html:n.innerHTML})));
 if(!blocks.length)return;
 const snapshot=JSON.stringify({url:page.url(),createdAt:new Date().toISOString(),blocks});
 if(Buffer.byteLength(snapshot)>2*1024*1024)throw Error('GPT_RECOVERY_SNAPSHOT_TOO_LARGE');
 mkdirSync('/data/recovery',{recursive:true,mode:0o700});
 writeFileSync('/data/recovery/writing-blocks-'+randomUUID()+'.json',snapshot,{mode:0o600,flag:'wx'});
}

function idleHealth(health) {
 const c=health?.activeClient;
 return health?.ok===true&&Array.isArray(health.activeRequests)&&health.activeRequests.length===0
  &&c?.ready===true&&c.pageReady===true&&c.tabObservation?.generation?.state==='stopped'
  &&c.tabObservation?.composer?.ready===true;
}

export function createTabRecovery({context,health,readLease=client=>readTabLease(context,client),
 documentIdle=idleDocument,preserveEditors=preserveWritingBlocks,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=20000}) {
 let pending=null,lastAttempt=-Infinity;
 const run=async()=>{
  const until=now()+timeoutMs;
  const first=await health(),client=first.activeClient;
  const state=await readLease(client);
  if (!state.known) throw Error('GPT_RECOVERY_UNVERIFIED');
  if (state.lease?.status!=='quarantined') return {recovered:false};
  const page=context.pages().find(p=>p.url()===client.url);
  const validUrl=()=>{try {const u=new URL(client.url);return u.origin==='https://chatgpt.com'&&!u.search&&!u.hash&&(/^\/(?:c\/[a-zA-Z0-9-]+)?\/?$/.test(u.pathname)||/^\/g\/g-p-[a-zA-Z0-9-]+(?:\/c\/[a-zA-Z0-9-]+)?\/?$/.test(u.pathname));}catch{return false}};
  if (!idleHealth(first)||!page||!validUrl()||state.contentEpoch!==client.contentEpoch
   ||state.pending||state.lease.quarantineReason!==cleanupTimeout||!await documentIdle(page)) throw Error('GPT_UI_ATTENTION');
  if (now()-lastAttempt<60000) throw Error('GPT_RECOVERY_UNVERIFIED');
  // Recheck immediately before retiring the old document. A new/manual request wins.
  const latest=await health(),current=await readLease(latest.activeClient);
  if (!idleHealth(latest)||latest.activeClient.id!==client.id||latest.activeClient.contentEpoch!==client.contentEpoch
   ||!current.known||current.pending||current.lease?.status!=='quarantined'
   ||current.lease.leaseId!==state.lease.leaseId||!await documentIdle(page)) throw Error('GPT_UI_ATTENTION');
  lastAttempt=now();
  await preserveEditors(page);
  const replacement=await context.newPage();
  const final=await health();
  if (now()>=until||!idleHealth(final)||final.activeClient.id!==client.id||!await documentIdle(page)) {
   if(replacement.url()==='about:blank')await replacement.close();
   throw Error('GPT_UI_ATTENTION');
  }
  try {
   // Closing a verified idle tab removes its quarantined runtime through the
   // extension's normal onRemoved cleanup; native history stays on ChatGPT.
   await page.close({runBeforeUnload:false});
   await replacement.goto(client.url,{waitUntil:'domcontentloaded',timeout:Math.max(1,until-now())});
   while(now()<until){
    const next=await health(),c=next.activeClient;
    if (idleHealth(next)&&c.browserTabId!==client.browserTabId&&c.url===client.url){
     const lease=await readLease(c);
     if (lease.known&&!lease.lease&&!lease.pending)return {recovered:true};
    }
    await sleep(200);
   }
   throw Error('GPT_RECOVERY_UNVERIFIED');
  }catch(error){
   // The replacement is retained for manual recovery. Never repeat navigation
   // or a prompt after a timeout, and never silently remove its possible draft.
   throw error;
  }
 };
 return ()=>{
  if (!pending) pending=run().finally(()=>{pending=null});
  return pending;
 };
}
