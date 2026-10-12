// Isolated UI/lifecycle test. The model is a controllable fixture, not a quality test.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const modelFixture = `
import {PROFILES} from '/js/conversation-core.mjs';
export const LoggerWithoutDebug = {};
export class CacheManager {}
export class Wllama {
 constructor(){this.modelManager={getModels:async()=>[{url:PROFILES.mobile.url,open:async()=>[]}]} }
 setCompat(){} async loadModel(){} async exit(){window.testExited=true;}
 async *createChatCompletion(options){
  window.testMessages=options.messages;
  yield {choices:[{delta:{content:'途中の回答'}}]};
  await new Promise(resolve=>window.finishTestGeneration=resolve);
  yield {choices:[{delta:{content:'完了'}}]};
 }
}`;
(async () => {
  const root=path.resolve(__dirname,'..');
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)) return res.writeHead(403).end();
    try {
      const body=pathname==='/lab/vendor/wllama-3.6.1/index.js'?modelFixture:await fs.readFile(file);
      res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream'}).end(body);
    } catch(_){res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    const chrome=process.env.BROWSER_ENGINE==='chromium';
    browser=await(chrome?pw.chromium:pw.webkit).launch(chrome?{channel:'chrome'}:{});
    const page=await browser.newPage({...pw.devices['iPhone 13']});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(base+'/tests/quality.html');
    await page.evaluate(async()=>{
      await import('/js/db.js'); const db=await AI.db.open();
      await AI.db.tx(db,'settings','readwrite',t=>AI.db.rq(t.objectStore('settings').put({name:'conversation-v1',value:[{q:'前の相談',a:'前の回答',interrupted:false}]})));db.close();
    });
    await page.goto(base+'/');
    await page.waitForFunction(()=>!document.querySelector('#new-chat-top').disabled);
    assert.equal(await page.locator('#chat-tabs [role=tab]').count(),1);
    assert.match(await page.locator('#messages').innerText(),/前の回答/);
    assert.equal(await page.locator('#update-app').isVisible(),false);
    await page.locator('#input').fill('書きかけA');
    await page.locator('#new-chat-top').click();
    await page.waitForFunction(()=>document.querySelectorAll('#chat-tabs [role=tab]').length===2);
    await page.locator('#input').fill('書きかけB');
    await page.locator('#chat-tabs [role=tab]').first().click();
    await page.waitForFunction(()=>document.querySelector('#input').value==='書きかけA');
    await page.locator('#chat-tabs [role=tab]').first().press('ArrowRight');
    await page.waitForFunction(()=>document.querySelector('#input').value==='書きかけB');
    assert.equal(await page.locator('#messages').innerText(),'');
    // 「会話を準備」は送信ボタンに統合した。送信すると準備してから答える
    await page.locator('#input').fill('今夜の過ごし方を考えて');
    await page.locator('#send').click();
    await page.waitForFunction(()=>!!window.finishTestGeneration);
    assert.ok(await page.locator('#chat-tabs [role=tab]').first().isDisabled());
    assert.ok(await page.locator('#new-chat-top').isDisabled());
    assert.equal(await page.evaluate(()=>window.testMessages.some(m=>m.content.includes('前の相談'))),false);
    await page.locator('#stop').click();
    await page.waitForFunction(()=>window.testExited && !document.querySelector('#new-chat-top').disabled);
    await page.locator('#chat-tabs [role=tab]').first().click();
    await page.waitForFunction(()=>document.querySelector('#input').value==='書きかけA');
    assert.ok(!(await page.locator('#messages').innerText()).includes('途中の回答'));
    await page.locator('#open-menu').click();
    await page.locator('#chat-name').fill('仕事の相談');
    await page.locator('#rename-chat').click();
    await page.waitForFunction(()=>document.querySelector('#chat-title').textContent==='仕事の相談');
    assert.ok(await page.locator('#update-app').isVisible());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#open-menu').evaluate(el=>el===document.activeElement),true);
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#input').value==='書きかけA');
    assert.equal(await page.locator('#chat-title').innerText(),'仕事の相談');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.argv[2]) {
      await page.screenshot({path:process.argv[2]+'-mobile.png',fullPage:true});
      await page.locator('#open-menu').click();
      await page.screenshot({path:process.argv[2]+'-menu.png',fullPage:true});
      await page.locator('#close-menu').click();await page.setViewportSize({width:1280,height:900});
      await page.screenshot({path:process.argv[2]+'-desktop.png',fullPage:true});
    }
    page.on('dialog',d=>d.accept());
    await page.locator('#open-menu').click();await page.locator('#delete-chat').click();
    await page.waitForFunction(()=>document.querySelectorAll('#chat-tabs [role=tab]').length===1);
    assert.match(await page.locator('#messages').innerText(),/途中の回答/);
    await page.locator('#open-menu').click();await page.locator('#delete-chat').click();
    await page.waitForFunction(()=>document.querySelector('#messages').children.length===0);
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#new-chat-top').disabled);
    assert.equal(await page.locator('#messages').innerText(),'');
    assert.equal(await page.locator('#chat-tabs [role=tab]').count(),1);
    assert.deepEqual(errors,[]);
    console.log('PASS: legacy migration, separate histories/drafts, keyboard tabs, blocked switching during generation, stop, rename, menu focus, reload, deletion without resurrection.');
  } finally {await browser?.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
