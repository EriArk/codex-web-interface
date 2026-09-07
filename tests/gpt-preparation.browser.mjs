import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { selectModels } from "../ops/gpt/browser-models.mjs";
import { sessionReady } from "../ops/gpt/browser-session.mjs";

const html = `<!doctype html><meta charset="utf-8"><form>
<div id="prompt-textarea" contenteditable="true"></div>
<button type="button" data-testid="composer-plus-btn" aria-haspopup="menu">Files</button>
<button id="open" type="button" aria-haspopup="menu">Model</button></form>
<div id="content" data-testid="composer-intelligence-picker-content" hidden>
<div role="menuitem" aria-expanded="false" id="toggle" tabindex="0" aria-label="Select model">Models</div>
<div role="menuitem" id="power" aria-describedby="power-label" aria-keyshortcuts="ArrowLeft ArrowRight" tabindex="0"><span role="slider" aria-valuenow="1" aria-valuemin="0" aria-valuemax="3"></span></div>
<span id="power-label">Standard, mode</span>
<div id="advanced" data-testid="composer-model-picker-slider-advanced-view" data-active="false" hidden>
<div role="menuitemradio" tabindex="0" aria-checked="true">Latest</div><div role="menuitemradio" tabindex="0" aria-checked="false">Previous</div>
</div></div>
<script>
window.effects=0;window.openings=0;
const content=document.querySelector('#content'),advanced=document.querySelector('#advanced'),toggle=document.querySelector('#toggle');
function view(open){advanced.hidden=!open;advanced.dataset.active=String(open);toggle.style.display=open?'none':'';toggle.setAttribute('aria-expanded',String(open));}
document.querySelector('#open').onclick=()=>{window.openings++;content.hidden=false;view(window.startAdvanced===true);window.startAdvanced=false;};
toggle.onclick=()=>{if(window.collapseNextToggle){window.collapseNextToggle=false;content.hidden=true;}else view(true);};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){content.hidden=true;view(false);}});
document.querySelector('#power').onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const slider=document.querySelector('[role=slider]');const n=Number(slider.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1);slider.setAttribute('aria-valuenow',String(n));document.querySelector('#power-label').textContent=['Light','Standard','High','Maximum'][n]+', mode';};
for(const radio of document.querySelectorAll('[role=menuitemradio]'))radio.onclick=()=>{for(const other of document.querySelectorAll('[role=menuitemradio]'))other.setAttribute('aria-checked',String(other===radio));};
document.querySelector('[data-testid=composer-plus-btn]').onclick=()=>window.effects++;
</script>`;
for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await type.launch(),
    page = await browser.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.route("https://chatgpt.com/**", (r) =>
      r.fulfill({ body: html, contentType: "text/html" }),
    );
    await page.goto("https://chatgpt.com/");
    assert(await sessionReady(page, null));
    await page.locator("#prompt-textarea").fill("unsent text");
    assert.equal(
      await sessionReady(page, null),
      false,
      "new-chat readiness must not accept a draft",
    );
    await page.locator("#prompt-textarea").fill("");
    await page.evaluate(() => {
      const message = document.createElement("div");
      message.dataset.messageAuthorRole = "user";
      document.body.append(message);
    });
    assert.equal(await sessionReady(page, null), false, "URL alone is not proof of an empty chat");
    await page.goto("https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc");
    assert(await sessionReady(page, "12345678-abcd-1234-abcd-123456789abc"));
    assert.equal(await sessionReady(page, "12345678-abcd-1234-abcd-000000000000"), false);
    assert.equal(await sessionReady(page, null), false);
    await page.evaluate(() => {
      const stop = document.createElement("button");
      stop.dataset.testid = "stop-button";
      document.body.append(stop);
    });
    assert.equal(await sessionReady(page, "12345678-abcd-1234-abcd-123456789abc"), false);
    await page.goto("https://chatgpt.com/");
    await page.evaluate(() => (window.startAdvanced = true));
    assert.deepEqual(await selectModels(page, { model: "Previous", effort: "2" }), {
      model: "Previous",
      effort: "2",
    });
    await expect(page.locator("#content")).not.toBeVisible();
    await page.evaluate(() => (window.collapseNextToggle = true));
    assert.deepEqual(await selectModels(page, { model: "Latest", effort: "3" }), {
      model: "Latest",
      effort: "3",
    });
    await expect(page.locator("#content")).not.toBeVisible();
    assert.equal(await page.evaluate(() => window.effects), 0);
    await assert.rejects(
      selectModels(page, { model: "Absent", effort: "2" }),
      /GPT_MODEL_UNAVAILABLE/,
    );
    await expect(page.locator("#content")).not.toBeVisible();
    console.log(
      JSON.stringify({
        browser: name,
        emptyChatProof: true,
        hiddenAdvancedToggle: true,
        menuRerenderRecovery: true,
        verifiedSettings: true,
      }),
    );
  } finally {
    await browser.close();
  }
}
