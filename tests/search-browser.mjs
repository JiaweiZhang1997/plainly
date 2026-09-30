import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const results = [], requests = [], errors = [];
let behavior = 'normal', closed = 0;
const fixture = `<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{font:17px/1.9 system-ui;background:#f7f6f2;color:#28382b;margin:0}main{max-width:700px;margin:70px auto}p{padding:12px}#scroller{height:210px;overflow:auto;border:1px solid #c4cdbb;border-radius:10px}button{font-size:50px!important;color:red!important}.spacer{height:1200px}.hidden{display:none}</style><body><main><h1>日常使用说明</h1><p id="intro">欢迎使用我们的服务。这里记录一些常见问题。</p><nav>导航中的私密文字导航</nav><p hidden>HIDDEN_SECRET</p><p style="visibility:hidden">INVISIBLE_SECRET</p><p style="opacity:0">TRANSPARENT_SECRET</p><details><summary>折叠说明</summary><p>COLLAPSED_SECRET</p></details><input value="INPUT_SECRET"><div contenteditable>EDITOR_SECRET</div><p id="inline">账户<span>设置</span>里可以<b>修改昵称</b>。密码也在这里修改。</p><p id="duplicate1">这是一段重复文字。</p><p id="duplicate2">这是一段重复文字。</p><p>First English sentence. 第二句中文！<br>换行后的句子。</p><div id="scroller"><p>配送信息。</p><div class="spacer"></div><p id="target">商品<span>签收</span>后七天内，可在订单详情申请<b>退货退款</b>。超过期限请联系人工客服。</p><div class="spacer"></div></div><div class="spacer"></div><p id="bottom">最终说明。</p></main></body></html>`;
const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = ''; for await (const part of req) body += part;
    const payload = JSON.parse(body); requests.push({ payload, url: req.url, auth: req.headers.authorization });
    if (behavior === 'limited') { res.writeHead(429); res.end('PRIVATE_SECRET'); return; }
    if (behavior === 'broken') { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
    const passages = payload.state.passages, q = payload.questions.where.instructions.query;
    const best = q.includes('翻译保护') ? passages.find(s => s.text === '阅读偏好') : q.includes('重复') ? passages.filter(s => s.text.includes('重复')).at(-1) : q.includes('名字') ? passages.find(s => s.text.includes('昵称')) : passages.find(s => s.text.includes('退货'));
    const chosen = best || passages[0];
    const answer = { answers: { where: { type: 'choice', choice: chosen.id, probabilities: Object.fromEntries(passages.map(s => [s.id, s.id === chosen.id ? .9 : .1 / Math.max(1, passages.length - 1)])) }, exists: { type: 'noul', noul: q.includes('火星') ? .1 : best ? .9 : .15 } } };
    const send = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer)); };
    if (behavior === 'slow') { const timer = setTimeout(send, 3000); res.on('close', () => { clearTimeout(timer); closed++; }); }
    else send(); return;
  }
  res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(fixture);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir('test-results', { recursive: true });
