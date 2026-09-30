import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('store-materials/images');await mkdir(root,{recursive:true});await mkdir('test-results',{recursive:true});
const {version}=JSON.parse(await readFile('store-dist/manifest.json','utf8'));
const {learning,responses}=JSON.parse(await readFile('scripts/store-samples.json','utf8'));
let locale='zh-CN';const requests=[],errors=[];
const uploads=resolve('store-materials/upload-screenshots');
for(const group of ['zh-CN','en','global'])await mkdir(join(uploads,group),{recursive:true});
async function captureScreenshot(page,name){
 const png=await page.screenshot({path:join(root,name+'.png'),type:'png',omitBackground:false,animations:'disabled'});
 assert.equal(png.readUInt32BE(16),1280);assert.equal(png.readUInt32BE(20),800);
 assert.equal(png[24],8);assert.equal(png[25],2,'Screenshot must be 24-bit RGB PNG, without alpha');
 for(let offset=8;offset<png.length;offset+=12+png.readUInt32BE(offset))assert.notEqual(png.toString('ascii',offset+4,offset+8),'tRNS','No transparency chunk');
 const group=name.startsWith('zh-')?'zh-CN':'en', filename=name.slice(3)+'.jpg';
 await page.screenshot({path:join(uploads,group,filename),type:'jpeg',quality:95,omitBackground:false,animations:'disabled'});
 if(group==='en')await copyFile(join(uploads,group,filename),join(uploads,'global',filename));
}

const server=createServer(async(req,res)=>{
 if(req.method==='POST'){
  let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);requests.push(data);
  const sys=data.messages[0].content;
  const output=sys.startsWith('Identify the language')?'en':sys.includes('Learning output-language rule')||sys.includes('本次同语学习')?learning:locale==='en'?responses.en:responses.zh;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:output},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:80,total_tokens:110}}));return;
 }
 const en=locale==='en';
 res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f8f8f2;color:#2c382e;font:19px/1.85 system-ui}header{margin:50px 80px;border-bottom:1px solid #d9dfd2;padding-bottom:22px;font-size:14px;letter-spacing:3px;color:#5b7057}article{margin:44px 100px;width:920px}small{font-size:12px;letter-spacing:2px;color:#778470}h1{font-size:44px;line-height:1.2;font-weight:550;letter-spacing:-1px;margin:18px 0 28px}p{max-width:840px}footer{position:fixed;bottom:30px;left:100px;font-size:12px;color:#778470}.quiet{color:#85917d;margin-top:40px}</style><header>PLAINLY &nbsp; / &nbsp; ${en?'A CLEARER READ':'读懂，也学会'}</header><article><small>${en?'READING SAMPLE':'阅读示例'}</small><h1>${en?'Understand the connection.':'从一个词，理解一句话。'}</h1><p>The two systems are closely <span id="word">coupled</span>: a change in one can affect the other.</p><p class="quiet">${en?'Select a word. Keep your place.':'选中不熟悉的词，留在原文旁阅读。'}</p></article><footer>${en?'Sample article and response · Output depends on your selected model':'示例文章与回答 · 实际输出取决于所选模型'}</footer>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const ext=resolve('store-dist');let browser;
