import {chromium} from 'playwright-core';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const errors=[];
const context=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'plainly-localization-')),{channel:'chromium',headless:true,viewport:{width:1100,height:900},args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
try{
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);await options.waitForFunction(()=>document.querySelector('#enabled-actions').children.length===4);
 const save=async()=>{await options.locator('#save').click();await options.waitForFunction(()=>['已保存到此设备','Saved on this device'].includes(document.querySelector('#save-status').textContent));};
 await options.locator('#ui-language').selectOption('en');await save();
 const pages={options};
 for(const name of ['popup','sidepanel','pdf']){const page=await context.newPage();await page.goto(`chrome-extension://${id}/${name}.html`);await page.waitForFunction(()=>document.documentElement.lang==='en');pages[name]=page;}
 // Scan all built-in static copy, including hidden panels and accessible labels.
 for(const [name,page] of Object.entries(pages)){
  const remaining=await page.evaluate(()=>{const missed=[];const skip='script,style,textarea,[data-i18n-skip],.answer,#answer,.term,#pdf-text';const walker=document.createTreeWalker(document,NodeFilter.SHOW_TEXT);const check=(text,where)=>{if(/[\u4e00-\u9fff]/.test(text)&&text.trim()!=='日本語')missed.push(`${where}: ${text}`);};while(walker.nextNode()){const el=walker.currentNode.parentElement;if(el&&!el.closest(skip))check(walker.currentNode.textContent,el.id||el.tagName);}for(const el of document.querySelectorAll('*'))if(!el.closest('[data-i18n-skip]'))for(const attr of ['placeholder','aria-label','title','data-tooltip'])check(el.getAttribute(attr)||'',`${el.id||el.tagName}@${attr}`);return missed;});
  assert.deepEqual(remaining,[],`${name}: extension-owned UI should be English`);
 }
 for(const page of [pages.popup,pages.sidepanel]){
  assert.equal(await page.locator('#text').getAttribute('placeholder'),'Type or paste text…');
  assert.equal(await page.locator('#text').getAttribute('aria-label'),'Text to understand');
  await page.locator('#text').fill('保存修改\n阅读偏好：这是用户输入。');
 }
 await options.locator('#mode-prompt').evaluate(el=>{el.value='CUSTOM 保留这条提示词';el.dispatchEvent(new Event('input',{bubbles:true}));});
 const prompt=await options.locator('#mode-prompt').inputValue();
 // Existing localizer observes new nodes and later attribute mutations, without touching values/defaults.
 await options.evaluate(()=>{const fixture=document.createElement('div');fixture.id='localization-fixture';fixture.hidden=true;fixture.innerHTML='<textarea id="fixture-input" placeholder="每行一个域名，例如 mail.google.com" aria-label="追问">保存修改</textarea><textarea id="fixture-optout" data-i18n-skip placeholder="追问">阅读偏好</textarea><div class="answer">保存修改</div><span data-i18n-skip>阅读偏好</span><p id="fixture-status"></p>';document.body.append(fixture);});
 await options.waitForFunction(()=>document.querySelector('#fixture-input').placeholder==='One domain per line, e.g. mail.google.com');
 assert.equal(await options.locator('#fixture-input').getAttribute('aria-label'),'Follow-up');
 assert.deepEqual(await options.locator('#fixture-input').evaluate(el=>[el.value,el.defaultValue,el.textContent]),['保存修改','保存修改','保存修改']);
 assert.equal(await options.locator('#fixture-optout').getAttribute('placeholder'),'追问');
 assert.equal(await options.locator('#localization-fixture .answer').textContent(),'保存修改');
 await options.locator('#fixture-input').evaluate(el=>{el.placeholder='还有哪里不明白？';el.setAttribute('aria-label','需要解释的内容');});
 await options.waitForFunction(()=>document.querySelector('#fixture-input').placeholder==='What else would you like to understand?');
 const states=[['停止生成','Stop generating'],['正在分段搜索长网页… 2/4','Searching page sections… 2/4'],['Jev 授权失败，请检查 API Key 与账户权限。\n本次搜索未完成，请重试。','Jev authorization failed. Check your API key and account permissions.\nSearch did not finish. Try again.'],['正在显示第 3 页…','Displaying page 3…']];
 for(const [source,target] of states){await options.locator('#fixture-status').evaluate((el,text)=>el.textContent=text,source);await options.waitForFunction(text=>document.querySelector('#fixture-status').textContent===text,target);}
 // The PDF welcome title translates, but a real filename matching a UI dictionary entry does not.
 assert.equal(await pages.pdf.locator('#document-title').textContent(),'No document open');
 await pages.pdf.locator('#pdf-file').setInputFiles({name:'阅读偏好',mimeType:'application/pdf',buffer:Buffer.from('invalid PDF fixture')});
 await pages.pdf.waitForFunction(()=>document.querySelector('#document-title').textContent==='阅读偏好');
 for(const language of ['zh-CN','en','zh-CN']){
  await options.locator('#ui-language').selectOption(language);await save();
  for(const page of [pages.popup,pages.sidepanel]){await page.waitForFunction(lang=>document.documentElement.lang===lang,language);assert.equal(await page.locator('#text').getAttribute('placeholder'),language==='en'?'Type or paste text…':'输入或粘贴文字…');assert.equal(await page.locator('#text').inputValue(),'保存修改\n阅读偏好：这是用户输入。');}
  assert.equal(await options.locator('#fixture-input').getAttribute('placeholder'),language==='en'?'What else would you like to understand?':'还有哪里不明白？');
  assert.equal(await options.locator('#fixture-input').inputValue(),'保存修改');
  assert.equal(await options.locator('#mode-prompt').inputValue(),prompt);
  assert.equal(await pages.pdf.locator('#document-title').textContent(),'阅读偏好');
 }
 await options.locator('#ui-language').selectOption('en');await save();
 await pages.popup.waitForFunction(()=>document.documentElement.lang==='en');await pages.popup.locator('#text').fill('');
 await pages.popup.setViewportSize({width:360,height:740});await mkdir('test-results',{recursive:true});await pages.popup.screenshot({path:'test-results/popup-localized-en.png',animations:'disabled'});
 assert.deepEqual(errors,[]);
 console.log('PASS: complete static UI scan on settings, popup, side panel and PDF; textarea metadata and dynamic statuses; repeated language switching preserves user input, prompts and filenames.');
}finally{await context.close();}
