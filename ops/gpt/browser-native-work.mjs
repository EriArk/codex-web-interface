/** Public UI capabilities only. No message text, credentials, hidden state or signed URLs. */
export async function nativeFeatures(page) {
  if(new URL(page.url()).origin!=='https://chatgpt.com')return {ready:false};
  return page.evaluate(()=>{
    const visible=n=>!!n.getClientRects().length;
    const action=n=>n.getAttribute('aria-label')||n.getAttribute('title')||'';
    const names=[...document.querySelectorAll('button')].filter(visible).map(action).filter(s=>/^(?:edit|retry|try again|regenerate|previous|next|start voice|canvas|tasks|редактир|повтор|предыду|следую|голос|задач)/i.test(s)).map(s=>s.slice(0,80)).slice(0,30);
    const messages=[...document.querySelectorAll('[data-message-author-role]')].slice(-40).map(n=>({id:/^[a-zA-Z0-9_-]{1,100}$/.test(n.getAttribute('data-message-id')||'')?n.getAttribute('data-message-id'):null,role:['user','assistant'].includes(n.getAttribute('data-message-author-role'))?n.getAttribute('data-message-author-role'):null}));
    return {ready:true,generating:!!document.querySelector('[data-testid="stop-button"]'),voice:names.some(s=>/^start voice$/i.test(s)),actions:[...new Set(names)],messages};
  });
}

const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export async function nativeConversation(page, id) {
  if(!identifier.test(id)||new URL(page.url()).origin!=='https://chatgpt.com')throw Error('GPT_NATIVE_SOURCE');
  return page.evaluate(async id=>{
    const session=await(await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(10000)})).json();
    if(typeof session.accessToken!=='string')throw Error('GPT_LOGIN_REQUIRED');
    const response=await fetch('/backend-api/conversation/'+encodeURIComponent(id),{credentials:'include',cache:'no-store',headers:{authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('GPT_NATIVE_READ');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8*1024*1024)throw Error('GPT_NATIVE_SIZE');chunks.push(part.value);}}
    finally{await reader.cancel();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  },id);
}

/** One exact native click. Anything after dispatch is uncertain until canonical history confirms it. */
export async function operateMessage(page, input) {
  let dispatched=false,editing=false,section;
  try{
    if(!input||!['edit','regenerate'].includes(input.action)||![input.conversationId,input.messageId,input.currentNode].every(v=>typeof v==='string'&&identifier.test(v)))throw Error('GPT_NATIVE_INPUT');
    if(input.action==='edit'&&(typeof input.text!=='string'||!input.text.trim()||input.text.length>100000))throw Error('GPT_NATIVE_INPUT');
    const url=new URL(page.url());
    if(url.origin!=='https://chatgpt.com'||!url.pathname.endsWith('/c/'+input.conversationId))throw Error('GPT_NATIVE_SELECTION');
    if(await page.locator('[data-testid="stop-button"]').count())throw Error('GPT_BUSY');
    const source=await nativeConversation(page,input.conversationId);
    if(source.current_node!==input.currentNode)throw Error('GPT_NATIVE_CHANGED');
    const entries=Object.entries(source.mapping??{}),found=entries.find(([,v])=>v?.message?.id===input.messageId);
    if(!found||found[1].message.author?.role!==(input.action==='edit'?'user':'assistant'))throw Error('GPT_NATIVE_SOURCE');
    let cursor=source.current_node;const seen=new Set();
    while(cursor&&cursor!==found[0]&&!seen.has(cursor)){seen.add(cursor);cursor=source.mapping[cursor]?.parent;}
    if(cursor!==found[0])throw Error('GPT_NATIVE_CHANGED');
    const message=page.locator('[data-message-id="'+input.messageId+'"]');
    if(await message.count()!==1)throw Error('GPT_NATIVE_NOT_VISIBLE');
    const turn=await message.evaluate(n=>n.closest('section[data-turn-id]')?.getAttribute('data-turn-id'));
    if(!/^[a-zA-Z0-9_.:-]{1,200}$/.test(turn||''))throw Error('GPT_NATIVE_NOT_VISIBLE');
    section=page.locator('section[data-turn-id="'+turn+'"]');
    if(await section.count()!==1)throw Error('GPT_NATIVE_NOT_VISIBLE');
    await message.hover({timeout:4000});
    if(input.action==='edit'){
      await section.getByRole('button',{name:/^(Edit message|Редактировать сообщение)$/i}).click({timeout:4000});editing=true;
      const editor=section.locator('textarea:visible');
      await editor.waitFor({state:'visible',timeout:4000});
      if(await editor.count()!==1)throw Error('GPT_NATIVE_EDITOR');
      await editor.fill(input.text,{timeout:4000});
      const submit=section.getByRole('button',{name:/^(Send|Отправить)$/i});
      if(await submit.count()!==1||!await submit.isEnabled())throw Error('GPT_NATIVE_EDITOR');
      dispatched=true;
      await submit.click({timeout:4000});
    }else{
      await section.getByRole('button',{name:/^(Switch model|Сменить модель)$/i}).click({timeout:4000});
      const retry=page.getByRole('menuitem',{name:/^(Try again(?:\s|•)|Попробовать ещё раз|Повторить)/i});
      await retry.waitFor({state:'visible',timeout:4000});
      if(await retry.count()!==1||!await retry.isEnabled())throw Error('GPT_NATIVE_RETRY');
      dispatched=true;
      await retry.click({timeout:4000});
    }
    return {ok:true,dispatched:true};
  }catch(error){
    if(!dispatched){
      if(editing&&section)await section.getByRole('button',{name:/^(Cancel|Отмена)$/i}).click({timeout:1000}).catch(()=>{});
      else await page.keyboard.press('Escape').catch(()=>{});
    }
    const code=['GPT_NATIVE_INPUT','GPT_NATIVE_SOURCE','GPT_NATIVE_CHANGED','GPT_NATIVE_SELECTION','GPT_NATIVE_NOT_VISIBLE','GPT_NATIVE_EDITOR','GPT_NATIVE_RETRY','GPT_BUSY'].includes(error?.message)?error.message:'GPT_NATIVE_UNAVAILABLE';
    return {ok:false,dispatched,code};
  }
}