try{
 browser=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'plainly-store-images-')),{channel:'chromium',headless:true,viewport:{width:1280,height:800},deviceScaleFactor:1,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});browser.setDefaultTimeout(20000);
 browser.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const options=await browser.newPage();await options.goto(`chrome-extension://${id}/options.html`);await options.waitForFunction(()=>document.querySelector('#enabled-actions')?.children.length===4);
 const initial=await options.evaluate(async()=> (await chrome.runtime.sendMessage({type:'getSettings'})).value);
 assert.equal(initial.profiles[0].apiKey,'');assert.equal(initial.jev.apiKey,'');assert.equal(await options.locator('#preset-trigger-logo').count(),0);assert.equal(await options.locator('#reset-trigger-icon').count(),1);
 assert.equal(await worker.evaluate(()=>chrome.runtime.getManifest().permissions.includes('activeTab')),false);
 const page=await browser.newPage();
 for(locale of ['zh-CN','en']){
  const prefix=locale==='en'?'en':'zh';
  await options.evaluate(async({origin,locale})=>{const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.uiLanguage=locale;s.appearance={fontSize:16,cardWidth:360,cardMaxHeight:480};s.profiles[0].baseUrl=origin+'/v1';s.profiles[0].apiKey='';s.trigger='click';s.defaultAction='explain';await chrome.runtime.sendMessage({type:'saveSettings',value:s});},{origin,locale});
  await page.goto(origin);await page.bringToFront();await page.locator('#word').dblclick();const card=page.locator('plainly-reader');await card.locator('.trigger').click();await card.locator('.stop').waitFor({state:'hidden'});await card.locator('.answer').filter({hasText:locale==='en'?'coupled':/连接|关联|耦合|连接在一起/}).waitFor();
  await captureScreenshot(page,`${prefix}-01-explain`);
  await card.locator('[data-action=learn]').click();await card.locator('.stop').waitFor({state:'hidden'});await card.locator('.answer').filter({hasText:'coupled'}).waitFor();
  assert.ok(requests.at(-1).messages[0].content.includes(locale==='en'?'English only':'仅使用English'));
  await captureScreenshot(page,`${prefix}-02-learn`);
  await options.reload();await options.waitForFunction(()=>document.querySelector('#enabled-actions')?.children.length===4);await options.locator('[data-page=languages]').click();await captureScreenshot(options,`${prefix}-03-languages`);
  await options.locator('[data-page=general]').click();await captureScreenshot(options,`${prefix}-04-preferences`);
  // Return model connection settings to real, empty-key defaults before photographing presets.
  await options.evaluate(async()=>{const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.profiles[0].baseUrl='https://api.deepseek.com/v1';s.profiles[0].apiKey='';await chrome.runtime.sendMessage({type:'saveSettings',value:s});});
  await options.reload();await options.locator('[data-page=models]').click();await captureScreenshot(options,`${prefix}-05-models`);
 }
 await options.locator('[data-page=about]').click();assert.equal(await options.locator('#page-about a[href="privacy.html"]').count(),1);
 const privacy=await browser.newPage();await privacy.goto(`chrome-extension://${id}/privacy.html`);assert.equal(await privacy.locator('a[href="mailto:jiaweizhang1122@gmail.com"]').count(),2);
 // Brand-only promotional artwork built from the project's original SVG, not third-party imagery.
 const svg=await readFile('public/question-mark.svg','utf8');const promo=await browser.newPage();await promo.setViewportSize({width:440,height:280});
 await promo.setContent(`<style>body{margin:0;background:#abbab9;width:440px;height:280px;overflow:hidden;color:#1e2626;font-family:Arial,sans-serif}.label{position:absolute;left:26px;top:22px;font:12px monospace;letter-spacing:2px}.paper{position:absolute;background:#f6f8f6;width:250px;height:160px;left:26px;top:70px;border:1px solid #899d9b}.line{height:6px;background:#c2d0cc;margin:22px 24px;width:190px}.line:nth-child(2){width:138px;background:#6c8983}.line:nth-child(3){width:170px}.bubble{position:absolute;left:275px;top:70px;width:138px;height:160px;background:#1e2626;display:grid;place-items:center;color:#f6f8f6}svg{width:84px;height:84px}.rule{position:absolute;bottom:23px;left:26px;right:26px;border-top:1px solid #899d9b}</style><div class="label">PLAINLY</div><div class="paper"><div class="line"></div><div class="line"></div><div class="line"></div></div><div class="bubble">${svg}</div><div class="rule"></div>`);
 await promo.screenshot({path:join(root,'promo-440x280.png')});
 assert.deepEqual(errors,[]);await writeFile('test-results/store-browser-report.json',JSON.stringify({version,passed:true,checks:['clean install with empty keys','private avatar absent','question mark available','broad-site selection without activeTab','explicit learning language contract','bilingual settings and privacy','10 actual UI captures at 1280x800, verified 24-bit RGB PNG without alpha','15 upload JPEGs grouped by zh-CN, en and global (English fallback)','brand promo 440x280'],api:'isolated fixture; isolated sample responses: curated explanation; learning replayed from earlier DeepSeek output',errors},null,2));
 console.log('PASS: store build smoke test; 10 bilingual UI screenshots and one promo image.');
}finally{await browser?.close();server.closeAllConnections();server.close();}
