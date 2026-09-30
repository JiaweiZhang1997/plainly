import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const results = [], requests = [], errors = [];
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{background:#faf9f5;margin:0;font-family:system-ui;color:#30392f}main{max-width:760px;margin:90px auto;padding:0 40px}h1{font-size:36px;font-weight:500;letter-spacing:-1px}p{font-size:19px;line-height:2.2}small{color:#86907e;letter-spacing:2px}#edge{position:fixed;bottom:8px;right:8px;font-size:18px}button{font-size:60px!important;color:red!important;position:relative!important}#scroller{height:120px;overflow:auto;border:1px solid #ccc;padding:10px}.space{height:900px}iframe{height:130px;width:90%}</style></head><body><main><small>PLAINLY / READING TEST</small><h1>把注意力，留给阅读。</h1><p id="main-text">我们用 <span id="rag">RAG</span> 让 AI 先查资料，再回答问题。新的工具，应当让理解变得轻松。</p><p>评论区说：<span id="slang">这波属于降维打击了。</span></p><p id="multiline">一个看似熟悉的缩写，在另一个领域可能有完全不同的意思。结合上下文，解释才会恰到好处。</p><div id="scroller"><p>内部滚动区域里的 <span id="nested">API</span> 也应当正常解释。</p><div class="space"></div></div><p><input id="editable" value="password-like private input"><textarea>private draft</textarea></p><iframe src="/frame"></iframe><div class="space"></div></main><span id="edge">FOMO</span></body></html>`;
let behavior = 'normal';
const server = createServer(async (req, res) => {
  if (req.url === '/frame') { res.setHeader('content-type','text/html;charset=utf-8'); res.end('<p style="font:18px system-ui">框架中的 <span id="frame-word">LLM</span> 也可以解释。</p>'); return; }
  if (req.method === 'POST') {
    let body=''; for await (const c of req) body+=c;
    const payload=JSON.parse(body); requests.push({ url:req.url, payload, authorization:req.headers.authorization });
    if (behavior === 'unauthorized') { res.writeHead(401); res.end('do not echo secret-token'); return; }
    const protocol = req.url.includes('/messages') ? 'anthropic' : req.url.includes('streamGenerateContent') ? 'gemini' : 'openai';
    res.writeHead(200, { 'content-type':'text/event-stream', 'cache-control':'no-cache' });
    const text = protocol === 'anthropic' ? 'Claude 模拟解释。' : protocol === 'gemini' ? 'Gemini 模拟解释。' : '让 AI **先查资料，再回答**的一种方法。\n\n比如回答公司制度问题时，先从内部文档找到相关规定，再据此组织答案，减少凭空猜测。';
    let timer; const chunks = text.match(/.{1,8}/gs) || []; let i=0;
    const send = () => {
      if (res.destroyed) return;
      if (i < chunks.length) {
        const chunk = chunks[i++];
        const data = protocol === 'anthropic' ? { type:'content_block_delta',delta:{type:'text_delta',text:chunk} } : protocol === 'gemini' ? { candidates:[{content:{parts:[{text:chunk}]}}] } : { choices:[{delta:{content:chunk}}] };
        res.write(`data: ${JSON.stringify(data)}\n\n`); timer=setTimeout(send, behavior === 'slow' ? 130 : 12);
      } else {
        const data = protocol === 'anthropic' ? {type:'message_stop'} : protocol === 'gemini' ? {candidates:[{finishReason:'STOP'}]} : {choices:[{delta:{},finish_reason:'stop'}]};
        res.end(`data: ${JSON.stringify(data)}\n\n`);
      }
    }; timer=setTimeout(send, 40); res.on('close',()=>clearTimeout(timer));
    return;
  }
  res.setHeader('content-type','text/html;charset=utf-8'); res.end(fixture);
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=await mkdtemp(join(tmpdir(),'plainly-test-'));
await mkdir('test-results',{recursive:true});
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true, viewport:{width:1280,height:900},
    args:[`--disable-extensions-except=${resolve('dist')}`,`--load-extension=${resolve('dist')}`],
  });
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;
  const options=await context.newPage(); options.on('pageerror',e=>errors.push(e.message));
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(()=>document.querySelector('#default-mode').options.length===5);
  await options.screenshot({path:'test-results/settings.png',fullPage:true});
  results.push('设置页正确加载内置模式');
  await options.locator('[data-page=models]').click();
  await options.locator('#provider').selectOption('custom');
  await options.locator('#profile-name').fill('本地测试');
  await options.locator('#model').fill('fixture-model');
  await options.locator('#page-models .advanced summary').click();
  await options.locator('#base-url').fill(`${origin}/v1`);
  await options.locator('#api-key').fill('test-key-not-a-real-secret');
  await options.locator('#test-profile').click();
  await options.waitForFunction(()=>document.querySelector('#test-status').textContent.includes('连接成功'));
  await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));
  results.push('通过界面配置模型、测试连接并保存成功');
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin); await page.waitForTimeout(300);
  async function select(selector, target=page) {
    await target.locator(selector).dblclick();
    await target.locator('plainly-reader .trigger').waitFor({state:'visible',timeout:4000});
  }
  async function waitDone(target=page) {
    await target.waitForFunction(()=>document.querySelector('plainly-reader')?.shadowRoot?.querySelector('.status')?.textContent.includes('语境判断') || document.querySelector('plainly-reader')?.shadowRoot?.querySelector('.status')?.textContent.includes('近期解释'));
  }
  await options.locator('[data-page=general]').click();
  for (const corner of ['top-left','top-right','bottom-left','bottom-right']) {
    await options.locator('#trigger-corner').selectOption(corner); await options.locator('#save').click();
    await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存')); await page.waitForTimeout(100);
    await select('#rag');
    const rect=await page.evaluate(()=> {const r=getSelection().getRangeAt(0).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
    const button=page.locator('plainly-reader .trigger'), bounds=await button.boundingBox();
    assert.equal(bounds.width,24); assert.equal(bounds.height,24);
    const left=corner.endsWith('left')?rect.left-bounds.width-2:rect.right+2, top=corner.startsWith('top')?rect.top-bounds.height-2:rect.bottom+2;
    assert.ok(Math.abs(bounds.x-left)<1 && Math.abs(bounds.y-top)<1,`${corner} expected ${left},${top}; got ${bounds.x},${bounds.y}`);
    await button.hover(); const hovered=await button.boundingBox(); assert.deepEqual(hovered,bounds,'hover must not shift the trigger');
    if(corner==='top-right') await page.screenshot({path:'test-results/trigger-top-right.png'});
    await page.keyboard.press('Escape');
  }
  results.push('四角位置均精确贴合选区，悬停不会偏移');
  const iconInput=options.locator('#trigger-icon-file');
  await iconInput.setInputFiles({name:'star.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="15" fill="#5737dc"/><path d="m32 10 6 15 16 1-12 10 4 16-14-9-14 9 4-16-12-10 16-1z" fill="white"/></svg>')});
  await options.locator('#icon-crop-apply').click();
  await options.waitForFunction(()=>document.querySelector('#icon-upload-status').textContent.includes('图标已准备好'));
  assert.ok((await options.locator('.trigger-preview-button img').getAttribute('src')).startsWith('data:image/png;base64,'));
  await options.locator('#save').click(); await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存')); await page.waitForTimeout(100);
  await select('#rag'); await page.locator('plainly-reader .trigger img').waitFor();
  assert.equal(await page.locator('plainly-reader .trigger img').evaluate(el=>el.complete && el.naturalWidth),64);
  await page.screenshot({path:'test-results/trigger-custom-icon.png'});
  await page.mouse.wheel(0,70); await page.waitForTimeout(200);
  assert.ok(await page.locator('plainly-reader .trigger').isVisible());
  const scrollRect=await page.evaluate(()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return {right:r.right,bottom:r.bottom};});
  const scrolled=await page.locator('plainly-reader .trigger').boundingBox(); assert.ok(Math.abs(scrolled.x-scrollRect.right-2)<1&&Math.abs(scrolled.y-scrollRect.bottom-2)<1);
  await page.keyboard.press('Escape'); await page.evaluate(()=>window.scrollTo(0,0));
  await options.reload(); await options.waitForFunction(()=>document.querySelector('.trigger-preview-button img')?.complete);
  results.push('上传 SVG 本地转为小型 PNG，保存重开后保留，滚动时按钮跟随选区');
  await iconInput.setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await options.waitForFunction(()=>document.querySelector('#icon-upload-status').textContent.includes('无法读取'));
  assert.equal(await options.locator('.trigger-preview-button img').count(),1);
  await iconInput.setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(10*1024*1024+1)});
  await options.waitForFunction(()=>document.querySelector('#icon-upload-status').textContent.includes('不能超过'));
  await options.locator('#reset-trigger-icon').click();
  assert.equal(await options.locator('.trigger-preview-button svg.question-mark').count(),1);
  await options.locator('#save').click(); await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存')); await page.waitForTimeout(100);
  await select('#rag'); assert.equal(await page.locator('plainly-reader .trigger svg.question-mark').count(),1);
  await page.keyboard.press('Escape');
  await options.locator('.surface:has(#trigger-corner)').screenshot({path:'test-results/trigger-settings.png'});
  results.push('损坏和超大图片有明确提示，原图不丢失，可恢复默认按钮');
  const before=requests.length;
  await select('#rag'); assert.equal(requests.length,before,'selecting alone must not call model');
  await page.locator('plainly-reader .trigger').click(); await waitDone();
  assert.ok((await page.locator('plainly-reader .answer').textContent()).includes('先查资料'));
  assert.ok(requests.at(-1).payload.messages[0].role==='system');
  assert.ok(requests.at(-1).payload.messages[1].content.includes('让 AI'));
  assert.equal(await page.locator('plainly-reader .answer').evaluate(el=>getComputedStyle(el).fontSize),'12px');
  const initialBox=await page.locator('plainly-reader .card').boundingBox(); const selectedBox=await page.locator('#rag').boundingBox();
  assert.ok(Math.abs(initialBox.x-selectedBox.x)<30,'card should appear beside selection, not viewport origin');
  assert.equal(await page.locator('plainly-reader .trigger').count(),1);
  await page.screenshot({path:'test-results/reading.png'});
  results.push('实际双击选词、点击按钮、流式解释、上下文及网页样式隔离通过');
  await page.locator('plainly-reader .copy').click();
  await page.locator('plainly-reader .expand').click(); await page.locator('plainly-reader .follow input').fill('这里适合用在什么地方？');
  await page.locator('plainly-reader .follow button').click(); await waitDone();
  assert.ok(requests.at(-1).payload.messages.some(m=>m.role==='assistant'));
  assert.equal(requests.at(-1).payload.messages.at(-1).content,'这里适合用在什么地方？');
  results.push('展开追问会保留当前解释的上下文');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('plainly-reader').count(),0);
  const count=requests.length; await select('#rag'); await page.locator('plainly-reader .trigger').click(); await waitDone(); assert.equal(requests.length,count);
  results.push('Esc 关闭与相同语境缓存命中通过');
  await page.locator('plainly-reader .mode').selectOption('slang'); await waitDone(); assert.ok(requests.at(-1).payload.messages[0].content.includes('潜台词'));
  const storedMode=await options.evaluate(async()=> (await chrome.storage.local.get('plainly')).plainly.defaultMode); assert.equal(storedMode,'smart');
  results.push('卡片切换模式使用对应提示词且不修改全局默认');
  await page.keyboard.press('Escape');
  await select('#edge'); await page.locator('plainly-reader .trigger').click(); await waitDone();
  const box=await page.locator('plainly-reader .card').boundingBox(); assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=1280&&box.y+box.height<=900);
  await page.locator('plainly-reader .pin').click(); await page.mouse.wheel(0,450); await page.waitForTimeout(150); assert.ok(await page.locator('plainly-reader .card').isVisible());
  results.push('窗口边缘自动避让与固定后滚动通过');
  await page.keyboard.press('Escape'); await page.evaluate(()=>window.scrollTo(0,0));
  await options.locator('[data-page=prompts]').click(); await options.locator('#add-mode').click();
  await options.locator('#mode-name').fill('测试自定义'); await options.locator('#mode-prompt').fill('CUSTOM_PROMPT_MARKER 请解释互联网黑话。');
  await options.locator('#default-this-mode').click(); await options.locator('#save').click(); await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存'));
  await page.waitForTimeout(100); await select('#slang'); await page.locator('plainly-reader .trigger').click(); await waitDone();
  assert.ok(requests.at(-1).payload.messages[0].content.includes('CUSTOM_PROMPT_MARKER'));
  results.push('自定义模式编辑、设为默认、保存并即时应用通过');
  await page.keyboard.press('Escape');
  await options.locator('[data-page=general]').click(); await options.locator('.switch:has(#context)').click();
  await options.locator('.choice:has(input[value=auto])').click(); await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存')); await page.waitForTimeout(100);
  await page.locator('#rag').dblclick(); await page.locator('plainly-reader .card').waitFor({state:'visible'}); await waitDone();
  assert.equal(JSON.parse(requests.at(-1).payload.messages[1].content.split('\n').slice(1).join('\n'))['附近上下文'],'');
  results.push('自动解释模式及关闭上下文通过');
  await page.keyboard.press('Escape');
  await options.locator('.choice:has(input[value=manual])').click(); await options.locator('#save').click(); await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存')); await page.waitForTimeout(100);
  await page.locator('#rag').dblclick(); await page.waitForTimeout(750); assert.equal(await page.locator('plainly-reader').count(),0);
  results.push('仅手动模式不自动打扰选字');
  await options.locator('.choice:has(input[value=click])').click(); await options.locator('#disabled-sites').fill('127.0.0.1'); await options.locator('#save').click(); await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存')); await page.waitForTimeout(100);
  await page.locator('#rag').dblclick(); await page.waitForTimeout(150); assert.equal(await page.locator('plainly-reader').count(),0);
  results.push('按域名暂停划词通过');
  await options.locator('#disabled-sites').fill(''); await options.locator('#save').click(); await options.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已保存')); await page.waitForTimeout(100);
  await page.locator('#editable').selectText(); await page.waitForTimeout(150); assert.equal(await page.locator('plainly-reader').count(),0);
  results.push('输入区域不会误触划词解释');
  const frame=page.frames().find(f=>f.url().endsWith('/frame'));
  await select('#frame-word',frame); await frame.locator('plainly-reader .trigger').click(); await waitDone(frame);
  results.push('嵌入框架中的划词窗口通过');
  await frame.locator('plainly-reader .close').click();
  behavior='slow'; await select('#nested'); await page.locator('plainly-reader .trigger').click(); await page.waitForTimeout(120); await page.keyboard.press('Escape');
  behavior='normal'; await select('#rag'); await page.locator('plainly-reader .trigger').click(); await waitDone(); await page.waitForTimeout(300); assert.equal(await page.locator('plainly-reader .term').textContent(),'RAG');
  results.push('取消慢请求并切换选区后不会被旧响应覆盖');
  await page.keyboard.press('Escape');
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'clearCache'})); behavior='unauthorized';
  await select('#rag'); await page.locator('plainly-reader .trigger').click(); await page.locator('plainly-reader .status.error').waitFor({state:'visible'});
  assert.ok((await page.locator('plainly-reader .status').textContent()).includes('API Key')); assert.ok(!(await page.locator('plainly-reader .status').textContent()).includes('secret-token'));
  behavior='normal'; await page.locator('plainly-reader .retry').click(); await waitDone();
  results.push('授权错误提示与原地重试通过，错误内容不泄露服务端正文');
  const popup=await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`); await popup.locator('#text').fill('FOMO'); await popup.locator('#submit').click(); await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('语境判断')); assert.ok((await popup.locator('#answer').textContent()).length>10);
  results.push('工具栏手动输入解释通过');
  // Exercise native Anthropic and Gemini adapters through the extension's real worker.
  for (const protocol of ['anthropic','gemini']) {
    const test=await options.evaluate(async ({protocol,origin})=> {
      const saved=(await chrome.storage.local.get('plainly')).plainly; const profile={...saved.profiles[0],protocol,baseUrl:`${origin}/v1`};
      return chrome.runtime.sendMessage({type:'testProfile',profile});
    },{protocol,origin}); assert.equal(test.ok,true,JSON.stringify(test));
  }
  results.push('三种 API 协议均通过本地模拟服务的端到端流式测试');
  await page.bringToFront(); await page.keyboard.press('Escape'); await page.evaluate(()=>window.scrollTo(0,0));
  const drag=await page.locator('#multiline').boundingBox();
  await page.mouse.move(drag.x+2,drag.y+10); await page.mouse.down(); await page.mouse.move(drag.x+30,drag.y+drag.height-10,{steps:18}); await page.mouse.up();
  await page.locator('plainly-reader .trigger').waitFor({state:'visible'}); await page.locator('plainly-reader .trigger').click(); await waitDone();
  assert.ok((await page.locator('plainly-reader .term').textContent()).length>15);
  results.push('真实鼠标跨行拖选正常触发');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:740}); await select('#rag'); await page.locator('plainly-reader .trigger').click(); await waitDone();
  const narrow=await page.locator('plainly-reader .card').boundingBox(); assert.ok(narrow.x>=12&&narrow.x+narrow.width<=378);
  results.push('窄窗口下划词卡片仍留在可视区域');
  const isolated=await options.evaluate(async origin=> {
    const tab=(await chrome.tabs.query({})).find(t=>t.url===origin+'/');
    return chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=> {
      let storageBlocked=false;
      try { await chrome.storage.local.get('plainly'); } catch { storageBlocked=true; }
      const message=await chrome.runtime.sendMessage({type:'getSettings'});
      return {storageBlocked,messageBlocked:!message.ok};
    }});
  },origin);
  assert.equal(isolated[0].result.storageBlocked,true); assert.equal(isolated[0].result.messageBlocked,true);
  results.push('真实内容脚本无法读取密钥存储或调用受保护设置接口');
  await options.locator('#theme').selectOption('dark'); await options.waitForTimeout(200); await options.screenshot({path:'test-results/settings-dark.png',fullPage:true});
  await options.locator('#theme').selectOption('light'); await options.setViewportSize({width:430,height:850}); await options.waitForTimeout(200); await options.screenshot({path:'test-results/settings-mobile.png',fullPage:true});
  assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  results.push('深色主题及窄窗口布局无横向溢出');
  assert.deepEqual(errors,[]);
  await writeFile('test-results/report.json',JSON.stringify({passed:results.length,results,errors,requests:requests.length},null,2));
  console.log(JSON.stringify({passed:results.length,results,requests:requests.length},null,2));
} catch(error) {
  await writeFile('test-results/failure.json',JSON.stringify({results,errors,error:String(error)},null,2));
  if(context)for(const [i,page]of context.pages().entries())await page.screenshot({path:`test-results/failure-${i}.png`}).catch(()=>{});
  throw error;
} finally { await context?.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
