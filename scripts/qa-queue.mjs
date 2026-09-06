import {chromium,webkit,expect} from "@playwright/test";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const credentials=JSON.parse(await readFile(".local/qa-credentials.json","utf8")),origin="http://127.0.0.1:8782";
await mkdir(".local/qa-queue",{recursive:true});const report=[];
for(const [engine,type] of [["chromium",chromium],["webkit",webkit]]){
 console.log("Queue browser: "+engine);
 const browser=await type.launch({headless:true,...(engine==="chromium"?{args:["--no-sandbox"]}:{})});
 try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:"block"});
 const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
 const setup=(await(await context.request.get(origin+"/api/auth/status")).json()).requiresSetup;
 await page.goto(origin+(setup?"/#setup="+credentials.setupToken:"/"));
 await page.getByLabel(setup?"Придумай пароль":"Пароль",{exact:true}).fill(credentials.password);
 if(setup)await page.getByLabel("Повтори пароль",{exact:true}).fill(credentials.password);
 await page.getByRole("button",{name:setup?"Сохранить и войти":"Войти",exact:true}).tap();await page.locator(".workspace").waitFor();
 const session=await(await context.request.get(origin+"/api/auth/session")).json();
 const request=async(path,method="GET",data)=>{
  const r=await context.request.fetch(origin+"/api"+path,{method,headers:{origin,"x-csrf-token":session.csrf,"idempotency-key":crypto.randomUUID()},...(data?{data}:{})});
  assert(r.ok(),path+" "+await r.text());return r.json();
 };
 const project=(await request("/projects")).projects.find(p=>!p.unassigned);
 const thread=await request("/projects/"+project.id+"/threads","POST",{title:"Queue QA "+engine});
 await request("/preferences","PATCH",{projectId:project.id,threadId:thread.id,theme:"organizer",view:"chat"});
 await page.reload();await page.locator(".workspace").waitFor();
 await page.getByRole("button",{name:"Открыть проекты",exact:true}).tap();
 const nav=page.locator(".project-sheet"),folder=nav.locator('[data-project-id="'+project.id+'"]');
 if(await folder.getAttribute("aria-expanded")!=="true")await folder.tap();
 await nav.locator('[data-thread-id="'+thread.id+'"]').tap();
 await expect(page.locator(".header-project small")).toHaveText("Queue QA "+engine);
 const input=page.getByRole("textbox",{name:"Сообщение Codex"});
 await input.fill("Queue QA initial "+engine);
 await page.getByRole("button",{name:"Отправить сообщение",exact:true}).tap();
 await expect(page.locator(".turn-status .spinner")).toBeVisible();
 const add=async(text)=>{
  await input.fill(text);
  await expect(page.getByRole("button",{name:"Добавить в очередь",exact:true})).toBeEnabled({timeout:12000});
  await page.getByRole("button",{name:"Добавить в очередь",exact:true}).tap();
  await expect(input).toHaveValue("");
  await expect(page.locator(".queue-item").filter({hasText:text})).toBeVisible();
 };
 await add("Queue QA delete this");
 await add("Queue QA edit this");
 const editedId=await page.locator(".queue-item").filter({hasText:"Queue QA edit this"}).getAttribute("data-queue-id");
 let edited=page.locator(`[data-queue-id="${editedId}"]`);
 await edited.getByRole("button",{name:"Изменить сообщение",exact:true}).tap();
 await edited.getByRole("textbox",{name:"Изменить сообщение в очереди",exact:true}).fill("Queue QA edited steer");
 await edited.getByRole("button",{name:"Сохранить",exact:true}).tap();
 edited=page.locator(".queue-item").filter({hasText:"Queue QA edited steer"});await expect(edited).toBeVisible();
 await page.locator(".queue-item").filter({hasText:"Queue QA delete this"}).getByRole("button",{name:"Удалить сообщение из очереди"}).tap();
 await expect(page.locator(".queue-item")).toHaveCount(1);
 await page.reload();await page.locator(".workspace").waitFor();
 await expect(page.locator(".queue-item")).toContainText("Queue QA edited steer");
 const second=await browser.newContext({viewport:{width:1366,height:1024},storageState:await context.storageState(),serviceWorkers:"block"});
 const tablet=await second.newPage();await tablet.goto(origin);await tablet.locator(".workspace").waitFor();
 await expect(tablet.locator(".queue-item")).toContainText("Queue QA edited steer");
 await page.screenshot({path:`.local/qa-queue/${engine}-phone.png`});
 await tablet.screenshot({path:`.local/qa-queue/${engine}-tablet.png`});
 await page.locator(".queue-item").getByRole("button",{name:/Steer/}).tap();
 await expect(page.locator(".queue-item")).toHaveCount(0);
 await expect(tablet.locator(".queue-item")).toHaveCount(0);
 await expect(page.locator(".message.user").filter({hasText:"Queue QA edited steer"})).toHaveCount(1);
 await add("Queue QA automatic next");
 await expect(page.locator(".message.user").filter({hasText:"Queue QA automatic next"})).toHaveCount(1,{timeout:35000});
 await expect(page.locator(".queue-item")).toHaveCount(0);
 await expect.poll(async()=>(await request("/threads/"+thread.id+"/history")).thread.status,{timeout:8000}).toBe("completed");
 for(const theme of ["crt-green","hitech-2000s"]){
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
  await page.screenshot({path:`.local/qa-queue/${engine}-${theme}.png`});
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 assert.deepEqual(errors,[]);
 report.push({engine,addEditDelete:true,reloadAndCrossDevice:true,steerOnce:true,automaticNext:true,mobileAndTablet:true,pageErrors:errors});
 await second.close();await context.close();
 }finally{await browser.close();}
}
await writeFile(".local/qa-queue/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
