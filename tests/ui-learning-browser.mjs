import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const requests=[], errors=[], results=[]; let context;
const server=createServer(async(req,res)=>{
 if(req.method==='POST'){
  let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);requests.push(data);
  const system=data.messages[0].content, selection=JSON.parse(data.messages[1].content), text=selection.selectedText ?? selection['选中文字'];
  const detection=system.startsWith('Identify the language of the selected text.');
  const answer=detection ? (/[\u3040-\u30ff]/.test(text)?'ja':/[\u4e00-\u9fff]/.test(text)?'zh-CN':'en') : (system.includes('用户手动指定本次学习输出语言为 English')||system.includes('user explicitly selected English as the learning output language'))?'An English learning note.':/[\u3040-\u30ff]/.test(text)?'日本語の学習メモです。':/[\u4e00-\u9fff]/.test(text)?'阅读偏好\n这是中文学习说明。':'An English learning note.';
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));return;
 }
 res.setHeader('content-type','text/html;charset=utf-8');res.end('<style>body{margin:140px;font:24px/2 system-ui}</style><p id="source">设置</p><p id="selection">山重水复疑无路，柳暗花明又一村。</p>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
try{
 await mkdir('test-results',{recursive:true});
 context=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'plainly-ui-learning-')),{channel:'chromium',headless:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);await options.locator('#ui-language').waitFor();
 await options.evaluate(async(origin)=>{const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.profiles[0]={...s.profiles[0],name:'阅读偏好',model:'mock',apiKey:'fake-key',baseUrl:origin+'/v1'};s.defaultAction='learn';s.translation.source='en';s.translation.target='en';s.prompts.learn+='\nCustom prompt remains unchanged.';await chrome.runtime.sendMessage({type:'saveSettings',value:s});},origin);
 await options.reload();await options.locator('#ui-language').waitFor();
 const original=await options.evaluate(async()=> (await chrome.runtime.sendMessage({type:'getSettings'})).value);
 const save=async()=>{await options.locator('#save').click();await options.waitForFunction(()=>['已保存到此设备','Saved on this device'].includes(document.querySelector('#save-status').textContent));};
 await options.locator('#ui-language').selectOption('en');
 await options.waitForFunction(()=>document.querySelector('[data-page=languages]').textContent.includes('Languages'));
 assert.equal(await options.locator('#language').inputValue(),'system');
 await save();await options.reload();await options.waitForFunction(()=>document.documentElement.lang==='en');
 await options.locator('[data-page=languages]').click();
 assert.equal(await options.locator('#learning-preferences .learning-language').inputValue(),'auto');
 assert.match(await options.locator('#learning-preferences').innerText(),/Auto · original language/);
 await options.screenshot({path:'test-results/language-settings-en.png'});
 await options.locator('[data-page=models]').click();assert.equal(await options.locator('#profile-list strong span').first().innerText(),'阅读偏好');
 const saved=await options.evaluate(async()=> (await chrome.runtime.sendMessage({type:'getSettings'})).value);
 assert.equal(saved.prompts.learn,original.prompts.learn);assert.equal(saved.profiles[0].apiKey,original.profiles[0].apiKey);assert.equal(saved.translation.target,'en');
 results.push('English interface persists; prompt, key, model profile name and translation values remain unchanged');
 const page=await context.newPage();await page.goto(origin);const card=page.locator('plainly-reader');
 async function open(text){await page.bringToFront();await page.evaluate(text=>{const el=document.querySelector('#selection');el.textContent=text;const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));document.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));},text);await card.locator('.trigger').waitFor({state:'visible'});await card.locator('.trigger').click();await done();}
 async function done(){await card.locator('.stop').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('plainly-reader')?.shadowRoot.querySelector('.answer').textContent.length>0);}
 for(const [text,answer] of [['山重水复疑无路，柳暗花明又一村。','这是中文学习说明。'],['桜が咲いています。','日本語の学習メモです。'],['A small but meaningful discovery.','An English learning note.']]){
  await open(text);assert.match(requests.at(-1).messages[0].content,/OUTPUT LANGUAGE REQUIREMENT/);assert.match(requests.at(-1).messages[0].content,/independently identified/);const detected=requests.filter(r=>r.messages[0].content.startsWith('Identify the language')).at(-1);assert.deepEqual(JSON.parse(detected.messages[1].content),{selectedText:text});assert.ok((await card.locator('.answer').innerText()).includes(answer));assert.equal(await card.locator('.term').innerText(),text);assert.equal(await page.locator('#source').innerText(),'设置');assert.equal(await card.locator('.learning-language').inputValue(),'auto');await page.keyboard.press('Escape');
 }
 await open('阅读偏好');assert.equal(await card.locator('.term').innerText(),'阅读偏好');assert.match(await card.locator('.context pre').textContent(),/^Selected text:\n阅读偏好/);assert.match(await card.locator('.answer').innerText(),/^阅读偏好/);assert.match(await card.locator('.reading-actions').innerText(),/Learn/);
 assert.equal(await card.locator('.head .learning-language').count(),1); assert.equal(await card.locator('.scroll select,.language-controls,.language-run').count(),0); await card.locator('.card').waitFor({state:'visible'}); await page.screenshot({animations:'disabled',path:'test-results/learning-chinese-english-ui.png'});
 await card.locator('.learning-language').selectOption('en');await done();assert.match(requests.at(-1).messages[0].content,/selected English as the learning output language/);assert.match(await card.locator('.answer').innerText(),/^An English/);
 await page.keyboard.press('Escape');await open('阅读偏好');assert.equal(await card.locator('.learning-language').inputValue(),'auto');await page.keyboard.press('Escape');
 const usage=(await options.evaluate(()=>chrome.runtime.sendMessage({type:'getUsage'}))).value;assert.equal(usage.rows[0].requests,requests.length);assert.equal(usage.rows[0].tokens.total,requests.length*15);
 results.push('Language detection and lessons count toward usage; Chinese, Japanese and English selections send concrete language locks; original text and answers are not UI-translated; per-card override resets on new selection (mock API)');
 await options.locator('[data-page=languages]').click();await options.locator('#learning-preferences .learning-language').selectOption('en');await save();await options.reload();await options.waitForFunction(()=>document.querySelector('#learning-preferences .learning-language')?.value==='en');
 await open('再学习一次');assert.match(requests.at(-1).messages[0].content,/selected English as the learning output language/);await page.keyboard.press('Escape');
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.waitForFunction(()=>document.documentElement.lang==='en');assert.equal(await popup.locator('#settings').innerText(),'Settings ↗');assert.equal(await popup.locator('.popup-controls .learning-language').inputValue(),'en'); assert.equal(await popup.locator('.language-controls,.learning-level,.translation-engine,.language-run').count(),0);
 const pdf=await context.newPage();await pdf.goto(`chrome-extension://${id}/pdf.html`);await pdf.waitForFunction(()=>document.documentElement.lang==='en');assert.equal(await pdf.locator('#open-file').innerText(),'Open file');
 await page.bringToFront();await worker.evaluate(async(origin)=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url===origin+'/');await chrome.scripting.executeScript({target:{tabId:tab.id},files:['search.js']});},origin);
 await page.locator('plainly-search').waitFor();await page.waitForFunction(()=>document.querySelector('plainly-search')?.shadowRoot.querySelector('header strong').textContent==='Find it on this page.');
 await page.keyboard.press('Escape');
 results.push('Saved manual learning language applies to new selections and toolbar; PDF and search UI use English');
 await options.locator('[data-page=general]').click();await options.locator('#ui-language').selectOption('zh-CN');await save();
 await popup.waitForFunction(()=>document.documentElement.lang==='zh-CN');assert.equal(await popup.locator('#settings').innerText(),'设置 ↗');
 await options.locator('#ui-language').selectOption('en');await options.locator('#ui-language').selectOption('zh-CN');assert.equal(await options.locator('#language').inputValue(),'system');
 await options.locator('[data-page=languages]').click();assert.equal(await options.locator('#learning-preferences .learning-language').inputValue(),'en');
 await options.setViewportSize({width:390,height:780});assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await options.screenshot({path:'test-results/language-settings-zh-mobile.png'});
 results.push('Switching back restores Chinese without changing learning language; narrow settings layout stays within viewport');
 assert.deepEqual(errors,[]);await writeFile('test-results/ui-learning-report.json',JSON.stringify({passed:results.length,results,requests:requests.length},null,2));console.log(JSON.stringify({passed:results.length,results,requests:requests.length},null,2));
}finally{await context?.close();server.closeAllConnections();server.close();}