let context;
try {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'plainly-search-')), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const options = await context.newPage(); options.on('pageerror', e => errors.push(e.message));
  await options.goto(`chrome-extension://${id}/options.html#search`);
  await options.waitForFunction(() => document.querySelector('#jev-model').value === 'jev-latest');
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  const tabId = await options.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url === `${origin}/`).id, origin);
  const isolated = async action => options.evaluate(async ({ tabId, action }) => (await chrome.scripting.executeScript({ target: { tabId }, func: async action => {
    const highlight = CSS.highlights.get('plainly-search-current');
    if (action === 'size') return highlight?.size;
    if (action === 'text') return [...highlight][0].toString();
    if (action === 'bounds') { const r = [...highlight][0].getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }
    if (action === 'parent') return [...highlight][0].startContainer.parentElement.id;
    if (action === 'has') return CSS.highlights.has('plainly-search-current');
    if (action === 'public') return (await chrome.runtime.sendMessage({ type: 'publicSettings' })).value;
    if (action === 'private') return chrome.runtime.sendMessage({ type: 'testJev', jev: { apiKey: 'bad' } });
  }, args: [action] }))[0].result, { tabId, action });
  // Script injection uses the same file as the toolbar and shortcut entry.
  async function open() {
    await page.bringToFront();
    const r = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'openSearch' })); assert.equal(r.ok, true, JSON.stringify(r));
    await page.locator('plainly-search #query').waitFor({ state: 'visible' });
  }
  const panel = page.locator('plainly-search');
  const status = panel.locator('#status');
  async function search(query) {
    await panel.locator('#query').fill(query); await panel.locator('#submit').click();
    await page.waitForFunction(() => document.querySelector('plainly-search').shadowRoot.querySelector('#submit').textContent === '找一找 ↗');
  }
  await open(); await panel.locator('#settings').waitFor({ state: 'visible' }); assert.equal(await panel.locator('#submit').isDisabled(), true); assert.equal(requests.length, 0);
  results.push('搜索按需加载，缺少密钥有设置入口，打开面板不发送网页');
  await options.locator('#jev-key').fill('fake-jev-key');
  await options.locator('#page-search .advanced summary').click();
  await options.locator('#jev-base').fill(`${origin}/v1`);
  await options.locator('#test-jev').click();
  await options.waitForFunction(() => document.querySelector('#jev-status').textContent.includes('连接成功'));
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#save-status').textContent.includes('已保存'));
  await panel.locator('#submit').waitFor({ state: 'visible' });
  await options.screenshot({ path: 'test-results/search-settings.png', fullPage: true });
  results.push('Jev 独立配置可测试保存，已打开面板即时生效');
  const beforeBody = await page.locator('body').innerHTML();
  await search('买了东西不想要了，能把钱拿回来吗');
  assert.match(await status.textContent(), /相关线索/);
  assert.match(await panel.locator('.result').first().textContent(), /退货退款/);
  assert.equal(requests.at(-1).auth, 'Bearer fake-jev-key'); assert.equal(requests.at(-1).url, '/v1/systemone');
  const sent = JSON.stringify(requests.at(-1).payload);
  for (const excluded of ['HIDDEN_SECRET', 'INVISIBLE_SECRET', 'TRANSPARENT_SECRET', 'COLLAPSED_SECRET', 'INPUT_SECRET', 'EDITOR_SECRET', '私密文字导航', '描述你记得']) assert.ok(!sent.includes(excluded), excluded);
  await panel.locator('.result').first().click();
  assert.ok(await page.locator('#scroller').evaluate(el => el.scrollTop > 100));
  const bounds = await page.locator('#target').boundingBox(); assert.ok(bounds.y >= 0 && bounds.y < 900);
  assert.equal(await isolated('size'), 1);
  assert.equal(await page.locator('body').innerHTML(), beforeBody, 'highlighting must not wrap or rewrite original DOM');
  await page.screenshot({ path: 'test-results/search-results.png' });
  results.push('同义查询流程、正文过滤、内联文本映射、嵌套滚动定位和无 DOM 改写高亮通过（模拟 API）');
  const count = requests.length; await search('买了东西不想要了，能把钱拿回来吗'); assert.equal(requests.length, count);
  results.push('相同页面与查询命中后台缓存');
  await panel.locator('#granularity').selectOption('sentence');
  await search('买的商品不要了');
  const texts = requests.at(-1).payload.state.passages.map(s => s.text);
  assert.ok(texts.includes('商品签收后七天内，可在订单详情申请退货退款。'));
  assert.ok(texts.includes('超过期限请联系人工客服。'));
  assert.ok(texts.includes('账户设置里可以修改昵称。'));
  assert.ok(texts.includes('换行后的句子。'));
  await panel.locator('.result').first().click();
  assert.equal(await isolated('text'), '商品签收后七天内，可在订单详情申请退货退款。');
  results.push('按句切分跨标签中英文本，定位只高亮实际命中句');
  await search('重复的文字'); await panel.locator('.result').first().click();
  assert.equal(await isolated('parent'), 'duplicate2');
  results.push('重复句子按独立位置定位，不会跳到第一处同文');
  await search('在火星上修飞船'); assert.match(await status.textContent(), /未找到明确结果/); assert.equal(await panel.locator('.result').count(), 0);
  results.push('无相关内容时不展示被迫选出的第一名');
  await search('如何换个名字'); await page.locator('#inline').evaluate(el => el.textContent = '页面已经换了内容。');
  await panel.locator('.result').first().click(); assert.match(await status.textContent(), /页面内容已变化/);
  results.push('SPA 内容变更后拒绝陈旧定位，提示重新搜索');
  behavior = 'slow'; await panel.locator('#query').fill('slow request'); await panel.locator('#submit').click();
  await page.waitForTimeout(250); await panel.locator('#submit').click();
  assert.match(await status.textContent(), /已停止/);
  behavior = 'normal'; await search('退款怎么做呢'); assert.match(await status.textContent(), /相关线索/);
  await page.waitForTimeout(150); assert.ok(closed > 0);
  results.push('停止会取消在途连接，新查询不被旧结果覆盖');
  behavior = 'limited'; await search('限流查询'); assert.match(await status.textContent(), /额度/); assert.ok(!(await status.textContent()).includes('PRIVATE_SECRET'));
  behavior = 'broken'; await search('损坏响应'); assert.match(await status.textContent(), /响应格式/);
  behavior = 'normal';
  results.push('限流及异常响应明确报错，不冒充无结果，不回显服务端内容');
  await page.evaluate(() => { const main = document.querySelector('main'); for (let i = 0; i < 160; i++) { const p = document.createElement('p'); p.textContent = `章节 ${i}：` + '日常生活的其他介绍。'.repeat(13); main.append(p); } });
  const multiStart = requests.length; await search('找退款流程');
  assert.ok(requests.length - multiStart >= 3);
  const finalIds = new Set(requests.at(-1).payload.state.passages.map(s => s.id));
  assert.ok(finalIds.size <= 24);
  assert.match(await panel.locator('.result').first().textContent(), /退货/);
  results.push('长页面分批提名后统一重排，所有请求保持片段和字符上限');
  await page.evaluate(() => { const main = document.querySelector('main'); for (let i = 0; i < 1000; i++) { const p = document.createElement('p'); p.textContent = `长页 ${i}：` + '这部分是独立的正文。'.repeat(10); main.append(p); } });
  await search('长文里的退款规则'); assert.match(await panel.locator('#coverage').textContent(), /仅搜索前.*后续内容未覆盖/);
  results.push('超长页明确显示实际覆盖片段数');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('plainly-search').count(), 0);
  assert.equal(await isolated('has'), false);
  await open(); await open(); assert.equal(await page.locator('plainly-search').count(), 1);
  await page.setViewportSize({ width: 390, height: 740 });
  const box = await panel.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await panel.locator('.result').first().click();
  assert.equal(await panel.locator('#compact').getAttribute('aria-expanded'), 'false');
  assert.ok((await panel.boundingBox()).height < 130);
  await panel.locator('#next').click();
  const compactBox = await panel.boundingBox(), marked = await isolated('bounds');
  assert.ok(marked.bottom <= compactBox.y || marked.top >= compactBox.y + compactBox.height, 'compact panel should not cover the highlighted heading');
  await page.screenshot({ path: 'test-results/search-narrow.png' });
  results.push('Esc 清理高亮，重复唤起不重复挂载，窄窗口不溢出');
  const projection = await isolated('public');
  assert.ok(!JSON.stringify(projection).includes('fake-jev-key')); assert.ok(!('jev' in projection));
  const rejected = await isolated('private'); assert.equal(rejected.ok, false);
  for (const { payload } of requests) {
    assert.ok(payload.state.passages.length <= 120);
    assert.ok(payload.state.passages.reduce((n, s) => n + s.text.length + s.heading.length + s.context.length + 40, 0) <= 12000);
  }
  results.push('内容脚本拿不到 Jev 密钥或测试权限，请求大小始终受控');
  await page.keyboard.press('Escape');
  await options.locator('#jev-key').fill(''); await options.locator('#jev-base').fill('https://api.typesafe.ai/v1');
  await options.locator('#save').click(); await options.waitForFunction(() => document.querySelector('#save-status').textContent.includes('已保存'));
  await open(); await panel.locator('#settings').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#submit').isDisabled(), true);
  assert.equal(await panel.locator('#granularity').inputValue(), 'sentence');
  results.push('关闭期间更改连接设置后，重开会更新可用状态并保留临时切分选项');
  // Search excerpts and headings may equal UI dictionary entries; only fallback labels translate.
  await page.keyboard.press('Escape');
  await options.evaluate(async origin => { const {value:s}=await chrome.runtime.sendMessage({type:'getSettings'});s.uiLanguage='en';s.jev.apiKey='fake-jev-key';s.jev.baseUrl=origin+'/v1';await chrome.runtime.sendMessage({type:'saveSettings',value:s}); }, origin);
  await page.evaluate(() => { document.querySelector('main').innerHTML='<h1>保存修改</h1><p>阅读偏好</p>'; });
  await open();
  const englishSearch=async query=>{await panel.locator('#query').fill(query);await panel.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('plainly-search').shadowRoot.querySelector('#submit').textContent==='Search ↗');};
  await englishSearch('翻译保护');
  const originalResult=panel.locator('.result').filter({hasText:'阅读偏好'}).first();
  assert.equal(await originalResult.locator('p').innerText(),'阅读偏好');
  assert.match(await originalResult.locator('small').innerText(),/保存修改/);
  await page.evaluate(()=>document.querySelector('main h1').remove());
  await englishSearch('翻译保护二');
  assert.match(await panel.locator('.result small').first().innerText(),/Source passage/);
  assert.equal(await panel.locator('.result p').first().innerText(),'阅读偏好');
  results.push('英文搜索保留与界面词条同名的原文和标题，仅翻译缺省标签');
  assert.deepEqual(errors, []);
  await writeFile('test-results/search-report.json', JSON.stringify({ passed: results.length, results, requests: requests.length, errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, requests: requests.length }, null, 2));
} catch (error) {
  await writeFile('test-results/search-failure.json', JSON.stringify({ results, errors, error: String(error) }, null, 2));
  if (context) for (const [i, page] of context.pages().entries()) await page.screenshot({ path: `test-results/search-failure-${i}.png` }).catch(() => {});
  throw error;
} finally { await context?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
