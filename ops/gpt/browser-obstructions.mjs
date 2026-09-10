// Runs only in the private ChatGPT document. Never inspect conversation content.
export function dialogState(target = false) {
 const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
 const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')]
  .filter(node => visible(node) && !node.closest('[data-message-author-role], article'));
 if (!dialogs.length) return target ? null : 'clear';
 // A nested/second dialog or an editable form needs the owner's attention.
 if (dialogs.length !== 1) return target ? null : 'attention';
 const dialog = dialogs[0];
 if ([...dialog.querySelectorAll('input, textarea, [contenteditable="true"]')].some(visible)) return target ? null : 'attention';
 const text = (dialog.innerText || '').slice(0, 4000);
 const heading = [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')].map(n => n.innerText).join(' ') || dialog.getAttribute('aria-label') || text.slice(0, 200);
 const sensitive = /sign in|log in|verify|verification|authentication|payment|billing|checkout|delete|privacy|consent|terms|cookie|войти|вход|подтверд|оплат|удал|конфиденц|согласи|услови|куки/i;
 const promotion = /what.?s new|introducing|new in chatgpt|try (?:the |our )?(?:new |chatgpt|voice|codex)|upgrade (?:your|to)|discover (?:what|the|new)|meet (?:the |your |gpt)|get more (?:with|from)|give feedback|help us improve|новое в chatgpt|что нового|представляем|попробуйте|попробовать|новые возможности|оцените|помогите нам улучшить/i;
 if (sensitive.test(heading) || !promotion.test(heading)) return target ? null : 'attention';
 const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible).filter(n => {
  const label = (n.getAttribute('aria-label') || n.innerText || n.getAttribute('title') || '').trim();
  return !n.disabled && n.getAttribute('aria-disabled') !== 'true' && /^(?:close|dismiss|not now|maybe later|no thanks|skip|закрыть|не сейчас|позже|нет,? спасибо|пропустить)$/i.test(label);
 });
 const button = buttons[0];
 return target ? button || null : button ? 'promotion' : 'attention';
}
export async function inspectObstructions(page) {
 return page.evaluate(dialogState);
}
export async function dismissPromotions(page) {
 for (let attempt = 0; attempt < 2; attempt++) {
  const state = await inspectObstructions(page);
  if (state === 'clear') return;
  if (state !== 'promotion') throw Error('GPT_UI_ATTENTION');
  const handle = await page.evaluateHandle(dialogState, true);
  try {
   const button = handle.asElement();
   if (!button) continue;
   await button.click({timeout:1500});
   await page.waitForTimeout(120);
  } finally { await handle.dispose(); }
 }
 if (await inspectObstructions(page) !== 'clear') throw Error('GPT_UI_ATTENTION');
}
