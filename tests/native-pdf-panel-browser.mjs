import { chromium } from 'playwright-core';
import { mkdtemp, writeFile, cp, readFile } from 'node:fs/promises';
import { join } from 'node:path'; import { tmpdir } from 'node:os'; import { createServer } from 'node:http'; import assert from 'node:assert/strict';
const fixtureSource=await readFile('tests/pdf-auto-browser.mjs','utf8');
const pdf=Function(fixtureSource.slice(fixtureSource.indexOf('function fixture()'),fixtureSource.indexOf('const pdf = fixture()'))+'return fixture()')();
const requests=[],results=[],errors=[];
const server=createServer(async(req,res)=>{
 if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);requests.push(data);res.setHeader('content-type','application/json');
  if(JSON.stringify(data).includes('Slow selection'))await new Promise(r=>setTimeout(r,900));
  res.end(JSON.stringify({choices:[{message:{content:`回答 ${requests.length}：这是模拟的解释或翻译。`},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:12,total_tokens:20}}));return;}
 if(req.url==='/other'){res.setHeader('content-type','text/html');res.end('<p>Another document</p>');return;}
 res.setHeader('content-type','application/pdf');res.end(pdf);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const dir=await mkdtemp(join(tmpdir(),'plainly-native-panel-'));let context;
try{
 // Instrument only the disposable extension copy to invoke the real context-menu handler.
 // Browser PDF selection is real; the OS context-menu callback is replayed via a click gesture.
 const ext=join(dir,'extension');await cp(process.env.PLAINLY_EXTENSION_DIR || 'dist',ext,{recursive:true});const bg=join(ext,'background.js');
 await writeFile(bg,`const originalAdd=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);chrome.contextMenus.onClicked.addListener=listener=>{globalThis.testMenu=listener;originalAdd(listener)};chrome.runtime.onMessage.addListener((msg,sender,reply)=>{if(msg.type==='__testMenu'){globalThis.testMenu(msg.info,msg.tab);reply(true)}});\n`+await readFile(bg,'utf8'));
 context=await chromium.launchPersistentContext(join(dir,'profile'),{channel:'chromium',headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
 const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);
 await options.evaluate(async origin=>{const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.profiles[0].baseUrl=origin+'/v1';s.profiles[0].model='mock';s.profiles[0].apiKey='';await chrome.runtime.sendMessage({type:'saveSettings',value:s});},origin);
 const page=await context.newPage();await page.goto(origin+'/download');
 await page.waitForTimeout(800);assert.equal(page.url(),origin+'/download');
 const native=page.frames().find(f=>f.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'));assert.ok(native);
 await native.waitForFunction(()=>document.querySelector('pdf-viewer')?.loadProgress_===100);
 await page.mouse.click(400,300);await page.keyboard.press('Meta+a');
 const selection=await native.evaluate(()=>document.querySelector('pdf-viewer').pluginController_.getSelectedText());
 assert.match(selection.selectedText,/Serendipity/);
 const [sourceTab]=await worker.evaluate(()=>chrome.tabs.query({active:true,lastFocusedWindow:true}));
 const browserCDP=await context.browser().newBrowserCDPSession();let serial=0;const waiting=new Map();
 browserCDP.on('Target.receivedMessageFromTarget',event=>{const m=JSON.parse(event.message);if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
 async function attach(targetId){return(await browserCDP.send('Target.attachToTarget',{targetId,flatten:false})).sessionId;}
 async function command(sessionId,method,params={}){const seq=++serial;const answer=new Promise(resolve=>waiting.set(seq,resolve));await browserCDP.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:seq,method,params})});const r=await answer;if(r.error)throw new Error(JSON.stringify(r.error));return r.result;}
 async function evaluate(code){const r=await command(panelSession,'Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 async function until(check,label){for(let i=0;i<100;i++){if(await check())return;await page.waitForTimeout(100);}throw new Error('Timeout: '+label+' '+(typeof panelSession==='string'?await evaluate('document.body.innerText'):''));}
 let panelSession;
 async function menu(text){await options.bringToFront();await options.evaluate(({tab,text})=>{document.querySelector('#test-menu')?.remove();const b=document.createElement('button');b.id='test-menu';b.style.cssText='position:fixed;right:20px;top:20px;z-index:9999';b.textContent='test menu';b.onclick=()=>{chrome.tabs.update(tab.id,{active:true});chrome.runtime.sendMessage({type:'__testMenu',info:{menuItemId:'plainly-explain',selectionText:text,frameUrl:tab.url,pageUrl:tab.url},tab});};document.body.prepend(b);},{tab:sourceTab,text});await options.locator('#test-menu').click();}
 await menu(selection.selectedText);
 let target;await until(async()=>{target=(await browserCDP.send('Target.getTargets')).targetInfos.find(t=>t.url===`chrome-extension://${id}/sidepanel.html`);return !!target;},'side panel target');panelSession=await attach(target.targetId);await command(panelSession,'Runtime.enable');
 await until(()=>evaluate(`document.querySelector('#answer')?.textContent.includes('模拟')`),'first answer');
 assert.match(await evaluate(`document.querySelector('#text').value`),/Serendipity/);assert.equal(page.url(),origin+'/download');assert.equal(await evaluate(`document.querySelector('#open-pdf').hidden`),false);
 assert.equal(JSON.parse(requests[0].messages[1].content.split('\n').slice(1).join('\n'))['附近上下文'],'');
 results.push('原生 PDF 保持打开；真实选中文字经右键处理入口在实际侧栏显示解释，无须复制粘贴，非 .pdf 地址也能识别');
 const count=requests.length;await evaluate(`document.querySelector('[data-action="translate"]').click();document.querySelector('#submit').click()`);await until(()=>evaluate(`document.querySelector('#submit').textContent!=='停止生成'`),'translation');assert.equal(requests.length,count+1);assert.ok(!requests.at(-1).messages[0].content.includes('跨学科'));results.push('同一侧栏切换双语翻译，复用原选区和已有模型配置');
 await menu('Slow selection');await until(()=>evaluate(`document.querySelector('#text').value==='Slow selection'`),'slow selection');await menu('Latest selection');await until(()=>evaluate(`document.querySelector('#text').value==='Latest selection' && document.querySelector('#submit').textContent!=='停止生成' && !document.querySelector('#answer').hidden`),'latest selection');await page.waitForTimeout(1100);assert.equal(await evaluate(`document.querySelector('#text').value`),'Latest selection');
 results.push('连续右键新选区取消旧请求，慢响应不会覆盖新结果');
 const shot=await command(panelSession,'Page.captureScreenshot',{format:'png'});await writeFile('test-results/native-pdf-sidepanel.png',Buffer.from(shot.data,'base64'));
 const other=await context.newPage();await other.goto(origin+'/other');await until(()=>evaluate(`document.querySelector('#text').value==='' && document.querySelector('#answer').hidden`),'switch tab clears');const beforeReturn=requests.length;await page.bringToFront();await until(()=>evaluate(`document.querySelector('#text').value==='Latest selection'`),'return to tab');await page.waitForTimeout(200);assert.equal(requests.length,beforeReturn);
 results.push('标签页内容隔离，切换文档清空旧结果，回到旧选区不会自动重复请求');
 await evaluate(`document.querySelector('#open-pdf').click()`);await page.waitForFunction(()=>document.querySelector('#pdf-status')?.textContent.includes('选中文字'));assert.ok(page.url().startsWith(`chrome-extension://${id}/pdf.html`));
 results.push('侧栏一键在原标签切换释义阅读器，保留全文检索和原文高亮入口');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.length,results},null,2));await writeFile('test-results/native-pdf-panel-report.json',JSON.stringify({passed:results.length,results},null,2));
}finally{await context?.close();await new Promise(r=>server.close(r));}
