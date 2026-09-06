import {chromium,webkit,expect} from "@playwright/test";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const credentials=JSON.parse(await readFile(".local/qa-credentials.json","utf8")),origin="http://127.0.0.1:8782";
await mkdir(".local/qa-access",{recursive:true});const report=[];
for(const [engine,type] of [["chromium",chromium],["webkit",webkit]]){
 console.log("Checking",engine);
 const browser=await type.launch({headless:true,...(engine==="chromium"?{args:["--no-sandbox"]}:{})});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:"block"});
  const marker="Image queue "+engine+" "+Date.now();
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
  const changes=[];page.on("request",r=>{if(r.method()==="PATCH"&&/\/api\/threads\/[^/]+\/settings$/.test(r.url()))changes.push(r.postDataJSON());});
  const setup=(await(await context.request.get(origin+"/api/auth/status")).json()).requiresSetup;
  await page.goto(origin+(setup?"/#setup="+credentials.setupToken:"/"));
  await page.getByLabel(setup?"Придумай пароль":"Пароль",{exact:true}).fill(credentials.password);
  if(setup)await page.getByLabel("Повтори пароль",{exact:true}).fill(credentials.password);
  await page.getByRole("button",{name:setup?"Сохранить и войти":"Войти",exact:true}).tap();
  await page.locator(".workspace").waitFor();
  await expect(page.locator(".task-boundary").first()).toBeAttached();
  const picker=page.getByLabel("Доступ Codex",{exact:true});
  await expect(picker).toBeEnabled();await picker.selectOption("full");
  await expect(picker).toBeEnabled();await expect(picker).toHaveValue("full");
  assert(changes.some(v=>v.access==="full"));
  await page.reload();await expect(picker).toHaveValue("full");await expect(picker).toBeEnabled();
  const swipe=async({selector=".workspace",x=18,y=350,dx=110,dy=0,multi=false,cancel=false}={})=>{
   await page.locator(selector).first().evaluate((el,p)=>{
    const create=(x,y,id=1)=>({identifier:id,target:el,clientX:x,clientY:y,pageX:x,pageY:y});
    let touches=[create(p.x,p.y)];if(p.multi)touches.push(create(p.x+5,p.y+20,2));
    const emit=(type,t,changed=t)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:t},targetTouches:{value:t},changedTouches:{value:changed}});return el.dispatchEvent(event);};
    emit("touchstart",touches);touches=[create(p.x+p.dx,p.y+p.dy)];if(p.multi)touches.push(create(p.x+p.dx+5,p.y+p.dy+20,2));
    emit("touchmove",touches);emit(p.cancel?"touchcancel":"touchend",[],touches);
   },{x,y,dx,dy,multi,cancel});
  };
  const closed=async()=>expect(page.locator(".project-sheet[open]")).toHaveCount(0);
  const close=async()=>{await page.getByRole("button",{name:"Закрыть проекты",exact:true}).tap();await closed();};
  for(const args of [{x:80},{dx:35},{dx:-80},{dx:10,dy:100},{multi:true},{cancel:true},{selector:"textarea",x:18}]){
   await swipe(args);await closed();
  }
  await swipe();await page.locator(".project-sheet[open]").waitFor();await close();
  await page.getByRole("button",{name:"Открыть проекты",exact:true}).tap();await page.locator(".project-sheet[open]").waitFor();await close();
  await page.getByRole("button",{name:"Remote",exact:true}).tap();await swipe();await closed();
  await page.getByRole("button",{name:"Чат",exact:true}).tap();
  for(const theme of ["organizer","crt-green","hitech-2000s","classic-dark"]){
   await page.getByRole("button",{name:"Настройки",exact:true}).tap();
   await page.locator(".theme-option."+theme).tap();
   await swipe();await closed();
   await page.getByRole("button",{name:"Закрыть настройки",exact:true}).tap();
   for(const [size,width,height] of [["phone",390,844],["small",375,667],["landscape",844,390],["tablet",1366,1024]]){
    await page.setViewportSize({width,height});await expect(picker).toBeVisible();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const box=await picker.boundingBox();assert(box&&box.width>=44&&box.height>=44);
    await page.screenshot({path:".local/qa-access/"+engine+"-"+theme+"-"+size+".png"});
   }
   await swipe();await closed();
   await page.setViewportSize({width:390,height:844});
  }
  await picker.selectOption("workspace");await expect(picker).toBeEnabled();
  await page.reload();await expect(picker).toHaveValue("workspace");
  await page.getByLabel("Сообщение Codex",{exact:true}).fill("Queue QA initial access");
  await page.getByRole("button",{name:"Отправить сообщение",exact:true}).tap();
  await expect(page.getByRole("button",{name:"Остановить Codex",exact:true})).toBeVisible();
  const toggle=page.getByRole("button",{name:"Ход работы",exact:true});
  await expect(page.locator(".chat-pane > .pane-heading")).toHaveCount(0);
  await expect(page.locator(".header-connection > span:last-child")).not.toContainText("Codex работает");
  await expect(toggle).toHaveAttribute("aria-expanded","false");await toggle.tap();
  const details=page.getByRole("region",{name:"Ход работы",exact:true});
  await expect(details).toContainText("Проверяю входные данные.",{timeout:10000});
  await expect(details).toContainText("Команда");
  assert.equal(await details.locator("details[open]").count(),0);
  await page.screenshot({path:".local/qa-access/"+engine+"-turn-details.png"});
  await expect(details).toHaveCount(1);
  const toggleBox=await toggle.boundingBox(),chevronBox=await toggle.locator(".details-chevron").boundingBox();
  assert(chevronBox.y>=toggleBox.y&&chevronBox.y+chevronBox.height<=toggleBox.y+toggleBox.height);
  await toggle.tap();await expect(details).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded","false");
  await expect(picker).toBeEnabled();await picker.selectOption("full");await expect(picker).toBeEnabled();
  await page.screenshot({path:".local/qa-access/"+engine+"-active.png"});
  await page.getByLabel("Выбрать файлы или изображения",{exact:true}).setInputFiles({name:"test.png",mimeType:"image/png",buffer:await page.screenshot()});
  await expect(page.locator(".composer .attachment")).toHaveCount(1);
  const text=page.getByLabel("Сообщение Codex",{exact:true}),enqueue=page.getByRole("button",{name:"Добавить в очередь",exact:true});
  await text.fill(marker);
  let failed=false,release;
  const held=new Promise(r=>release=r);
  const failRoute=async route=>{if(route.request().method()==="POST"&&!failed){failed=true;await held;await route.fulfill({status:503,json:{error:{code:"UPLOAD_TRANSFER_TIMEOUT",message:"Не успели передать вложение на компьютер. Сообщение не отправлено; текст и файлы сохранены. Попробуй снова."}}});}else await route.continue();};
  await page.route("**/api/threads/*/queue",failRoute);
  await enqueue.tap();
  await expect(page.getByRole("button",{name:"Остановить Codex",exact:true})).toBeEnabled();
  await expect(page.locator(".turn-status")).toContainText("Передаём сообщение");
  release();await expect(enqueue).toBeEnabled();await expect(text).toHaveValue(marker);
  await expect(page.locator(".composer .attachment")).toHaveCount(1);
  await page.unroute("**/api/threads/*/queue",failRoute);
  await enqueue.tap();await expect(text).toHaveValue("");
  const item=page.locator(".queue-item").filter({hasText:marker});
  await item.waitFor();await item.getByRole("button",{name:/Steer/}).tap();
  await expect(item).toContainText("Принято");
  await page.screenshot({path:".local/qa-access/"+engine+"-accepted-steer.png"});
  await expect(page.locator(".chat-content .message.user").filter({hasText:marker})).toBeVisible({timeout:10000});
  await expect(item).toHaveCount(0);
  await page.getByRole("button",{name:"Остановить Codex",exact:true}).tap();
  await page.locator(".task-boundary").last().scrollIntoViewIfNeeded();
  await page.screenshot({path:".local/qa-access/"+engine+"-task-boundary.png"});
  const directMarker="Queue QA image send "+engine+" "+Date.now();
  await text.fill(directMarker);
  await page.getByLabel("Выбрать файлы или изображения",{exact:true}).setInputFiles({name:"photo.png",mimeType:"image/png",buffer:await page.screenshot()});
  await expect(page.locator(".composer .attachment")).toHaveCount(1);
  let failSend=true,releaseSend;const sendHeld=new Promise(r=>releaseSend=r),keys=[];
  const directRoute=async route=>{
   if(route.request().method()!=="POST")return route.continue();
   keys.push(route.request().headers()["idempotency-key"]);
   if(failSend){failSend=false;await sendHeld;return route.fulfill({status:503,json:{error:{code:"UPLOAD_TRANSFER_TIMEOUT",message:"Не успели передать вложение на компьютер. Сообщение не отправлено; текст и файлы сохранены. Попробуй снова."}}});}
   return route.continue();
  };
  await page.route("**/api/threads/*/turns",directRoute);
  const send=page.getByRole("button",{name:"Отправить сообщение",exact:true});
  await send.tap();await expect(page.locator(".turn-status")).toContainText("Передаём вложения");
  releaseSend();
  await expect(send).toBeEnabled();await expect(text).toHaveValue(directMarker);
  await expect(page.locator(".composer .attachment")).toHaveCount(1);
  await expect(page.locator(".send-error")).toContainText("Сообщение не отправлено");
  await page.screenshot({path:".local/qa-access/"+engine+"-image-send-retry.png"});
  await send.tap();await expect(text).toHaveValue("");
  await expect(page.locator(".composer .attachment")).toHaveCount(0);
  await expect(page.locator(".chat-content .message.user").filter({hasText:directMarker})).toHaveCount(1);
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
  await page.unroute("**/api/threads/*/turns",directRoute);
  await expect(send).toBeVisible();
  assert.deepEqual(errors,[]);
  report.push({engine,accessPersists:true,standardRestored:true,activeDefaultChange:true,edgeSwipe:true,gestureGuards:true,hamburger:true,themes:4,sizes:4,pageErrors:errors});
 }finally{await browser.close();}
}
await writeFile(".local/qa-access/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
