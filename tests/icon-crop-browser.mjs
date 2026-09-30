import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
let context; const errors = [], results = [];
try {
 await mkdir('test-results',{recursive:true});
 context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(),'plainly-crop-')), {channel:'chromium',headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`chrome-extension://${id}/options.html`);await page.waitForFunction(()=>document.querySelector('#trigger-size').value==='24');
 assert.equal(await page.locator('#appearance-fontSize-number').inputValue(),'12');
 await page.locator('#trigger-size').fill('40');await page.locator('#reset-trigger-size').click();assert.equal(await page.locator('#trigger-size').inputValue(),'24');
 const hasBuiltin=await page.locator('#preset-trigger-logo').count()>0;
 assert.equal(await page.locator('#reset-trigger-icon').innerText(),'');
 if(hasBuiltin){await page.locator('#preset-trigger-logo').click();assert.equal(await page.locator('#preset-trigger-logo').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#preset-trigger-logo').innerText(),'');}
 const currentIcon=async()=>await page.locator('.trigger-preview-button img').count()?page.locator('.trigger-preview-button img').getAttribute('src'):null;
 const logo=await currentIcon();
 if(hasBuiltin){assert.ok(logo.startsWith('data:image/png;base64,'));await page.locator('#reset-trigger-icon').click();assert.equal(await page.locator('.trigger-preview-button svg').count(),1);await page.locator('#preset-trigger-logo').click();}
 const file={name:'wide.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><path fill="red" d="M0 0h300v300H0z"/><path fill="lime" d="M300 0h300v300H300z"/><path fill="blue" d="M600 0h300v300H600z"/></svg>')};
 const upload=()=>page.locator('#trigger-icon-file').setInputFiles(file);
 const preview=page.locator('#icon-crop-preview');
 const pixel=()=>preview.evaluate(el=>Array.from(el.getContext('2d').getImageData(32,32,1,1).data));
 await upload();await page.locator('#icon-crop-dialog').waitFor({state:'visible'});assert.deepEqual(await pixel(),[0,255,0,255]);
 await page.locator('#icon-crop-cancel').click();await page.waitForFunction(()=>document.querySelector('#icon-upload-status').textContent.includes('已取消'));
 assert.equal(await currentIcon(),logo);
 await upload();await page.locator('#icon-crop-dialog').waitFor({state:'visible'});
 const canvas=page.locator('#icon-crop-canvas'), selection=page.locator('#icon-crop-selection');
 assert.deepEqual(await canvas.evaluate(el=>{const c=el.getContext('2d');return [150,450,750].map(x=>Array.from(c.getImageData(x,150,1,1).data));}),[[255,0,0,255],[0,255,0,255],[0,0,255,255]]);
 const initial=await selection.boundingBox();const corner=await page.locator('[data-crop-corner=se]').boundingBox();
 await page.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await page.mouse.down();await page.mouse.move(corner.x+corner.width/2-20,corner.y+corner.height/2-20,{steps:6});await page.mouse.up();
 const smaller=await selection.boundingBox();assert.ok(smaller.width<initial.width-15);assert.ok(Math.abs(smaller.width-smaller.height)<1);
 const box=await selection.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(0,box.y+box.height/2);await page.mouse.up();
 assert.deepEqual(await pixel(),[255,0,0,255]);
 assert.ok(await preview.evaluate(el=>{const data=el.getContext('2d').getImageData(0,0,64,64).data;return data.every((v,i)=>i%4!==3||v===255);}));
 await page.locator('#icon-crop-reset').click();assert.deepEqual(await pixel(),[0,255,0,255]);
 await selection.focus();for(let i=0;i<30;i++)await page.keyboard.press('Shift+ArrowRight');assert.deepEqual(await pixel(),[0,0,255,255]);
 await page.screenshot({path:'test-results/icon-crop-desktop.png'});
 const expected=await preview.evaluate(el=>el.toDataURL('image/png'));
 await page.locator('#icon-crop-apply').click();await page.waitForFunction(()=>document.querySelector('#icon-upload-status').textContent.includes('图标已准备好'));
 assert.equal(await page.locator('.trigger-preview-button img').getAttribute('src'),expected);
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));await page.reload();await page.waitForFunction(()=>document.querySelector('.trigger-preview-button img')?.complete);
 assert.equal(await page.locator('.trigger-preview-button img').getAttribute('src'),expected);
 results.push('24px / 12px 默认值、内置头像切换、完整原图、选框移动及四角调整、键盘移动、边界无白边、确认保存与取消保留均通过');
 await page.setViewportSize({width:390,height:720});await upload();await page.locator('#icon-crop-dialog').waitFor({state:'visible'});
 const dialog=await page.locator('#icon-crop-dialog').boundingBox();assert.ok(dialog.x>=0&&dialog.x+dialog.width<=390);assert.ok(dialog.y>=0&&dialog.y+dialog.height<=720);
 const apply=await page.locator('#icon-crop-apply').boundingBox();assert.ok(apply.y+apply.height<=720);
 await page.screenshot({path:'test-results/icon-crop-mobile.png'});await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#icon-upload-status').textContent.includes('已取消'));
 assert.equal(await page.locator('.trigger-preview-button img').getAttribute('src'),expected);
 await upload();await page.locator('#icon-crop-dialog').waitFor({state:'visible'});assert.deepEqual(await pixel(),[0,255,0,255]);await page.locator('#icon-crop-cancel').click();
 results.push('窄窗口完整显示、Esc 取消和重复上传同一图片正常');
 await page.setViewportSize({width:1280,height:900});
 assert.equal(await page.locator('.icon-preset').count(),2+Number(hasBuiltin));
 await page.locator('#icon-presets').screenshot({path:'test-results/icon-library-options.png'});
 assert.equal(await page.locator('[id^=uploaded-trigger-icon-][aria-pressed=true]').count(),1);
 assert.equal(await page.locator('[id^=uploaded-trigger-icon-] img').getAttribute('src'),expected);
 // Migrate a legacy selected upload, and preserve unrelated credentials/settings.
 await worker.evaluate(async()=>{const {plainly:s}=await chrome.storage.local.get('plainly');delete s.triggerIcons;delete s.showBuiltinIcon;s.profiles[0].apiKey='fake-preserved-key';s.jev.apiKey='fake-preserved-jev';await chrome.storage.local.set({plainly:s});});
 await page.reload();await page.locator('[id^=uploaded-trigger-icon-]').waitFor();
 assert.equal(await page.locator('.icon-preset').count(),2+Number(hasBuiltin));
 // Deleting an unselected built-in keeps the selected upload.
 if(hasBuiltin) await page.getByRole('button',{name:'删除内置头像',exact:true}).click();
 assert.equal(await page.locator('#preset-trigger-logo').count(),0);
 assert.equal(await page.locator('.trigger-preview-button img').getAttribute('src'),expected);
 if(hasBuiltin){await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));}
 await page.reload();await page.locator('[id^=uploaded-trigger-icon-]').waitFor();
 assert.equal(await page.locator('#preset-trigger-logo').count(),0);
 // Two separate uploads coexist and selecting either keeps both in the library.
 await upload();await page.locator('#icon-crop-apply').click();await page.waitForFunction(()=>document.querySelector('#icon-upload-status').textContent.includes('图标已准备好'));
 assert.equal(await page.locator('[id^=uploaded-trigger-icon-]').count(),2);
 await page.locator('#uploaded-trigger-icon-0').click();
 assert.equal(await page.locator('.trigger-preview-button img').getAttribute('src'),expected);
 await page.getByRole('button',{name:'删除上传图标 1',exact:true}).click();
 assert.equal(await page.locator('#reset-trigger-icon').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('.trigger-preview-button svg').count(),1);
 await page.getByRole('button',{name:'删除上传图标 1',exact:true}).click();
 assert.equal(await page.locator('.icon-preset').count(),1);assert.equal(await page.locator('.delete-icon').count(),0);
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));await page.reload();await page.locator('#reset-trigger-icon').waitFor();
 assert.equal(await page.locator('.icon-preset').count(),1);
 assert.deepEqual(await worker.evaluate(async()=>{const {plainly:s}=await chrome.storage.local.get('plainly');return [s.profiles[0].apiKey==='fake-preserved-key',s.jev.apiKey==='fake-preserved-jev',s.triggerIcons.length,s.showBuiltinIcon,s.triggerIcon];}),[true,true,0,!hasBuiltin,'']);
 await page.screenshot({path:'test-results/icon-library-question-only.png'});
 results.push('旧上传图标迁移、多个上传图标展示与切换、删除内置及上传图标、选中图标删除后恢复问号、重载持久化、保留密钥均通过');
 assert.deepEqual(errors,[]);await writeFile('test-results/icon-crop-report.json',JSON.stringify({passed:results.length,results},null,2));console.log(JSON.stringify({passed:results.length,results},null,2));
} finally {await context?.close();}
