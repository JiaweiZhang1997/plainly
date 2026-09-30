import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const requests=[], free=[], errors=[];let context;
const server=createServer(async(req,res)=>{
 if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:requests.at(-1).messages[0].content.startsWith('Identify the language')?'zh-CN':'Mock response'},finish_reason:'stop'}]}));return;}
 const url=new URL(req.url,'http://localhost');free.push(url.searchParams.get('langpair'));res.setHeader('content-type','application/json');res.end(JSON.stringify({responseStatus:200,responseData:{translatedText:'Free mock response'}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
try{
 context=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'plainly-output-policy-')),{channel:'chromium',headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 await worker.evaluate(origin=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(String(input));return url.hostname==='api.mymemory.translated.net'?original(origin+url.pathname+url.search,init):original(input,init);};},origin);
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);await options.waitForFunction(()=>document.querySelector('#enabled-actions').children.length===4);
 assert.equal(await options.locator('#language').inputValue(),'system');assert.match(await options.locator('#explanation-language-policy').innerText(),/跟随系统语言 · 简体中文/);
 await options.evaluate(async(origin)=>{const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.profiles[0].baseUrl=origin+'/v1';s.profiles[0].model='mock';s.profiles[0].apiKey='fake-only';await chrome.runtime.sendMessage({type:'saveSettings',value:s});},origin);
 await options.reload();await options.waitForFunction(()=>document.querySelector('#enabled-actions').children.length===4);
 const save=async()=>{await options.locator('#save').click();await options.waitForFunction(()=>['已保存到此设备','Saved on this device'].includes(document.querySelector('#save-status').textContent));};
 await options.locator('#ui-language').selectOption('en');assert.equal(await options.locator('#language').inputValue(),'system');await save();
 assert.match(await options.locator('#explanation-language-policy').innerText(),/Follow interface · English/);
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.waitForFunction(()=>document.documentElement.lang==='en');let seq=0;
 const query=async(action)=>{await popup.locator(`[data-action=${action}]`).click();await popup.locator('#text').fill(`测试原文 ${++seq}`);await popup.locator('#submit').click();await popup.locator('#answer').waitFor({state:'visible'});await popup.waitForFunction(()=>!['停止生成','Stop generating'].includes(document.querySelector('#submit').textContent));};
 await query('explain');assert.match(requests.at(-1).messages[0].content,/Respond in English/);
 await query('translate');assert.match(requests.at(-1).messages[0].content,/into English/);assert.equal(await popup.locator('.target-language').inputValue(),'system');
 await popup.locator('.target-language').selectOption('ja');await popup.waitForFunction(()=>document.querySelector('#answer').textContent==='Mock response'&&!document.querySelector('#answer').hidden);assert.match(requests.at(-1).messages[0].content,/翻译为日本語|into Japanese/);
 await options.locator('#language').selectOption('简体中文');await options.locator('[data-page=languages]').click();await options.locator('#language-preferences .target-language').selectOption('ja');await save();
 await options.locator('[data-page=general]').click();await options.locator('#ui-language').selectOption('zh-CN');await save();await query('explain');assert.match(requests.at(-1).messages[0].content,/默认用简体中文回答/);await query('translate');assert.match(requests.at(-1).messages[0].content,/翻译为日本語|into Japanese/);
 await options.locator('#ui-language').selectOption('en');await save();await query('explain');assert.match(requests.at(-1).messages[0].content,/Respond in Simplified Chinese/);await query('translate');assert.match(requests.at(-1).messages[0].content,/翻译为日本語|into Japanese/);
 // Explicit bulk choice changes stored policies; merely changing the interface did not.
 await options.locator('#follow-system-outputs').click();assert.equal(await options.locator('#language').inputValue(),'system');await save();await options.reload();await options.waitForFunction(()=>document.querySelector('#language').value==='system');
 const stored=await options.evaluate(async()=> (await chrome.storage.local.get('plainly')).plainly);
 assert.equal(stored.language,'system');assert.equal(stored.translation.target,'system');assert.equal(stored.translation.learningLanguage,'auto');assert.equal(stored.profiles[0].apiKey,'fake-only');
 await query('explain');assert.match(requests.at(-1).messages[0].content,/Respond in English/);await query('learn');assert.match(requests.at(-1).messages[0].content,/OUTPUT LANGUAGE REQUIREMENT — Simplified Chinese only/);
 await options.locator('[data-page=languages]').click();await options.locator('#language-preferences .source-language').selectOption('ja');await options.locator('#language-preferences .translation-engine').selectOption('mymemory');await save();await query('translate');assert.equal(free.at(-1),'ja|en');
 await options.locator('[data-page=general]').click();await options.locator('#ui-language').selectOption('zh-CN');await save();await query('translate');assert.equal(free.at(-1),'ja|zh-CN');
 // A manual swap resolves the displayed system target into an explicit source language.
 await options.locator('[data-page=languages]').click();await options.locator('#language-preferences .swap-language').click();assert.equal(await options.locator('#language-preferences .source-language').inputValue(),'zh-CN');assert.equal(await options.locator('#language-preferences .target-language').inputValue(),'ja');
 await options.locator('[data-page=general]').click();await options.locator('#follow-system-outputs').click();await save();
 // Prompt editors show the actual localized built-ins, and fixed prompt language persists independently.
 await options.locator('#ui-language').selectOption('en');await save();
 await options.locator('[data-page=prompts]').click();
 assert.equal(await options.locator('#prompt-language').inputValue(),'system');
 for(let i=0;i<5;i++){await options.locator('#mode-list .list-item').nth(i).click();assert.doesNotMatch(await options.locator('#mode-name').inputValue(),/[\u4e00-\u9fff]/);assert.doesNotMatch(await options.locator('#mode-description').inputValue(),/[\u4e00-\u9fff]/);}
 await options.locator('#mode-list .list-item').first().click();
 for(const key of ['explanation','translate','learn','jevRank','jevExists','jevTrue','jevFalse','followExample','followSimpler']){
  await options.locator('#function-prompt').selectOption(key);
  assert.doesNotMatch(await options.locator('#function-prompt-text').inputValue(),/[\u4e00-\u9fff]/,key+' must show the English built-in');
 }
 assert.doesNotMatch(await options.locator('#mode-prompt').inputValue(),/[\u4e00-\u9fff]/);
 await options.locator('#prompt-language').selectOption('zh-CN');await save();await query('explain');assert.match(requests.at(-1).messages[0].content,/默认用English回答/);
 await options.reload();await options.waitForFunction(()=>document.querySelector('#prompt-language').value==='zh-CN');
 await options.locator('#prompt-language').selectOption('system');await save();await query('explain');assert.doesNotMatch(requests.at(-1).messages[0].content,/[\u4e00-\u9fff]/);assert.match(requests.at(-1).messages[0].content,/Respond in English/);
 await options.locator('#function-prompt').selectOption('explanation');
 await options.locator('#function-prompt-text').fill('CUSTOM 保留原文 {{language}} {{modePrompt}}');
 await options.locator('#mode-name').fill('自定义名称');await options.locator('#mode-description').fill('Custom description'); await options.locator('#mode-prompt').fill('CUSTOM MODE 保留原文');await save();
 await options.locator('[data-page=general]').click();await options.locator('#ui-language').selectOption('zh-CN');await save();
 await options.locator('[data-page=prompts]').click();assert.equal(await options.locator('#function-prompt-text').inputValue(),'CUSTOM 保留原文 {{language}} {{modePrompt}}');assert.equal(await options.locator('#mode-prompt').inputValue(),'CUSTOM MODE 保留原文');
 await query('explain');assert.match(requests.at(-1).messages[0].content,/CUSTOM 保留原文 简体中文 CUSTOM MODE 保留原文/);
 await options.locator('#restore-function-prompt').click();options.once('dialog',dialog=>dialog.accept());await options.locator('#restore-mode').click();await save();
 await options.locator('[data-page=general]').click();await options.locator('#ui-language').selectOption('en');await save();
 await query('explain');assert.doesNotMatch(requests.at(-1).messages[0].content,/[\u4e00-\u9fff]/);assert.match(requests.at(-1).messages[0].content,/Respond in English/);
 await options.locator('[data-page=prompts]').click();assert.equal(await options.locator('#mode-name').inputValue(),'自定义名称');assert.equal(await options.locator('#mode-description').inputValue(),'Custom description');await options.locator('[data-page=general]').click();
 const finalSettings=await options.evaluate(async()=> (await chrome.runtime.sendMessage({type:'getSettings'})).value);assert.equal(finalSettings.profiles[0].apiKey,'fake-only');assert.equal(finalSettings.promptLanguage,'system');
 await mkdir('test-results',{recursive:true});await options.locator('#interface-settings').screenshot({path:'test-results/system-output-language.png'});
 assert.deepEqual(errors,[]);console.log('通过：显式跟随选项、解释和翻译真实请求参数、固定语言保留、一键修改及持久化、原文学习不变、免费翻译解析与手动交换；内置中英文提示词、显式语言选择、编辑器预览及自定义保留；未调用真实模型。');
 await writeFile('test-results/system-output-report.json',JSON.stringify({passed:true,modelRequests:requests.length,freeRequests:free.length,errors},null,2));
}finally{await context?.close();server.closeAllConnections();server.close();}
