import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit,expect} from '@playwright/test';
import react from '../apps/web/node_modules/@vitejs/plugin-react/dist/index.js';
import {build} from '../apps/web/node_modules/vite/dist/node/index.js';
const dir=await mkdtemp(join(tmpdir(),'owner-update-'));
try{
 await build({configFile:false,root:resolve('apps/web'),plugins:[react()],define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error',build:{outDir:dir,emptyOutDir:true,lib:{entry:resolve('apps/web/tests/fixtures/owner-update.tsx'),name:'Fixture',formats:['iife'],fileName:()=> 'fixture.js'}}});
 const js=await readFile(join(dir,'fixture.js'),'utf8');
 for(const type of [chromium,webkit]){
  const browser=await type.launch();try{
   for(const owner of [false,true]){
    const page=await browser.newPage({viewport:{width:390,height:844}});let sent=[];
    await page.route('https://update.test/**',route=>{
     const path=new URL(route.request().url()).pathname;
     if(path==='/')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="codex-release" content="abcdef1"><div id="root"></div><script src="/fixture.js"></script>'});
     if(path==='/fixture.js')return route.fulfill({contentType:'application/javascript',body:js});
     if(path==='/version.json')return route.fulfill({json:{id:'abcdef1'}});
     if(path==='/api/deployment/apply'){sent.push(route.request().postDataJSON());return route.fulfill({json:{accepted:true}});}
     return route.fulfill({json:{ownerForceAllowed:owner,maintenance:{state:'waiting',revision:'abcdef2',startedAt:123}}});
    });
    await page.goto('https://update.test/');
    if(!owner){await page.waitForTimeout(300);await expect(page.getByText('Обновить жёстко',{exact:true})).toHaveCount(0);}
    else{
     const button=page.getByRole('button',{name:'Обновить жёстко',exact:true});await expect(button).toBeEnabled();
     page.once('dialog',dialog=>dialog.dismiss());await button.click();assert.equal(sent.length,0);
     page.once('dialog',dialog=>dialog.accept());await button.click();await expect(page.getByText('Начинаем жёсткое обновление…')).toBeVisible();
     assert.deepEqual(sent,[{revision:'abcdef2',startedAt:123,force:true,confirm:true}]);
    }
    await page.close();
   }
  }finally{await browser.close();}
 }
 console.log('Owner-only force notice, busy work, confirmation and exact release passed Chromium/WebKit');
}finally{await rm(dir,{recursive:true,force:true});}

