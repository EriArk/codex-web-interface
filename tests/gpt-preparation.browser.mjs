import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { inspectComposer, readConnectorHealth } from "../ops/gpt/browser-health.mjs";
import { selectModels } from "../ops/gpt/browser-models.mjs";
import { dismissPromotions, inspectObstructions } from "../ops/gpt/browser-obstructions.mjs";
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
    let authenticated = false;
    await page.route("https://chatgpt.com/api/auth/session", (route) =>
      route.fulfill({ json: authenticated ? { accessToken: "fixture-token" } : {} }),
    );
    const connector = {
      health: async () => ({
        ok: true,
        activeRequests: [],
        activeClient: {
          url: page.url(),
          ready: true,
          pageReady: true,
          compatible: true,
          extensionProtocolVersion: 5,
          compatibility: { bridgeVersion: "6.3.14" },
          capabilities: {
            promptInput: true,
            fileUpload: true,
            modelSelection: true,
            effortSelection: true,
          },
        },
      }),
      pages: () => [page],
      privateState: { permissions: true, locked: true },
    };
    assert.equal((await readConnectorHealth(connector)).state, "login_required");
    assert.equal(
      (await readConnectorHealth({ ...connector, pages: () => [] })).state,
      "starting",
      "temporary missing tab is not a logout",
    );
    authenticated = true;
    assert.equal((await readConnectorHealth(connector)).state, "healthy");
    assert.deepEqual(await inspectComposer(page), {
      composer: true,
      attachments: true,
      models: true,
      generating: false,
    });
    await page.locator("#open").evaluate((node) => node.removeAttribute("aria-haspopup"));
    assert.equal((await inspectComposer(page)).models, false);
    await page.locator("#open").evaluate((node) => node.setAttribute("aria-haspopup", "menu"));
    await page.locator("[data-testid=composer-plus-btn]").evaluate((node) => (node.hidden = true));
    assert.equal((await inspectComposer(page)).attachments, false);
    await page.locator("[data-testid=composer-plus-btn]").evaluate((node) => (node.hidden = false));
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
    await page.evaluate(() => {
      for (const radio of document.querySelectorAll("[role=menuitemradio]"))
        radio.onclick = () => {};
    });
    await assert.rejects(
      selectModels(page, { model: "Previous", effort: "2" }),
      /GPT_SETTINGS_NOT_CONFIRMED/,
    );
    await page.goto("https://chatgpt.com/");
    const showDialog = async (heading, extra = "") =>
      page.evaluate(
        ({ heading, extra }) => {
          document.querySelector("dialog")?.remove();
          const d = document.createElement("dialog");
          d.innerHTML = `<h2>${heading}</h2>${extra}<button aria-label="Close" type="button">×</button><button type="button">Try now</button>`;
          d.querySelector('[aria-label="Close"]').onclick = () => {
            window.dismissed = (window.dismissed || 0) + 1;
            d.remove();
          };
          d.lastElementChild.onclick = () => window.effects++;
          document.body.append(d);
          d.showModal();
        },
        { heading, extra },
      );
    await showDialog("What's new in ChatGPT");
    assert.equal(await inspectObstructions(page), "promotion");
    assert.equal(
      (await readConnectorHealth(connector)).state,
      "healthy",
      "read-only status does not dismiss a recognized optional promo",
    );
    assert.equal(await page.evaluate(() => window.dismissed || 0), 0);
    await selectModels(page, { model: "Previous", effort: "2" });
    assert.equal(await page.evaluate(() => window.dismissed), 1);
    assert.equal(await inspectObstructions(page), "clear");
    assert.equal(await page.evaluate(() => window.effects), 0, "never accept an offer");
    for (const heading of [
      "Verify your identity",
      "Delete conversation?",
      "Privacy preferences",
      "Introducing new payment terms",
      "Unknown notice",
    ]) {
      await showDialog(heading);
      assert.equal((await readConnectorHealth(connector)).state, "attention");
      await assert.rejects(dismissPromotions(page), /GPT_UI_ATTENTION/);
      await expect(page.locator("dialog")).toBeVisible();
    }
    await showDialog("What's new in ChatGPT", "<textarea>owner draft</textarea>");
    await assert.rejects(dismissPromotions(page), /GPT_UI_ATTENTION/);
    await page.locator("dialog").evaluate((d) => d.remove());
    await page.evaluate(() => {
      const m = document.createElement("article");
      m.dataset.messageAuthorRole = "assistant";
      m.innerHTML =
        '<div role="dialog"><h2>What is new in ChatGPT</h2><button aria-label="Close">Close</button></div>';
      m.querySelector("button").onclick = () => window.effects++;
      document.body.append(m);
    });
    await dismissPromotions(page);
    assert.equal(
      await page.evaluate(() => window.effects),
      0,
      "message content cannot supply a dismiss target",
    );
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
