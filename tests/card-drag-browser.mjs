import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
let context, slow = false; const finish = [], errors = [], results = [], requests = [];
const server=createServer(async(req,res)=>{
 if(req.method==='POST') {
  let body=''; for await(const chunk of req) body+=chunk; requests.push(JSON.parse(body));
  if(slow){res.setHeader('content-type','text/event-stream');res.write('data: {"choices":[{"delta":{"content":"开始解释。"}}]}\n\n');finish.push(()=>res.end('data: '+JSON.stringify({choices:[{delta:{content:'后续解释。'.repeat(60)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));}
  else{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'说明这段文字的含义。'},finish_reason:'stop'}]}));}return;
 }
 res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><style>body{margin:0;padding:90px 60px;font:22px/2 system-ui;min-height:2400px}p{width:700px}</style><p><span id="word">Serendipity</span> is a pleasant surprise.</p><p><span id="another">Another</span> interesting expression.</p><p><span id="fresh">Unfamiliar</span> ideas.</p>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
try {
 await mkdir('test-results',{recursive:true});
 context=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'plainly-drag-')), {channel:'chromium',headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);await options.waitForFunction(()=>document.querySelector('#enabled-actions').children.length===4);
 assert.equal(await options.locator('#close-after-drag').isChecked(),false);
 await options.evaluate(async origin=>{const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.profiles[0].baseUrl=origin+'/v1';s.profiles[0].model='mock';s.profiles[0].apiKey='';await chrome.runtime.sendMessage({type:'saveSettings',value:s});},origin);
 await options.reload();
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const card=page.locator('plainly-reader .card');
 async function open(selector='#word'){await page.locator(selector).dblclick();await page.locator('plainly-reader .trigger').click();await card.waitFor({state:'visible'});}
 async function settled(){await page.locator('plainly-reader .stop').waitFor({state:'hidden'});}
 async function drag(dx,dy){const b=await page.locator('plainly-reader .drag-handle').boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:8});await page.mouse.up();}
 async function outside(){await page.mouse.click(5,5);await page.waitForTimeout(80);}
 async function lockState(expected){const pin=page.locator('plainly-reader .pin');assert.equal(await pin.getAttribute('aria-pressed'),String(expected));assert.ok((await pin.getAttribute('aria-label')).startsWith(expected?'已锁定':'未锁定'));}

 await open();await settled();await page.locator('plainly-reader .head .mark').click();await outside();assert.equal(await card.count(),0);
 await open();await settled();await lockState(false);const before=await card.boundingBox();await drag(300,80);let b=await card.boundingBox();assert.ok(Math.abs(b.x-before.x-300)<2&&Math.abs(b.y-before.y-80)<2,JSON.stringify({before,after:b}));
 await lockState(true);await outside();assert.ok(await card.isVisible());
 await page.locator('#another').dblclick();await page.locator('plainly-reader .trigger').waitFor({state:'visible'});assert.equal(await page.locator('plainly-reader .term').innerText(),'Serendipity');
 const trigger=await page.locator('plainly-reader .trigger').boundingBox();const selected=await page.evaluate(()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return {right:r.right,bottom:r.bottom};});assert.ok(Math.abs(trigger.x-selected.right-2)<1&&Math.abs(trigger.y-selected.bottom-2)<1);
 const kept=await card.boundingBox();assert.equal(kept.x,b.x);assert.equal(kept.y,b.y);
 await page.locator('plainly-reader .mode').selectOption('slang');await settled();assert.ok(requests.at(-1).messages[1].content.includes('Serendipity'));assert.ok(!requests.at(-1).messages[1].content.includes('Another'));
 await page.locator('#another').dblclick();await page.locator('plainly-reader .trigger').click();await settled();assert.equal(await page.locator('plainly-reader .term').innerText(),'Another');assert.ok(requests.at(-1).messages[1].content.includes('Another'));b=await card.boundingBox();assert.equal(b.x,kept.x);assert.equal(b.y,kept.y);

 await page.mouse.wheel(0,900);await page.waitForTimeout(100);let scrolled=await card.boundingBox();assert.ok(Math.abs(scrolled.x-b.x)<1&&Math.abs(scrolled.y-b.y)<1);
 await page.locator('plainly-reader .mode').selectOption('slang');await settled();assert.ok(await card.isVisible());
 await page.locator('plainly-reader .drag-handle').focus();const keyBefore=await card.boundingBox();await page.keyboard.press('ArrowRight');assert.ok(Math.abs((await card.boundingBox()).x-keyBefore.x-10)<1);
 await page.setViewportSize({width:390,height:650});await page.waitForTimeout(100);b=await card.boundingBox();assert.ok(b.x>=12&&b.y>=12&&b.x+b.width<=390&&b.y+b.height<=650);
 await page.screenshot({path:'test-results/card-drag-mobile.png'});await page.locator('plainly-reader .close').click();assert.equal(await card.count(),0);
 results.push('标题栏单击不改变关闭行为；实际拖动、空白点击保留、新选区提示键与旧卡片并存，点击切换并保持位置，切换前请求仍用旧内容、滚动定位、键盘移动和窄屏边界通过');
 await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>scrollTo(0,0));
 await open();await settled();await drag(150,20);await lockState(true);await page.locator('plainly-reader .pin').click();await lockState(false);await drag(20,0);await lockState(false);await outside();assert.equal(await card.count(),0);
 await open();await settled();await lockState(false);await page.locator('plainly-reader .drag-handle').hover();assert.ok((await page.locator('plainly-reader .drag-handle').evaluate(el=>getComputedStyle(el,'::after').content)).includes('按住拖动'));
 await page.screenshot({path:'test-results/card-drag-hint.png'});await page.locator('plainly-reader .pin').click();await lockState(true);await outside();assert.ok(await card.isVisible());await page.locator('plainly-reader .pin').hover();await page.screenshot({path:'test-results/card-locked-hint.png'});await page.keyboard.press('Escape');
 results.push('锁定图标与实际行为一致：默认拖动自动锁定，手动解锁后再拖动仍解锁；新卡片恢复默认，六点手柄有可见提示');
 slow=true;
 await open('#fresh');await page.waitForFunction(()=>document.querySelector('plainly-reader')?.shadowRoot.querySelector('.answer').textContent.includes('开始解释'));
 await drag(380,-60);b=await card.boundingBox();for(const done of finish.splice(0))done();await settled();let after=await card.boundingBox();assert.ok(Math.abs(after.x-b.x)<1&&Math.abs(after.y-b.y)<1);await outside();assert.ok(await card.isVisible());await page.screenshot({path:'test-results/card-drag-desktop.png'});await page.keyboard.press('Escape');assert.equal(await card.count(),0);slow=false;
 results.push('生成过程中拖动后，后续内容增长保持位置，Esc 仍能关闭');
 await options.locator('.switch:has(#close-after-drag)').click();await options.locator('#save').click();await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));await options.reload();assert.equal(await options.locator('#close-after-drag').isChecked(),true);
 await open();await settled();await drag(150,30);await lockState(false);await outside();assert.equal(await card.count(),0);
 await open();await settled();await page.locator('plainly-reader .pin').click();await drag(150,30);await lockState(true);await outside();assert.ok(await card.isVisible());await page.locator('plainly-reader .pin').click();await lockState(false);await drag(20,0);await outside();assert.equal(await card.count(),0);
 results.push('设置保存后可开启拖动后点击空白关闭；手动固定优先保留，取消固定后恢复关闭');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.length,results},null,2));await writeFile('test-results/card-drag-report.json',JSON.stringify({passed:results.length,results},null,2));
}finally{for(const done of finish)done();await context?.close();await new Promise(r=>server.close(r));}
