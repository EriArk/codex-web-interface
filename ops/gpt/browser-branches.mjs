import {nativeConversation} from './browser-native-work.mjs';
import {selectModels} from './browser-models.mjs';
const id=/^[a-zA-Z0-9_-]{1,100}$/;
/** Native version previews are read-only; continuing explicitly creates a new native chat. */
export async function forkNativeVersion(page,input){
 let dispatched=false,modal,target;
 try{
  if(!input||![input.conversationId,input.currentNode,input.messageId,input.targetMessageId].every(v=>typeof v==='string'&&id.test(v)))throw Error('GPT_NATIVE_INPUT');
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>100000||typeof input.model!=='string'||input.model.length>120||!/^\d$/.test(input.effort))throw Error('GPT_NATIVE_INPUT');
  if(new URL(page.url()).origin!=='https://chatgpt.com'||!new URL(page.url()).pathname.endsWith('/c/'+input.conversationId))throw Error('GPT_NATIVE_SELECTION');
  const source=await nativeConversation(page,input.conversationId);
  if(source.current_node!==input.currentNode)throw Error('GPT_NATIVE_CHANGED');
  if(await page.locator('[data-testid="stop-button"]').count())throw Error('GPT_BUSY');
  const message=page.locator('[data-message-id="'+input.messageId+'"]');
  if(await message.count()!==1)throw Error('GPT_NATIVE_NOT_VISIBLE');
  const turn=await message.evaluate(n=>n.closest('section[data-turn-id]')?.getAttribute('data-turn-id'));
  if(!/^[a-zA-Z0-9_.:-]{1,200}$/.test(turn||''))throw Error('GPT_NATIVE_NOT_VISIBLE');
  await message.hover({timeout:4000});
  await page.locator('section[data-turn-id="'+turn+'"]').getByTestId('variants-turn-action-button').click({timeout:4000});
  modal=page.getByTestId('modal-conversation-turn-variants');await modal.waitFor({state:'visible',timeout:4000});
  await modal.locator('[data-message-id]').first().waitFor({state:'visible',timeout:4000});
  const signature=()=>modal.locator('[data-message-id]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-message-id')).join(','));
  const step=async direction=>{
   const button=modal.getByRole('button',{name:direction==='previous'?/^(Previous version|Предыдущая версия)$/i:/^(Next version|Следующая версия)$/i});
   if(await button.count()!==1||!await button.isEnabled())return false;
   const before=await signature();await button.click({timeout:3000});
   for(let i=0;i<30;i++){if(await signature()!==before)return true;await new Promise(r=>setTimeout(r,100));}
   throw Error('GPT_NATIVE_VERSION');
  };
  for(let i=0;i<40;i++){if(!await step('previous'))break;if(i===39)throw Error('GPT_NATIVE_VERSION');}
  let found=false;
  for(let i=0;i<40;i++){
   if(await modal.locator('[data-message-id="'+input.targetMessageId+'"]').count()===1){found=true;break;}
   if(!await step('next'))break;
  }
  if(!found)throw Error('GPT_NATIVE_VERSION');
  const button=modal.getByRole('button',{name:/^(Branch to a new chat|Ветвление в новом чате|Создать ветку в новом чате)$/i});
  if(await button.count()!==1||!await button.isEnabled())throw Error('GPT_NATIVE_VERSION');
  const before=new Set(page.context().pages());
  dispatched=true;await button.click({timeout:4000});
  for(let i=0;i<50;i++){
   const candidates=page.context().pages().filter(p=>!before.has(p)&&p.url().startsWith('https://chatgpt.com/c/'));
   if(candidates.length>1)throw Error('GPT_NATIVE_SELECTION');
   if(candidates.length===1){target=candidates[0];break;}
   await new Promise(r=>setTimeout(r,100));
  }
  if(!target)throw Error('GPT_NATIVE_SELECTION');
  await target.locator('[data-message-id="'+input.targetMessageId+'"]').waitFor({state:'visible',timeout:10000});
  await target.bringToFront();
  await selectModels(target,{model:input.model,effort:input.effort});
  const editor=target.locator('#prompt-textarea');
  if((await editor.innerText()).trim())throw Error('GPT_NATIVE_EDITOR');
  await editor.fill(input.text,{timeout:4000});
  const send=target.getByTestId('send-button');
  if(await send.count()!==1||!await send.isEnabled())throw Error('GPT_NATIVE_EDITOR');
  await send.click({timeout:4000});
  await target.waitForURL(url=>url.origin==='https://chatgpt.com'&&/\/c\/([a-zA-Z0-9_-]{1,100})$/.test(url.pathname),{timeout:10000});
  const nativeId=new URL(target.url()).pathname.match(/\/c\/([a-zA-Z0-9_-]{1,100})$/)?.[1];
  // A confirmed destination replaces the idle source browser tab, not its saved conversation.
  if(nativeId&&nativeId!==input.conversationId)await page.close().catch(()=>{});
  return {ok:true,dispatched:true,nativeId};
 }catch(error){
  if(!dispatched&&modal)await modal.getByRole('button',{name:/^(Close|Закрыть)$/i}).click({timeout:1000}).catch(()=>{});
  return {ok:false,dispatched,code:['GPT_NATIVE_INPUT','GPT_NATIVE_SELECTION','GPT_NATIVE_CHANGED','GPT_BUSY','GPT_NATIVE_NOT_VISIBLE','GPT_NATIVE_VERSION'].includes(error?.message)?error.message:'GPT_NATIVE_UNAVAILABLE'};
 }
}
