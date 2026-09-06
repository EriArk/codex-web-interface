async function picker(page){
 const content=page.getByTestId('composer-intelligence-picker-content');
 if(!await content.isVisible()){
  const trigger=page.locator('form').filter({has:page.locator('#prompt-textarea')}).locator('button[aria-haspopup="menu"]:not([data-testid="composer-plus-btn"]):visible');
  await trigger.first().waitFor({state:'visible',timeout:10000});
  if(await trigger.count()!==1)throw Error('GPT_MODEL_TRIGGER_CHANGED');
  await trigger.click({timeout:5000});
 }
 await content.waitFor({state:'visible',timeout:5000});
 return content;
}
async function closePicker(page){
 const toggle=page.getByTestId('composer-intelligence-picker-content').locator('[role="menuitem"][aria-expanded="true"]');
 if(await toggle.count()===1)await toggle.click({timeout:1500}).catch(()=>{});
 await page.keyboard.press('Escape');
 await page.getByTestId('composer-intelligence-picker-content').waitFor({state:'hidden',timeout:3000});
}
async function readPower(content){
 const slider=content.locator('[role="slider"]');
 if(await slider.count()!==1)throw Error('GPT_POWER_PICKER_CHANGED');
 return slider.evaluate(node=>{
  const power=node.closest('[role="menuitem"]');
  const description=power?.getAttribute('aria-describedby')?.split(' ')[0];
  const label=(description?document.getElementById(description)?.textContent:'')?.split(',')[0]?.trim()||'';
  return {value:Number(node.getAttribute('aria-valuenow')),min:Number(node.getAttribute('aria-valuemin')),max:Number(node.getAttribute('aria-valuemax')),label};
 });
}
async function selectPower(content,value){
 let power=await readPower(content);
 if(!Number.isInteger(value)||value<power.min||value>power.max)throw Error('GPT_POWER_UNAVAILABLE');
 for(let attempt=0;attempt<8&&power.value!==value;attempt++){
  const current=power.value;
  await content.locator('[role="menuitem"][aria-keyshortcuts*="ArrowLeft"]').press(value<current?'ArrowLeft':'ArrowRight');
  await content.page().waitForFunction(previous=>{
   const slider=document.querySelector('[data-testid="composer-intelligence-picker-content"] [role="slider"]');
   return slider&&Number(slider.getAttribute('aria-valuenow'))!==previous;
  },current,{timeout:1800});
  power=await readPower(content);
 }
 if(power.value!==value)throw Error('GPT_POWER_NOT_CONFIRMED');
 return power;
}
async function openModels(content){
 const toggle=content.locator('[role="menuitem"][aria-expanded]');
 if(await toggle.count()!==1)throw Error('GPT_MODEL_TOGGLE_CHANGED');
 if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 await content.getByTestId('composer-model-picker-slider-advanced-view').waitFor({state:'visible',timeout:3000});
 return content.getByTestId('composer-model-picker-slider-advanced-view').getByRole('menuitemradio');
}
export async function readModels(page){
 const content=await picker(page);
 try{
  const initial=await readPower(content),efforts=[];
  try{
   for(let value=initial.min;value<=initial.max;value++){
    const power=await selectPower(content,value);
    efforts.push({id:String(value),label:power.label||String(value+1),selected:value===initial.value});
   }
  }finally{await selectPower(content,initial.value)}
  const options=await openModels(content);
  const models=await options.evaluateAll(nodes=>nodes.filter(node=>node.getAttribute("aria-disabled")!=="true").map(node=>({id:node.innerText.trim(),label:node.innerText.trim(),selected:node.getAttribute('aria-checked')==='true'})));
  if(!models.length||models.filter(m=>m.selected).length!==1)throw Error('GPT_MODEL_OPTIONS_CHANGED');
  return {ok:true,models,efforts,currentModel:models.find(m=>m.selected).id,currentEffort:String(initial.value)};
 }finally{await closePicker(page)}
}
export async function selectModels(page,{model,effort}){
 if(model){
  const content=await picker(page);
  try{
   const options=await openModels(content);
   const option=options.filter({hasText:model});
   const labels=await option.allInnerTexts();
   const index=labels.findIndex(label=>label.trim()===model);
   if(index<0)throw Error('GPT_MODEL_UNAVAILABLE');
   const target=option.nth(index);
   if(await target.getAttribute('aria-checked')!=='true')await target.click();
  }finally{await closePicker(page)}
 }
 if(effort!==undefined&&effort!==''){
  const content=await picker(page);
  try{await selectPower(content,Number(effort))}finally{await closePicker(page)}
 }
 // Verify the selected model without changing the power setting.
 const content=await picker(page);
 try{
  const power=await readPower(content),options=await openModels(content);
  const selected=await options.evaluateAll(nodes=>nodes.filter(n=>n.getAttribute('aria-checked')==='true').map(n=>n.innerText.trim()));
  if(selected.length!==1||(model&&selected[0]!==model)||(effort!==undefined&&effort!==''&&String(power.value)!==String(effort)))throw Error('GPT_SETTINGS_NOT_CONFIRMED');
  return {model:selected[0],effort:String(power.value)};
 }finally{await closePicker(page)}
}
