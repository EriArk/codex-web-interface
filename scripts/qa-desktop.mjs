import {chromium,webkit,expect} from "@playwright/test";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const credentials=JSON.parse(await readFile(".local/qa-credentials.json","utf8")),origin="http://127.0.0.1:8782";
await mkdir(".local/qa-desktop",{recursive:true});const report=[];
for(const [engine,type] of [["chromium",chromium],["webkit",webkit]]){
 const browser=await type.launch({headless:true,...(engine==="chromium"?{args:["--no-sandbox"]}:{})});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:"block"});
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
  let active=0,known=true,restarts=0,forces=0,client="web",operation=null,finish=false;
  await page.route("**/api/machines",async route=>{
   const response=await route.fetch(),data=await response.json();data.machines[0].desktopRestartAvailable=true;
   await route.fulfill({response,json:data});
  });
  await page.route("**/api/machines/*/desktop",async route=>{
   if(finish && operation)operation={...operation,state:"completed",code:"DESKTOP_RESTARTED"};
   await route.fulfill({json:{available:true,running:true,activityKnown:known,activeTasks:active,operation,client}});
  });
  await page.route("**/api/machines/*/desktop/restart",async route=>{
   assert.equal(route.request().method(),"POST");assert.equal(route.request().postDataJSON().confirm,true);
   assert(route.request().headers()["x-csrf-token"]);restarts++;
   operation={id:route.request().headers()["idempotency-key"],kind:"restart",state:"restarting",code:"",requestedAt:Date.now()/1000};
   await route.fulfill({json:{available:true,running:true,activityKnown:true,activeTasks:0,operation}});
  });
  await page.route("**/api/machines/*/client",async route=>{assert(route.request().headers()["x-csrf-token"]);client=route.request().postDataJSON().client;await route.fulfill({json:{client}});});
  await page.route("**/api/machines/*/desktop/force-restart",async route=>{assert.equal(route.request().postDataJSON().confirmStopTasks,true);forces++;client="desktop";operation={id:route.request().headers()["idempotency-key"],kind:"forcerestart",state:"completed",code:"DESKTOP_RESTARTED",requestedAt:Date.now()/1000};await route.fulfill({json:{available:true,running:true,activityKnown:false,activeTasks:0,operation,client}});});
  const setup=(await(await context.request.get(origin+"/api/auth/status")).json()).requiresSetup;
  await page.goto(origin+(setup?"/#setup="+credentials.setupToken:"/"));
  await page.getByLabel(setup?"Придумай пароль":"Пароль",{exact:true}).fill(credentials.password);
  if(setup)await page.getByLabel("Повтори пароль",{exact:true}).fill(credentials.password);
  await page.getByRole("button",{name:setup?"Сохранить и войти":"Войти",exact:true}).tap();
  await page.locator(".workspace").waitFor();
  const open=async()=>{await page.locator('button[aria-label="Настройки"]').tap();await page.locator(".settings-dialog[open]").waitFor();};
  await open();const dialog=page.locator(".settings-dialog");
  const restart=dialog.getByRole("button",{name:"Перезапустить Codex",exact:true});
  await expect(restart).toBeEnabled();
  await restart.tap();await dialog.getByRole("button",{name:"Отмена",exact:true}).tap();assert.equal(restarts,0);
  for(const [theme,label] of [["organizer","Органайзер"],["crt-green","Зелёный терминал"],["hitech-2000s","Hi-Tech 2000s"]]){
   await dialog.locator(".theme-option."+theme).tap();
   await expect(dialog.locator(".usage-limits")).toContainText("75% осталось");
   await dialog.locator(".usage-limits").scrollIntoViewIfNeeded();
   await page.screenshot({path:".local/qa-desktop/"+engine+"-"+theme+"-limits.png"});
   await restart.scrollIntoViewIfNeeded();
   await page.screenshot({path:".local/qa-desktop/"+engine+"-"+theme+"-phone.png"});
   assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  }
  await restart.tap();await dialog.getByRole("button",{name:"Да, перезапустить",exact:true}).tap();
  await expect(dialog.getByRole("button",{name:"Перезапускаю…",exact:true})).toBeDisabled();
  await page.reload();await page.locator(".workspace").waitFor();await open();
  await expect(dialog.getByRole("button",{name:"Перезапускаю…",exact:true})).toBeDisabled();
  assert.equal(restarts,1);finish=true;
  await expect(dialog.getByRole("status")).toContainText("Codex снова открыт",{timeout:10000});
  active=1;await expect(restart).toBeDisabled({timeout:10000});
  await expect(dialog.locator(".desktop-control")).toContainText("Активных задач: 1");
  active=0;known=false;await expect(dialog.locator(".desktop-control")).toContainText("Проверка задач недоступна",{timeout:10000});
  await expect(restart).toBeDisabled();
  known=true;await expect(restart).toBeEnabled({timeout:10000});
  await page.setViewportSize({width:1366,height:1024});await page.screenshot({path:".local/qa-desktop/"+engine+"-tablet.png"});
  assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await dialog.getByRole("button",{name:"Работать с компьютера",exact:true}).tap();
  await expect(dialog.getByRole("button",{name:"Продолжить на сайте",exact:true})).toBeVisible();
  await page.reload();await page.locator(".workspace").waitFor();await open();
  await dialog.getByRole("button",{name:"Продолжить на сайте",exact:true}).tap();
  await expect(dialog.getByRole("button",{name:"Работать с компьютера",exact:true})).toBeVisible();
  known=false;active=2;await expect(restart).toBeDisabled({timeout:10000});
  const hard=dialog.getByRole("button",{name:"Жёстко перезапустить Codex",exact:true});
  await expect(hard).toBeEnabled();await hard.tap();
  await dialog.getByRole("button",{name:"Отмена",exact:true}).tap();assert.equal(forces,0);
  await hard.tap();await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:".local/qa-desktop/"+engine+"-hard-confirm.png"});
  await dialog.getByRole("button",{name:"Остановить и перезапустить",exact:true}).tap();
  await expect(dialog.getByRole("button",{name:"Продолжить на сайте",exact:true})).toBeVisible();
  assert.equal(forces,1);assert.deepEqual(errors,[]);
  report.push({engine,confirmation:true,cancelHasNoEffect:true,oneRestart:true,handoff:true,forceConfirmed:true,reloadTracksOperation:true,activeBlocked:true,unknownBlocked:true,phoneAndTablet:true,allThemes:true,pageErrors:errors});
 }finally{await browser.close();}
}
await writeFile(".local/qa-desktop/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
