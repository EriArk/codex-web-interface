// Pinned lab controls. No arbitrary action, selector, code, URL or prompt input.
export async function nativeControl(request, read, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail = code => { throw Error(`NATIVE_${code}`); };
 if (!['selectConversation','inspectConversation','stopResponse'].includes(request?.operation)) fail('UNSUPPORTED_CONTROL');
 if (request.operation === 'stopResponse' && (typeof request.userMessageId !== 'string' || !request.userMessageId || request.userMessageId.length > 128)) fail('INVALID_REQUEST');
 const historyRequest = {operation:'readConversation',conversationId:request.conversationId,accountFingerprint:request.accountFingerprint};
 const identityBefore = await read({operation:'inspectAccount'},load,runtime);
 if (identityBefore.accountFingerprint !== request.accountFingerprint) fail('ACCOUNT_MISMATCH');
 const m = await load();
 if (!m.M9?.appActions?.runInPrimaryWindow) fail('INCOMPATIBLE');
 let deadline = Date.now() + 5000;
 const action = async action => {
  let timer;
  try { return await Promise.race([
   m.M9.appActions.runInPrimaryWindow({action}),
   new Promise((_,reject) => {timer=setTimeout(()=>reject(Error('NATIVE_CONTROL_TIMEOUT')),Math.max(1,deadline-Date.now()));}),
  ]); } finally { clearTimeout(timer); }
 };
 const summary = () => action({type:'app.get_summary'});
 const matches = state => {
  const w=state?.window,id=w?.thread?.id;
  if(request.conversationId===null)return state?.schemaVersion===1&&w?.route?.kind==='home'&&w.route.pathname==='/'&&!w.thread;
  if(state?.schemaVersion!==1||w?.route?.kind!=='chatgpt-thread'||w.thread?.kind!=='chatgpt'||w.route.threadId!==id)return false;
  if(id===request.conversationId)return true;
  return typeof id==='string'&&/^local-chatgpt:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)&&w.route.pathname===`/c/${request.conversationId}`;
 };
 const controls = () => {
  const visible = selector => [...runtime.document.querySelectorAll(selector)].filter(e=>e.getClientRects().length && !e.disabled);
  const editors=visible('[role="textbox"][contenteditable="true"]');
  const attachments=editors.flatMap(e=>[...(e.closest?.('[data-composer-body]')?.querySelectorAll('button[aria-label]')??[])])
   .filter(e=>/^Remove /.test(e.getAttribute('aria-label')??''));
  return {stop:visible('button[aria-label="Stop"]'), send:visible('button[aria-label="Send"]'),
   editors,attachments};
 };
 if (request.operation === 'selectConversation') {
  if(request.conversationId!==null)await read(historyRequest,load,runtime);
  deadline = Date.now() + 5000;
  // Do not navigate away from a nonempty native draft.
  const draft=controls();
  if (draft.editors.some(e=>e.textContent?.trim())||draft.attachments.length||draft.stop.length) fail('DRAFT_PRESENT');
  await action(request.conversationId===null?{type:'windows.show_home',windowId:'current'}:{type:'windows.show_thread',windowId:'current',kind:'chatgpt',threadId:request.conversationId});
  while (!matches(await summary())) {
   if (Date.now() >= deadline) fail('NAVIGATION_UNCONFIRMED');
   await new Promise(resolve=>setTimeout(resolve,100));
  }
 }
 if (!matches(await summary())) fail('SELECTED_CHAT_MISMATCH');
 // Recheck account identity after asynchronous native navigation/state requests.
 const identity = await read({operation:'inspectAccount'},load,runtime);
 if (identity.accountFingerprint !== request.accountFingerprint) fail('ACCOUNT_CHANGED');
 if(request.conversationId===null){
  if(request.operation==='stopResponse')fail('INVALID_REQUEST');
  const choices=[...runtime.document.querySelectorAll('button[aria-pressed]')].filter(e=>e.getClientRects().length&&e.textContent.trim()==='Chat');
  if(choices.length!==1||choices[0].getAttribute('aria-pressed')!=='true')fail('CHAT_MODE_REQUIRED');
 }
 if (request.operation === 'stopResponse') {
  // One fresh canonical read guards a newer send. State polling does not load history.
  const current = await read(historyRequest,load,runtime);
  if (current.messages.filter(message=>message.role === 'user').at(-1)?.id !== request.userMessageId) fail('TURN_MISMATCH');
  deadline = Date.now() + 5000;
  if (!matches(await summary())) fail('SELECTED_CHAT_MISMATCH');
  const ui = controls();
  if (ui.editors.length !== 1 || ui.stop.length !== 1) fail('STOP_UNAVAILABLE');
  ui.stop[0].click();
  // A click is an issued stop, not canonical completion. Caller must reconcile.
  return {conversationId:request.conversationId,userMessageId:request.userMessageId,stopIssued:true,confirmed:false};
 }
 const ui = controls();
 return {conversationId:request.conversationId,selected:true,composerReady:ui.editors.length === 1,
  hasDraft:ui.editors.some(e=>!!e.textContent?.trim())||ui.attachments.length>0,attachmentCount:ui.attachments.length,stopAvailable:ui.stop.length === 1,
  sendAvailable:ui.send.length === 1};
}
