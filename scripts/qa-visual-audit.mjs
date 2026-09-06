
import {webkit,expect} from "@playwright/test";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
const credentials=JSON.parse(await readFile(".local/qa-credentials.json","utf8"));
const origin="http://127.0.0.1:8782",out=".local/qa-visual";
await mkdir(out,{recursive:true});
const browser=await webkit.launch({headless:true}),report=[];
try {
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:"block"});
 const page=await context.newPage();
 let theme="organizer";
 const shot=async(name)=>{
   await page.waitForTimeout(150); // visualViewport and ResizeObserver settle after rotation.
   await page.evaluate(()=>document.fonts.ready);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+" page overflow");
   const viewport=page.viewportSize(),path=out+"/"+theme+"-"+name+".png";
   await page.screenshot({path});
   report.push({theme,screen:name,...viewport,path});
 };
 await page.goto(origin);
 await shot("login");
 await page.getByLabel("Пароль",{exact:true}).fill(credentials.password);
 await page.getByRole("button",{name:"Войти",exact:true}).click();
 await page.locator(".workspace").waitFor();
 // Simulate only the Remote transport/display. Never operate the owner's desktop.
 await page.addScriptTag({url:origin+"/vendor/guacamole-1.6.0.min.js"});
 await page.evaluate(()=>{
  const G=window.Guacamole,Original=G.Client;
  G.Client=Object.assign(function(){
   const canvas=document.createElement("canvas");canvas.width=1920;canvas.height=1080;
   const ctx=canvas.getContext("2d");ctx.fillStyle="#153b42";ctx.fillRect(0,0,1920,1080);
   ctx.fillStyle="#234e54";ctx.fillRect(280,140,1300,780);ctx.fillStyle="#b6d8d5";
   ctx.font="32px sans-serif";ctx.fillText("Remote — visual test display",330,210);
   for(let i=0;i<8;i++){ctx.fillStyle=i%2?"#3c646a":"#527a7d";ctx.fillRect(330,260+i*64,900-i*45,18);}
   const display={getElement:()=>canvas,getWidth:()=>1920,getHeight:()=>1080,scale:v=>{canvas.style.transformOrigin="0 0";canvas.style.transform="scale("+v+")";},showCursor:()=>{},flatten:()=>canvas,flush:cb=>cb()};
   const client={getDisplay:()=>display,sendMouseState:()=>{},sendKeyEvent:()=>{},connect:()=>queueMicrotask(()=>{client.onstatechange?.(3);display.onresize?.();client.onsync?.();}),disconnect:()=>client.onstatechange?.(5)};
   return client;
  },Original);
 });
 const nav=page.getByRole("navigation",{name:"Разделы рабочего пространства"});
 for(const current of ["organizer","crt-green","hitech-2000s"]){
  theme=current;console.log("Visual audit: "+theme);
  await page.setViewportSize({width:390,height:844});
  await page.getByRole("button",{name:"Настройки",exact:true}).last().click();
  await page.locator('input[name="theme"]').nth(["organizer","crt-green","hitech-2000s"].indexOf(theme)).check();
  await shot("settings");
  await page.getByRole("button",{name:"Закрыть настройки",exact:true}).click();
  await page.getByRole("button",{name:"Открыть проекты",exact:true}).click();
  const sheet=page.locator(".project-sheet");
  await sheet.getByRole("button",{name:/^Проекты /}).click();
  const project=sheet.locator(".nav-project").filter({hasText:"CodexWeb"}).or(sheet.locator(".nav-project").filter({hasText:"Codex Web Interface"})).first();
  if(await project.getAttribute("aria-expanded")!=="true")await project.click();
  await shot("projects");
  await sheet.getByRole("button",{name:/^Диалоги /}).click();
  await shot("standalone");
  await sheet.getByRole("button",{name:/^Проекты /}).click();
  await sheet.getByRole("button",{name:"Новый проект",exact:true}).click();
  await shot("new-project");
  await page.getByRole("button",{name:"Выбрать папку проекта",exact:true}).click();
  await page.getByRole("button",{name:"Выбрать эту папку",exact:true}).waitFor();
  await shot("folder-picker");
  await page.getByRole("button",{name:"Закрыть выбор папки",exact:true}).click();
  await page.getByRole("button",{name:"Закрыть создание проекта",exact:true}).click();
  await page.getByRole("button",{name:"Открыть проекты",exact:true}).click();
  await sheet.getByRole("button",{name:"Проверка мобильного интерфейса",exact:true}).click();
  await page.getByLabel("Модель Codex",{exact:true}).waitFor();
  await shot("chat");
  const options=await page.locator(".composer-option").evaluateAll(els=>els.map(el=>({height:el.getBoundingClientRect().height,font:getComputedStyle(el).fontSize,pickerFont:getComputedStyle(el.querySelector("select")).fontSize})));
  assert(options.every(o=>o.height>=44&&o.pickerFont==="16px"),"Picker touch geometry and native text size");
  if(theme!=="crt-green") assert(await page.evaluate(async()=>{await document.fonts.load('14px "Roboto Condensed"',"Текст Aa");return document.fonts.check('14px "Roboto Condensed"',"Текст Aa");}),"Local font loads");
  await nav.getByRole("button",{name:/Результаты/}).click();
  await shot("results");
  await page.getByRole("button",{name:"Открыть снимок",exact:true}).first().click();
  await shot("image-viewer");
  await page.getByRole("button",{name:"Закрыть снимок",exact:true}).click();
  await nav.getByRole("button",{name:"Remote",exact:true}).click();
  await expect(page.locator(".remote-canvas")).toHaveCount(0);
  await shot("remote-start");
  await page.getByRole("button",{name:"Подключиться",exact:true}).click();
  await expect(page.locator(".remote-display")).toHaveAttribute("data-ready","true");
  await shot("remote-connected");
  await page.getByRole("button",{name:"Управление Remote",exact:true}).click();
  await shot("remote-controls");
  await page.setViewportSize({width:844,height:390});
  await shot("remote-landscape-controls");
  const panel=await page.locator(".remote-control-panel").boundingBox();
  assert(panel&&panel.y>=0&&panel.y+panel.height<=390,"Landscape controls stay in the viewport");
  await page.getByRole("button",{name:"Скрыть управление",exact:true}).click();
  await shot("remote-landscape");
  assert.equal(Math.round((await page.locator(".remote-display").boundingBox()).height),390);
  await page.getByRole("button",{name:"Назад к чату",exact:true}).click();
  await expect(page.locator(".remote-canvas")).toHaveCount(0);
  await page.setViewportSize({width:1366,height:1024});
  await shot("wide");
  await page.locator(".support-tabs").getByRole("button",{name:"Активность",exact:true}).click();
  await shot("activity-wide");
 }
 await context.close();
} finally {await browser.close();}
await writeFile(out+"/report.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({screenshots:report.length,remoteDisplay:"simulated",physicalIOS:false}));
