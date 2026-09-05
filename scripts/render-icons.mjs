import {chromium} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
try{
 const svg=await readFile("apps/web/public/icon.svg","utf8");
 const page=await browser.newPage();
 for(const size of [180,192,512]){
  await page.setViewportSize({width:size,height:size});
  await page.setContent('<style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>'+svg);
  await page.screenshot({path:"apps/web/public/"+(size===180?"apple-touch-icon":"icon-"+size)+".png",omitBackground:true});
 }
 console.log("PWA icons rendered from the repository SVG");
}finally{await browser.close();}
