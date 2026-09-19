import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const native = nativeWorkspaceFixture(),
    origin = "http://127.0.0.1:18941";
  let writes=0,checks=0;
  native.client.libraryMutation=async(r,check)=>{
    if(check){checks++;return {state:'completed',name:'Before',projectId:null};}
    writes++;throw Error('NATIVE_TIMEOUT');
  };
  const f = await handoffFixture(origin, undefined, { nativeGpt: native.workspace });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18941, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript((id) => {
      localStorage.setItem("codex-client", "gpt");
      localStorage.setItem("gpt-conversation", id);
    }, native.conversationId);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const composer = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(composer).toBeVisible();
    await expect(page.getByText("Первый ответ", { exact: true })).toBeVisible();
    await page.getByRole('button',{name:'Открыть проекты',exact:true}).click();
    await page.getByRole('button',{name:'Действия: Native workspace fixture',exact:true}).first().click();
    const dialog=page.locator('dialog.entity-dialog');
    await dialog.getByRole('button',{name:'Переименовать',exact:true}).click();
    await dialog.getByRole('textbox',{name:'Название'}).fill('After');
    await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
    await expect(dialog.getByRole('button',{name:'Проверить результат',exact:true})).toBeVisible();
    await page.reload();
    await expect(composer).toBeVisible();
    await page.getByRole('button',{name:'Открыть проекты',exact:true}).click();
    await page.getByRole('button',{name:'Действия: Native workspace fixture',exact:true}).first().click();
    await expect(page.getByRole('button',{name:'Проверить результат',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Проверить результат',exact:true}).click();
    await expect(dialog).not.toBeVisible();
    assert.equal(writes,1);assert.equal(checks,1);
    assert.deepEqual(errors, []);
    console.log(engine+': native library lost ack and page reload recover read-only through shared menu');
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
