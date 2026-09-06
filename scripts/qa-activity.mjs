import { chromium, webkit, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const credentials=JSON.parse(await readFile(".local/qa-credentials.json","utf8")), origin="http://127.0.0.1:8782";
await mkdir(".local/qa-activity",{recursive:true});
const report=[];
for(const [engine,type] of [["chromium",chromium],["webkit",webkit]]) {
 if(process.env.QA_ENGINE && process.env.QA_ENGINE!==engine)continue;
 const browser=await type.launch({headless:true,...(engine==="chromium"?{args:["--no-sandbox"]}:{})});
 const errors=[];
 try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:"block"});
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
  const setup=(await(await context.request.get(origin+"/api/auth/status")).json()).requiresSetup;
  await page.goto(origin+(setup?"/#setup="+credentials.setupToken:"/"));
  await page.getByLabel(setup?"Придумай пароль":"Пароль",{exact:true}).fill(credentials.password);
  if(setup)await page.getByLabel("Повтори пароль",{exact:true}).fill(credentials.password);
  await page.getByRole("button",{name:setup?"Сохранить и войти":"Войти",exact:true}).click();
  await page.locator(".workspace").waitFor();
  const request=async(path,method="GET",data)=>{
   const session=await(await context.request.get(origin+"/api/auth/session")).json();
   const result=await context.request.fetch(origin+"/api"+path,{method,headers:{origin,"x-csrf-token":session.csrf,"idempotency-key":crypto.randomUUID()},...(data?{data}:{})});
   assert(result.ok(),path+" "+result.status()+" "+await result.text());return result.json();
  };
  const projects=(await request("/projects")).projects;
  const second=projects.find(p=>p.name==="Второй проект"),seed=projects.find(p=>!p.unassigned&&p.id!==second.id);
  const seedChat=(await request("/projects/"+seed.id+"/threads")).threads.find(t=>t.title==="Проверка мобильного интерфейса");
  const secondChat=(await request("/projects/"+second.id+"/threads")).threads[0];
  const nav=page.locator(".project-sheet");
  const openNav=async()=>{if(!await nav.isVisible())await page.getByRole("button",{name:"Открыть проекты",exact:true}).tap();};
  const choose=async(project,thread)=>{await openNav();await nav.getByRole("button",{name:/^Проекты /}).tap();const folder=nav.locator(`[data-project-id="${project.id}"]`);if(await folder.getAttribute("aria-expanded")!=="true")await folder.tap();await nav.locator(`[data-thread-id="${thread.id}"]`).tap();};
  await choose(second,secondChat);
  const input=page.getByRole("textbox",{name:"Сообщение Codex"});await expect(input).toBeEnabled();
  let documents=0;page.on("framenavigated",frame=>{if(frame===page.mainFrame())documents++;});
  await input.fill("Realtime QA "+engine);const sendResponse=page.waitForResponse(r=>r.url().endsWith("/threads/"+secondChat.id+"/turns")&&r.request().method()==="POST");await page.getByRole("button",{name:"Отправить сообщение",exact:true}).tap();const sent=await sendResponse;assert(sent.ok());const startedTurn=(await sent.json()).turnId;
  await expect(page.locator(".chat-scroll")).toContainText("Realtime: первая часть.");
  await expect(page.locator(".chat-scroll")).toContainText("Вторая часть пришла.");
  await expect(page.locator(".turn-status .spinner")).toBeVisible();
  await page.screenshot({path:`.local/qa-activity/${engine}-chat-running.png`});
  await page.locator(".mobile-tabs").getByRole("button",{name:/Результаты/}).tap();
  await expect(page.locator(".result-card").filter({hasText:"Изображение в реальном времени"}).first()).toBeVisible();
  assert.equal((await request("/threads/"+secondChat.id+"/history")).thread.status,"running","Results arrive before turn completion");
  assert.equal(documents,0,"Streaming and results require no page reload");
  await page.screenshot({path:`.local/qa-activity/${engine}-live-results.png`});
  await openNav();
  await expect(nav.locator(".nav-project").first()).toHaveAttribute("data-project-id",second.id);
  await expect(nav.locator(`[data-project-id="${second.id}"] .spinner`)).toBeVisible();
  await expect(nav.locator(`[data-thread-id="${secondChat.id}"] .spinner`)).toBeVisible();
  await page.screenshot({path:`.local/qa-activity/${engine}-projects-active.png`});
  await choose(seed,seedChat);
  await openNav();
  await expect.poll(async()=> (await request("/navigation")).threads.find(t=>t.id===secondChat.id)?.completedTurnId,{timeout:18000,intervals:[1000]}).toBe(startedTurn);
  await expect(nav.locator(`[data-project-id="${second.id}"] .is-unread`)).toBeVisible({timeout:16000});
  await expect(nav.locator(".nav-project").first()).toHaveAttribute("data-project-id",second.id);
  const other=await browser.newContext({viewport:{width:1366,height:1024},hasTouch:true,storageState:await context.storageState(),serviceWorkers:"block"});
  const tablet=await other.newPage();tablet.on("pageerror",e=>errors.push(e.message));await tablet.goto(origin);await tablet.locator(".workspace").waitFor();
  await expect(tablet.locator(`.desktop-nav [data-project-id="${second.id}"] .is-unread`)).toBeVisible();
  await page.reload();await page.locator(".workspace").waitFor();await openNav();
  await expect(nav.locator(`[data-project-id="${second.id}"] .is-unread`)).toBeVisible();
  await page.screenshot({path:`.local/qa-activity/${engine}-unread.png`});
  const tf=tablet.locator(`.desktop-nav [data-project-id="${second.id}"]`);if(await tf.getAttribute("aria-expanded")!=="true")await tf.click();
  await tablet.locator(`.desktop-nav [data-thread-id="${secondChat.id}"]`).click();
  try { await expect(nav.locator(`[data-project-id="${second.id}"] .is-unread`)).toHaveCount(0,{timeout:10000}); }
  catch(error) { await tablet.screenshot({path:`.local/qa-activity/${engine}-seen-failure.png`}); console.log(JSON.stringify({tablet:await tablet.evaluate(()=>({visibility:document.visibilityState,thread:document.querySelector(".header-project small")?.textContent,scroll:[document.querySelector(".chat-scroll")?.scrollTop,document.querySelector(".chat-scroll")?.scrollHeight,document.querySelector(".chat-scroll")?.clientHeight],errors:[...document.querySelectorAll(".notice")].map(el=>el.textContent)})),state:(await request("/navigation")).threads.find(t=>t.id===secondChat.id)}));throw error; }
  const seen=(await request("/navigation")).threads.find(t=>t.id===secondChat.id);assert.equal(seen.seenSeq,seen.completedSeq);
  // A wide image overlay covers Chat and must hold its read receipt until dismissed.
  await tablet.locator(".results-pane .screenshot-preview").first().click();
  await expect(tablet.getByRole("dialog",{name:"Просмотр снимка"})).toBeVisible();
  const overlayCaps=await request("/projects/"+second.id+"/capabilities");
  await request("/threads/"+secondChat.id+"/turns","POST",{text:"Realtime QA overlay "+engine,settings:overlayCaps.defaults});
  await expect.poll(async()=> (await request("/navigation")).threads.find(t=>t.id===secondChat.id).status,{timeout:18000,intervals:[1000]}).toBe("completed");
  const covered=(await request("/navigation")).threads.find(t=>t.id===secondChat.id);assert(covered.completedSeq>covered.seenSeq,"Covered chat stays unread");
  await tablet.getByRole("button",{name:"Закрыть снимок",exact:true}).click();
  await expect(nav.locator(`[data-project-id="${second.id}"] .is-unread`)).toHaveCount(0);
  // Hold an old result response across a thread switch; it must never replace the new feed.
  const seedFolder=tablet.locator(`.desktop-nav [data-project-id="${seed.id}"]`);if(await seedFolder.getAttribute("aria-expanded")!=="true")await seedFolder.click();
  const selectSeed=()=>tablet.locator(`.desktop-nav [data-thread-id="${seedChat.id}"]`).click();
  await selectSeed();await expect(tablet.locator(".header-project small")).toHaveText(seedChat.title);
  let release,hit;const held=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>hit=resolve);
  const oldResults=`**/api/threads/${secondChat.id}/results`;
  await tablet.route(oldResults,async route=>{const response=await route.fetch();const data=await response.json();hit();await held;await route.fulfill({response,json:{...data,items:data.items.map(item=>({...item,title:"STALE RESPONSE"}))}});});
  await tablet.locator(`.desktop-nav [data-thread-id="${secondChat.id}"]`).click();await requested;
  await selectSeed();await expect(tablet.locator(".header-project small")).toHaveText(seedChat.title);
  release();await tablet.unrouteAll({behavior:"wait"});
  await expect(tablet.locator(".results-pane")).not.toContainText("STALE RESPONSE");
  await other.close();
  // Standalone activity contributes only to the Dialogs tab.
  const standalone=projects.find(p=>p.unassigned),single=(await request("/projects/"+standalone.id+"/threads")).threads[0];
  const caps=await request("/projects/"+standalone.id+"/capabilities");
  await request("/threads/"+single.id+"/turns","POST",{text:"Realtime QA standalone "+engine,settings:caps.defaults});
  await nav.getByRole("button",{name:/^Диалоги /}).tap();
  await expect(nav.locator(".standalone-thread-list .nav-thread").first()).toHaveAttribute("data-thread-id",single.id);
  await expect(nav.locator(`[data-thread-id="${single.id}"] .spinner`)).toBeVisible();
  await expect(nav.locator(`[data-thread-id="${single.id}"] .is-unread`)).toBeVisible({timeout:16000});
  await page.screenshot({path:`.local/qa-activity/${engine}-dialogs-unread.png`});
  // Scrollback must not acknowledge new completion; then recover text/results after offline.
  await choose(seed,seedChat);await page.locator(".chat-scroll").evaluate(el=>{el.scrollTop=0;});
  const seedCaps=await request("/projects/"+seed.id+"/capabilities");
  await request("/threads/"+seedChat.id+"/turns","POST",{text:"Realtime QA offline "+engine,settings:seedCaps.defaults});
  await expect(page.locator(".turn-status .spinner")).toBeVisible();
  await context.setOffline(true);
  await new Promise(resolve=>setTimeout(resolve,11500));
  await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event("online")));
  await expect(page.locator(".chat-scroll")).toContainText("Вторая часть пришла. Готово.",{timeout:20000});
  const unread=(await request("/navigation")).threads.find(t=>t.id===seedChat.id);assert(unread.completedSeq>unread.seenSeq,"Scrollback remains unread");
  await page.locator(".chat-scroll").evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect.poll(async()=>{const t=(await request("/navigation")).threads.find(t=>t.id===seedChat.id);return t.seenSeq===t.completedSeq;}).toBe(true);
  await page.locator(".mobile-tabs").getByRole("button",{name:/Результаты/}).tap();
  await expect(page.locator(".result-card").filter({hasText:"Изображение в реальном времени"}).first()).toBeVisible();
  await openNav();
  for(const theme of ["organizer","crt-green","hitech-2000s"]){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:`.local/qa-activity/${engine}-${theme}.png`});}
  assert.deepEqual(errors,[]);
  report.push({engine,streamedTextBeforeCompletion:true,liveResultsBeforeCompletion:true,activeProjectsFirst:true,unreadSurvivesReload:true,crossDeviceSeen:true,standaloneCounts:true,offlineReplay:true,scrollbackStaysUnread:true,pageErrors:errors});
  await context.close();console.log(engine+": activity/realtime passed");
 } finally {await browser.close();}
}
await writeFile(".local/qa-activity/report.json",JSON.stringify(report,null,2));
