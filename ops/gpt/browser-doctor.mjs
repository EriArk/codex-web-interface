// Diagnostic evidence never reads or serializes user text, URLs, cookies or raw DOM.
export const evidenceStyle=`
*,*::before,*::after { color:transparent!important; -webkit-text-fill-color:transparent!important; text-shadow:none!important; caret-color:transparent!important; background-image:none!important; }
img,svg,canvas,video,iframe,object,embed,input,textarea,[contenteditable],article,[data-message-author-role],nav,aside,[role="navigation"],[data-testid*="profile"],[data-testid*="account"] { visibility:hidden!important; }
`;
export async function doctorObstruction(page){
 return page.evaluate(()=>{
  const visible=n=>!!n.getClientRects().length;
  const rows=[...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]')].filter(n=>visible(n)&&!n.closest('article,[data-message-author-role]'));
  if(!rows.length)return 'clear';
  for(const row of rows){
   if([...row.querySelectorAll('input,textarea,[contenteditable="true"]')].some(visible))return 'owner';
   const label=[...row.querySelectorAll('h1,h2,h3,[role="heading"]')].map(n=>n.innerText).join(' ')||row.getAttribute('aria-label')||(row.innerText||'').slice(0,1500);
   if(/sign.?in|log.?in|verify|authentication|payment|billing|checkout|privacy|consent|terms|cookie|войти|вход|подтверд|оплат|конфиденц|согласи|услови|куки/i.test(label))return 'owner';
  }
  return 'unknown';
 });
}
export async function captureDoctorEvidence(page){
 if(await doctorObstruction(page)==='owner')return {kind:'omitted',reason:'OWNER_FLOW'};
 const size=page.viewportSize();
 if(size&&(size.width>1920||size.height>1440))return {kind:'omitted',reason:'VIEWPORT_LIMIT'};
 // All text and personal/media regions are hidden, including text inside unknown overlays.
 // Borders, spacing and control geometry remain useful for selector/layout diagnostics.
 try{
  const bytes=await page.screenshot({type:'png',fullPage:false,animations:'disabled',style:evidenceStyle,timeout:5000});
  if(bytes.length>1024*1024)return {kind:'omitted',reason:'SIZE_LIMIT'};
  return {kind:'redacted-layout',mime:'image/png',base64:bytes.toString('base64')};
 }catch{return {kind:'omitted',reason:'CAPTURE_UNAVAILABLE'};}
}
