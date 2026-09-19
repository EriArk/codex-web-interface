// Explicit disposable-chat laboratory operations, never a production send API.
// Keep self-contained for execution inside the pinned renderer.
export async function nativeComposer(request, read, load = () => import('app://-/assets/app-initial-430deae5a13a.js'), runtime = globalThis) {
 const fail=code=>{throw Error(`NATIVE_${code}`);};
 const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
 const operations=['prepareNewChat','inspectDraft','stageText','stageFiles','submitDraft','inspectCreatedChat','confirmCreatedChat'];
 if(!operations.includes(request?.operation)||request.disposable!==true)fail('LAB_ONLY');
 if(!uuid(request.key)||!/^[a-f0-9]{64}$/.test(request.accountFingerprint??''))fail('INVALID_REQUEST');
 const stateKey=Symbol.for('codex-web.native-draft'),lockKey=Symbol.for('codex-web.native-composer');
 if(runtime[lockKey])fail('COMPOSER_BUSY');runtime[lockKey]=true;
 const deadline=Date.now()+12000;
 const bounded=async promise=>{
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NATIVE_COMPOSER_TIMEOUT')),Math.max(1,deadline-Date.now()));})]);}
  finally{clearTimeout(timer);}
 };
 const visible=e=>e.getClientRects().length&&!e.closest('[inert],[hidden],[aria-hidden="true"]');
 const all=s=>[...runtime.document.querySelectorAll(s)].filter(visible);
 const identity=async()=>{
  if(Date.now()>deadline)fail('COMPOSER_TIMEOUT');
  if((await bounded(read({operation:'inspectAccount'},load,runtime))).accountFingerprint!==request.accountFingerprint)fail('ACCOUNT_CHANGED');
 };
 let m;
 const summary=()=>bounded(m.M9.appActions.runInPrimaryWindow({action:{type:'app.get_summary'}}));
 const home=s=>s?.schemaVersion===1&&s.window?.route?.kind==='home'&&s.window.route.pathname==='/'&&!s.window.thread;
 const ui=()=>{
  const editors=all('[role="textbox"][contenteditable="true"]');
  if(editors.length!==1)fail('COMPOSER_UNAVAILABLE');
  const editor=editors[0],body=editor.closest('[data-composer-body]');
  if(!body)fail('COMPOSER_UNAVAILABLE');
  // File/image removal controls can be hover-hidden: their presence still means
  // a draft exists. Inspect only the composer, not old message attachments.
  const files=[...body.querySelectorAll('button[aria-label]')].filter(e=>/^Remove /.test(e.getAttribute('aria-label')??''));
  const stops=all('button[aria-label="Stop"]');
  const send=all('button[aria-label="Send"]');
  return {editor,body,files,stops,send};
 };
 const isChat=()=>{
  const buttons=all('button[aria-pressed]').filter(e=>e.textContent.trim()==='Chat');
  return buttons.length===1&&buttons[0].getAttribute('aria-pressed')==='true';
 };
 const guarded=async()=>{
  await identity();const s=await summary();await identity();
  const lease=runtime[stateKey];
  if(!lease||lease.key!==request.key||lease.accountFingerprint!==request.accountFingerprint)fail('DRAFT_LEASE_MISSING');
  if(!home(s)||!isChat())fail('NEW_CHAT_CHANGED');
  const c=ui();if(c.editor!==lease.editor||c.stops.length)fail('DRAFT_CHANGED');
  return {lease,c};
 };
 const fileNames=c=>c.files.map(e=>e.getAttribute('aria-label').slice(7)).sort();
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 try{
  await identity();m=await bounded(load());
  if(!m.M9?.appActions?.runInPrimaryWindow)fail('INCOMPATIBLE');
  if(request.operation==='prepareNewChat'){
   if(runtime[stateKey])fail('DRAFT_LEASE_EXISTS');
   const c=ui();if(c.editor.textContent.trim()||c.files.length||c.stops.length)fail('DRAFT_PRESENT');
   await bounded(m.M9.appActions.runInPrimaryWindow({action:{type:'windows.show_home',windowId:'current'}}));
   let s;
   do{await new Promise(r=>setTimeout(r,60));await identity();s=await summary();}while(!home(s)&&Date.now()<deadline);
   if(!home(s))fail('NAVIGATION_UNCONFIRMED');
   const h=ui();if(h.editor.textContent.trim()||h.files.length||h.stops.length)fail('DRAFT_PRESENT');
   // Do not silently switch Work to Chat or enter a project-specific composer.
   if(!isChat())fail('CHAT_MODE_REQUIRED');
   runtime[stateKey]={key:request.key,accountFingerprint:request.accountFingerprint,editor:h.editor,text:'',files:[],submitted:false};
   return {prepared:true,key:request.key};
  }
  if(['inspectCreatedChat','confirmCreatedChat'].includes(request.operation)){
   const lease=runtime[stateKey];
   if(!lease||lease.key!==request.key||lease.accountFingerprint!==request.accountFingerprint||!lease.submitted)fail('SUBMISSION_MISSING');
   const s=await summary();await identity();
   const id=s.window?.thread?.id,path=s.window?.route?.pathname;
   const candidate=typeof path==='string'&&/^\/c\/([a-f0-9-]+)$/i.exec(path)?.[1];
   if(s.schemaVersion!==1||s.window?.thread?.kind!=='chatgpt'||s.window.route?.kind!=='chatgpt-thread'||s.window.route.threadId!==id||!uuid(candidate)||
      !(id===candidate||(typeof id==='string'&&id.startsWith('local-chatgpt:')&&uuid(id.slice(14)))))fail('CREATION_UNCONFIRMED');
   // Newly created native chats retain a local client ID while their native
   // route already contains the canonical server UUID. Never persist that alias
   // as confirmed until fresh server history matches the exact intended prompt.
   if(request.operation==='inspectCreatedChat')return {conversationId:candidate,clientConversationId:id,confirmed:false,key:request.key};
   const history=await bounded(read({operation:'readConversation',conversationId:candidate,accountFingerprint:request.accountFingerprint},load,runtime));
   const users=history.messages.filter(m=>m.role==='user');
   if(history.conversationId!==candidate||history.before||users.length!==1||users[0].text!==lease.text||
      users[0].hasAttachments!==(lease.files.length>0))fail('CREATION_UNCONFIRMED');
   // Confirms submission and native identity, not answer completion or media
   // byte fidelity. The disposable real proof separately checks file contents.
   return {conversationId:candidate,userMessageId:users[0].id,confirmed:true,key:request.key};
  }
  const {lease,c}=await guarded();
  if(lease.submitted)fail('ALREADY_DISPATCHED');
  if(c.editor.textContent!==lease.text||!same(fileNames(c),lease.files.map(f=>f.name).sort()))fail('DRAFT_CHANGED');
  if(request.operation==='stageText'){
   if(lease.text||typeof request.text!=='string'||!request.text.includes(request.key)||request.text!==request.text.trim()||request.text.length>16000)fail('INVALID_DRAFT');
   c.editor.focus();
   if(!runtime.document.execCommand('insertText',false,request.text))fail('TEXT_UNCONFIRMED');
   if(c.editor.textContent!==request.text)fail('TEXT_UNCONFIRMED');
   lease.text=request.text;
  } else if(request.operation==='stageFiles'){
   if(lease.files.length||!Array.isArray(request.files)||request.files.length<1||request.files.length>4)fail('INVALID_FILES');
   const inputs=[...runtime.document.querySelectorAll('input[type="file"][aria-label="Attach files"]')];
   if(inputs.length!==1||inputs[0].disabled)fail('FILE_INPUT_UNAVAILABLE');
   let total=0;const names=new Set(),files=[];
   for(const f of request.files){
    if(!f||typeof f.name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.(txt|png)$/.test(f.name)||names.has(f.name)||
       f.type!==(f.name.endsWith('.png')?'image/png':'text/plain')||typeof f.base64!=='string'||f.base64.length>1400000||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)||
       !/^[a-f0-9]{64}$/.test(f.sha256??''))fail('INVALID_FILES');
    const bytes=Uint8Array.from(runtime.atob(f.base64),ch=>ch.charCodeAt(0));
    total+=bytes.length;if(!bytes.length||total>1024*1024)fail('FILES_TOO_LARGE');
    const digest=await runtime.crypto.subtle.digest('SHA-256',bytes);
    if(Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')!==f.sha256)fail('FILE_HASH_MISMATCH');
    names.add(f.name);files.push(new runtime.File([bytes],f.name,{type:f.type}));
   }
   // Hashing yields; revalidate the account, empty file set, text and DOM lease.
   const next=await guarded();if(next.c.editor.textContent!==lease.text||next.c.files.length)fail('DRAFT_CHANGED');
   const transfer=new runtime.DataTransfer();for(const f of files)transfer.items.add(f);
   inputs[0].files=transfer.files;
   // Preserve an upload intention before change. An unknown upload is never
   // repeated automatically, even if no attachment chip appears before timeout.
   lease.files=request.files.map(({name,sha256})=>({name,sha256}));
   inputs[0].dispatchEvent(new runtime.Event('change',{bubbles:true}));
   return {staged:true,ready:false,fileCount:files.length,key:request.key};
  } else if(request.operation==='submitDraft'){
   if(!lease.text||request.text!==lease.text||!same(request.files,lease.files)||request.intentPersisted!==true)fail('DISPATCH_INTENT_REQUIRED');
   if(c.send.length!==1||c.send[0].disabled||c.send[0].getAttribute('aria-disabled')==='true')fail('SEND_UNAVAILABLE');
   // Lab supervisor persists intent first. This flag prevents a second click in
   // this renderer; process loss stays unknown in the supervisor's durable file.
   lease.submitted=true;c.send[0].click();
   return {dispatched:true,confirmed:false,key:request.key};
  }
  const fresh=ui();
  return {key:request.key,textMatches:fresh.editor.textContent===lease.text,
   fileCount:fresh.files.length,filesMatch:same(fileNames(fresh),lease.files.map(f=>f.name).sort()),
   sendReady:fresh.send.length===1&&!fresh.send[0].disabled&&fresh.send[0].getAttribute('aria-disabled')!=='true'};
 } finally{delete runtime[lockKey];}
}
