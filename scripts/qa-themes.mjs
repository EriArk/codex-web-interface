
import {chromium,webkit,expect} from "@playwright/test";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const credentials=JSON.parse(await readFile(".local/qa-credentials.json","utf8"));
await mkdir(".local/qa-themes",{recursive:true});
const report=[];
for(const [engine,type] of [["chromium",chromium],["webkit",webkit]]) {
 const browser=await type.launch({headless:true,...(engine==="chromium"?{args:["--no-sandbox"]}:{})});
 try {
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:8782/");
 await page.getByLabel("Пароль",{exact:true}).fill(credentials.password);
 await page.getByRole("button",{name:"Войти",exact:true}).click();
 await page.getByRole("textbox",{name:"Сообщение Codex"}).waitFor();
 await page.getByRole("navigation",{name:"Разделы рабочего пространства"}).getByRole("button",{name:"Чат",exact:true}).click();
 for(const [theme,label] of [["organizer","Органайзер"],["crt-green","Зелёный терминал"],["hitech-2000s","Hi-tech"]]) {
  await page.getByRole("button",{name:"Настройки",exact:true}).last().click();
  await page.locator('input[name="theme"]').nth(["organizer","crt-green","hitech-2000s"].indexOf(theme)).check();
  await page.getByRole("button",{name:"Закрыть настройки",exact:true}).click();
  for(const [width,height] of [[390,844],[375,667],[844,390],[820,1180],[1366,1024]]) {
   await page.setViewportSize({width,height});await page.waitForTimeout(100);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const composer=await page.locator(".composer").boundingBox();
   assert(composer&&composer.x>=0&&composer.x+composer.width<=width&&composer.y+composer.height<=height);
   const shot=engine+"-"+theme+"-"+width+"x"+height;
   await page.screenshot({path:".local/qa-themes/"+shot+".png"});
   report.push({engine,theme,width,height,composerVisible:true});
  }
  await page.setViewportSize({width:390,height:844});
 }
 await page.getByRole("button",{name:"Открыть проекты",exact:true}).click();
 await page.getByRole("navigation",{name:"Навигация по проектам"}).getByRole("button",{name:/Проекты/}).click();
 await page.screenshot({path:".local/qa-themes/"+engine+"-projects.png"});
 await page.locator(".project-sheet").getByRole("button",{name:"Новый проект",exact:true}).click();
 await page.getByLabel("Название проекта",{exact:true}).fill("Mobile project "+engine);
 await page.getByRole("button",{name:"Выбрать папку проекта",exact:true}).click();
 await page.getByRole("button",{name:"Выбрать эту папку",exact:true}).waitFor();
 await page.getByRole("button",{name:"Закрыть выбор папки",exact:true}).click();
 await page.screenshot({path:".local/qa-themes/"+engine+"-create-project.png"});
 await page.locator(".project-dialog").getByRole("button",{name:"Создать проект",exact:true}).click();
 await page.waitForFunction(name=>document.querySelector(".header-project")?.textContent.includes(name),"Mobile project "+engine);
 await page.getByRole("button",{name:"Открыть проекты",exact:true}).click();
 await page.getByRole("navigation",{name:"Навигация по проектам"}).getByRole("button",{name:/Проекты/}).click();
 await expect(page.locator(".project-sheet").getByRole("button",{name:new RegExp("Mobile project "+engine)})).toBeVisible();
 await page.getByRole("button",{name:"Закрыть проекты",exact:true}).click();
 assert.deepEqual(errors,[]);
 await context.close();
 }finally{await browser.close();}
}
await writeFile(".local/qa-themes/report.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({themeViewportChecks:report.length,browsers:["chromium","webkit"],projectCreation:true,folderPicker:true}));
