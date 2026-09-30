import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const requests = [], errors = [], results = [];
const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '这是一段用于检查窗口滚动与文字大小的解释。\n'.repeat(80) }, finish_reason: 'stop' }] })); return;
  }
  res.setHeader('content-type', 'text/html;charset=utf-8'); res.end('<!doctype html><style>body{padding:100px 20px;font:20px system-ui}#word{display:inline-block}</style><p id="word">Serendipity</p>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'plainly-appearance-')), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(worker.url()).host;
  const options = await context.newPage(); options.on('pageerror', e => errors.push(e.message)); await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#enabled-actions').children.length === 4);
  await options.evaluate(async origin => {
    const response = await chrome.runtime.sendMessage({ type: 'getSettings' }); const s = response.value;
    s.profiles[0].baseUrl = `${origin}/v1`; s.profiles[0].apiKey = ''; s.profiles[0].model = 'mock';
    await chrome.runtime.sendMessage({ type: 'saveSettings', value: s });
  }, origin);
  await options.reload(); await options.waitForFunction(() => document.querySelector('#enabled-actions').children.length === 4);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin);
  for (const [field, value, lower] of [['fontSize',12,6],['cardWidth',350,200],['cardMaxHeight',580,180]]) {
    const range = options.locator(`#appearance-${field}`), number = options.locator(`#appearance-${field}-number`);
    assert.equal(Number(await range.inputValue()),500); assert.equal(Number(await number.inputValue()),value);
    await range.focus(); await range.press('ArrowLeft'); assert.equal(Number(await number.inputValue()),value-1);
    await range.press('ArrowRight'); assert.equal(Number(await range.inputValue()),500);
    await range.fill('0'); assert.equal(Number(await number.inputValue()),lower);
    assert.equal(await range.getAttribute('aria-valuetext'),`${lower} px`);
    await range.fill('500'); assert.equal(Number(await number.inputValue()),value);
  }
  results.push('默认值位于三个滑块中点；可拖到 6/200/180px 下限，方向键按 1px 微调，数字框同步');
  await options.locator('#appearance-fontSize-number').fill('24'); await options.locator('#appearance-cardWidth-number').fill('640'); await options.locator('#appearance-cardMaxHeight-number').fill('360');
  await options.locator('#length').selectOption('custom'); await options.locator('#target-characters').fill('2500');
  async function save() { await options.locator('#save').click(); await options.waitForFunction(() => document.querySelector('#save-status').textContent.includes('已保存')); }
  await save(); await options.reload(); assert.equal(await options.locator('#appearance-cardWidth-number').inputValue(), '640'); assert.equal(await options.locator('#target-characters').inputValue(), '2500');
  const card = page.locator('plainly-reader');
  async function open() { await page.locator('#word').dblclick(); await card.locator('.trigger').click(); await page.waitForFunction(() => document.querySelector('plainly-reader')?.shadowRoot.querySelector('.answer').textContent.length > 100); await card.locator('.stop').waitFor({ state: 'hidden' }); }
  await open();
  let box = await card.locator('.card').boundingBox(); assert.ok(Math.abs(box.width - 640) < .1); assert.ok(Math.abs(box.height - 360) < .1);
  assert.equal(await card.locator('.answer').evaluate(el => getComputedStyle(el).fontSize), '24px');
  assert.ok(await card.locator('.scroll').evaluate(el => el.scrollHeight > el.clientHeight));
  assert.match(requests.at(-1).messages[0].content, /约 2500 个字符/); assert.equal(requests.at(-1).max_tokens, 6024);
  await card.locator('.expand').click(); box = await card.locator('.card').boundingBox(); assert.ok(Math.abs(box.width - 730) < .1);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/reading-appearance.png' }); await card.locator('.expand').click();
  results.push('字号、宽高和自定义字数保存重开保留；已打开网页同步生效，长回答内部滚动，追问展开增加 90px');
  for (const action of ['translate', 'learn']) { await card.locator(`[data-action=${action}]`).click(); await card.locator('.stop').waitFor({ state: 'hidden' }); assert.equal(await card.locator('.answer').evaluate(el => getComputedStyle(el).fontSize), '24px'); assert.ok(!requests.at(-1).messages[0].content.includes('2500')); }
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`); await popup.locator('#text').fill('RAG'); await popup.locator('#submit').click(); await popup.locator('#answer').waitFor(); assert.equal(await popup.locator('#answer').evaluate(el => getComputedStyle(el).fontSize), '24px');
  results.push('翻译和同语学习共享正文大小，不受解释字数限制；工具栏正文同步字号');
  await page.setViewportSize({ width: 390, height: 480 }); await page.keyboard.press('Escape'); await open();
  box = await card.locator('.card').boundingBox(); assert.ok(box.x >= 11 && box.y >= 11 && box.x + box.width <= 379 && box.y + box.height <= 469);
  assert.ok(await card.locator('.close').isVisible()); await card.locator('.close').click();
  await options.locator('#appearance-cardWidth-number').fill('300'); await options.locator('#appearance-cardMaxHeight-number').fill('280'); await save(); await open();
  box = await card.locator('.card').boundingBox(); assert.ok(Math.abs(box.width - 300) < .1); assert.ok(Math.abs(box.height - 280) < .1); assert.ok(await card.locator('.close').isVisible());
  assert.ok(await card.locator('.scroll').evaluate(el => el.clientHeight > 50));
  results.push('大字号与最小窗口下正文可滚动，窄屏自动约束宽高，关闭操作保持可用');
  await page.keyboard.press('Escape');
  for (const field of ['fontSize','cardWidth','cardMaxHeight']) await options.locator(`#appearance-${field}`).fill('0');
  await save(); await options.reload(); await options.waitForFunction(()=>document.querySelector('#appearance-cardWidth-number').value==='200');
  assert.equal(await options.locator('#appearance-cardMaxHeight-number').inputValue(),'180');
  assert.equal(await options.locator('#appearance-preview').evaluate(el=>el.style.width),'200px');
  assert.equal(await options.locator('#appearance-preview').evaluate(el=>el.style.height),'180px');
  await open(); box = await card.locator('.card').boundingBox();
  assert.equal(Math.round(box.width),200); assert.equal(Math.round(box.height),180);
  assert.equal(await card.locator('.answer').evaluate(el=>getComputedStyle(el).fontSize),'6px');
  assert.ok(await card.locator('.scroll').evaluate(el=>el.clientHeight>0 && el.scrollHeight>el.clientHeight));
  const closeBox = await card.locator('.close').boundingBox(); assert.ok(closeBox.x>=box.x && closeBox.x+closeBox.width<=box.x+box.width);
  await card.locator('.close').click();
  results.push('更低字号与窗口尺寸保存重开保留、预览与真实卡片一致；最小窗口仍可滚动和关闭');
  await options.locator('#reset-appearance').click(); await save(); assert.equal(await options.locator('#appearance-fontSize-number').inputValue(), '12');
  await open(); assert.equal(await card.locator('.answer').evaluate(el => getComputedStyle(el).fontSize), '12px');
  for (const field of ['fontSize','cardWidth','cardMaxHeight']) assert.equal(Number(await options.locator(`#appearance-${field}`).inputValue()),500);
  await options.locator('section.surface').filter({has:options.locator('#appearance-fontSize')}).screenshot({path:'test-results/appearance-centered-defaults.png'});
  assert.deepEqual(errors, []); results.push('恢复默认立即生效，浏览器无未捕获错误');
  console.log(JSON.stringify({ passed: results.length, results }, null, 2)); await writeFile('test-results/reading-preferences-report.json', JSON.stringify({ passed: results.length, results }, null, 2));
} finally { await context?.close(); await new Promise(r => server.close(r)); }
