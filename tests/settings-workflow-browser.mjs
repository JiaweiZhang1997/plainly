import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
let context; const errors=[], results=[];
try {
 context=await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'plainly-settings-')), {channel:'chromium',headless:true,viewport:{width:1440,height:980},args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto(`chrome-extension://${id}/options.html`);await page.waitForFunction(()=>document.querySelector('#provider-presets').children.length>=6);
 async function rpc(type,data={}) {return page.evaluate(async({type,data})=>{const r=await chrome.runtime.sendMessage({type,...data});if(!r.ok)throw new Error(r.error);return r.value},{type,data});}
 const settings=await rpc('getSettings');assert.equal(settings.pdfAutoOpen,false);assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules())).length,0);
 settings.profiles[0].apiKey='test-key-stays-local';await rpc('saveSettings',{value:settings});await page.reload();await page.locator('[data-page=models]').click();
 for(const provider of ['openai','anthropic','gemini','qwen','openrouter','moonshot','zhipu']) { await page.locator(`[data-preset=${provider}]`).click();assert.ok(await page.locator('#model').inputValue());assert.ok(await page.locator('#base-url').inputValue());assert.equal(await page.locator('#api-key').inputValue(),''); }
 for (const [provider, model, base] of [['openrouter','openrouter/auto','https://openrouter.ai/api/v1'],['moonshot','kimi-k3','https://api.moonshot.cn/v1'],['zhipu','glm-5.3','https://open.bigmodel.cn/api/paas/v4']]) {
  await page.locator(`[data-preset=${provider}]`).click();assert.equal(await page.locator('#model').inputValue(),model);assert.equal(await page.locator('#base-url').inputValue(),base);
  await page.locator('#api-key').fill(`test-${provider}`);await page.locator('#model').fill(`${model}-user-choice`);
  await page.locator(`[data-preset=${provider}]`).click();assert.equal(await page.locator('#api-key').inputValue(),`test-${provider}`);assert.equal(await page.locator('#model').inputValue(),`${model}-user-choice`);
 }
 await page.locator('[data-preset=openai]').click();await page.locator('#api-key').fill('test-openai');await page.locator('[data-preset=openai]').click();assert.equal(await page.locator('#api-key').inputValue(),'test-openai');assert.equal(await page.locator('#profile-list .list-item').count(),8);
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));const saved=await rpc('getSettings');assert.equal(saved.profiles[0].apiKey,'test-key-stays-local');assert.equal(saved.activeProfile,settings.activeProfile);
 await page.reload();await page.locator('[data-page=models]').click();
 for (const provider of ['openrouter','moonshot','zhipu']) { await page.locator(`[data-preset=${provider}]`).click();assert.equal(await page.locator('#api-key').inputValue(),`test-${provider}`);assert.ok((await page.locator('#model').inputValue()).endsWith('-user-choice')); }
 await page.locator('[data-preset=jev]').click();assert.ok(await page.locator('#jev-key').isVisible());assert.equal(await page.locator('#jev-model').inputValue(),'jev-latest');
 await page.locator('[data-page=models]').click();assert.equal(await page.locator('[data-preset=zhipu] strong').innerText(),'GLM');
 assert.equal(await page.locator('#api-guide').evaluate(el=>el.open),false);
 await page.locator('#api-guide > summary').click();await page.locator('#custom-api-guide > summary').click();
 assert.ok(await page.getByText('填写示例 · OpenAI 兼容平台',{exact:true}).isVisible());
 assert.equal(await page.locator('#api-guide a[target=_blank]').count(),9);
 await page.locator('#api-guide').evaluate(el=>el.querySelectorAll('details').forEach(d=>d.open=true));
 await page.screenshot({path:'test-results/api-guide.png',fullPage:true});
 for (const size of [{width:390,height:720},{width:1440,height:980}]) {await page.setViewportSize(size);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.locator('#api-guide > summary').click();
 results.push('默认保留原生 PDF；接口预设一键添加、不重复创建、不覆盖旧密钥或当前模型，Jev 入口可用');
 await page.locator('[data-page=general]').click();await page.locator('#appearance-cardWidth-number').fill('600');await page.locator('#appearance-cardMaxHeight-number').fill('360');await page.locator('#appearance-fontSize-number').fill('20');
 async function metrics(){return page.locator('#appearance-preview').evaluate(el=>({width:parseFloat(getComputedStyle(el).width),height:parseFloat(getComputedStyle(el).height),box:el.getBoundingClientRect().toJSON(),font:getComputedStyle(el.querySelector('p')).fontSize}));}
 let m=await metrics();assert.equal(m.width,600);assert.equal(m.height,360);assert.equal(m.font,'20px');assert.ok(Math.abs(m.box.width/m.box.height-600/360)<.01);
 await page.locator('#appearance-cardWidth-number').fill('300');await page.locator('#appearance-cardMaxHeight-number').fill('800');m=await metrics();assert.equal(m.width,300);assert.equal(m.height,800);assert.ok(Math.abs(m.box.width/m.box.height-300/800)<.01);
 await page.locator('#appearance-cardWidth-number').fill('560');await page.locator('#appearance-cardMaxHeight-number').fill('420');
 await page.locator('#appearance-summary').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/settings-live-preview.png'});
 results.push('窗口预览同步真实宽高、字号与宽高比例，空间不足时标注缩放比例');
 for(const size of [{width:1440,height:980},{width:390,height:720}]) {await page.setViewportSize(size);for(const section of ['general','models','prompts','search']) {await page.locator(`[data-page=${section}]`).click();await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));let box=await page.locator('#save').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=size.height&&box.x>=0&&box.x+box.width<=size.width);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}}
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));await page.reload();assert.equal(await page.locator('#appearance-cardWidth-number').inputValue(),'560');
 results.push('桌面和窄窗口长页面中保存按钮始终可见，保存后刷新保留设置，无横向溢出');
 await page.setViewportSize({width:1440,height:980});await page.locator('[data-page=models]').click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/model-presets.png'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.length,results},null,2));await writeFile('test-results/settings-workflow-report.json',JSON.stringify({passed:results.length,results},null,2));
}finally{await context?.close();}
