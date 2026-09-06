
import {chromium,webkit,expect} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const credentials=JSON.parse(await readFile(".local/qa-credentials.json","utf8"));
const reports=[];
for(const [engine,type] of [["chromium",chromium],["webkit",webkit]]) {
 console.log("PWA send: "+engine);
 const browser=await type.launch({headless:true,...(engine==="chromium"?{args:["--no-sandbox"]}:{})});
 try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:"allow"}),page=await context.newPage();
  await page.goto("http://127.0.0.1:8782/");
  await page.getByLabel("Пароль",{exact:true}).fill(credentials.password);
  await page.getByRole("button",{name:"Войти",exact:true}).click();
  await page.locator(".workspace").waitFor();
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
  const created=page.waitForResponse(r=>r.url().endsWith("/threads")&&r.request().method()==="POST");
  await page.getByRole("button",{name:"Создать диалог",exact:true}).click();
  assert.equal((await created).status(),200);
  await expect(page.locator(".header-project small")).toContainText("Новый диалог");
  await expect(page.locator(".chat-pane .empty-state h2")).toBeVisible();
  await expect(page.getByLabel("Модель Codex",{exact:true})).toBeEnabled();
  await page.getByRole("textbox",{name:"Сообщение Codex"}).fill("Проверка отправки с service worker");
  await page.getByRole("button",{name:"Отправить сообщение",exact:true}).click();
  await expect(page.getByRole("button",{name:"Отклонить",exact:true})).toBeVisible();
  await page.reload();
  await page.getByRole("button",{name:"Отклонить",exact:true}).click();
  await expect(page.locator(".turn-status")).toHaveCount(0);
  assert.equal(await page.getByRole("textbox",{name:"Сообщение Codex"}).inputValue(),"");
  reports.push({engine,serviceWorkerControlsPage:true,realHttpSendToQA:true,pendingApprovalAfterReload:true,simulatedCodex:true,physicalStandalonePWA:false});
 }finally{await browser.close();}
}
await writeFile(".local/qa-workflow/pwa.json",JSON.stringify(reports,null,2));console.log(JSON.stringify(reports));
