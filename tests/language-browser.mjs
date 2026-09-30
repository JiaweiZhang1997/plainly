import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const results = [], requests = [], errors = [];
let behavior = 'normal', aborted = 0;
const fixture = '<!doctype html><html><meta charset="utf-8"><style>body{background:#f9f8f3;font:20px/2 system-ui;margin:120px 220px;color:#304431}p{margin-bottom:45px}button{font-size:60px!important}</style><body><h1>Reading & learning</h1><p>What a lovely moment of <span id="word">serendipity</span>.</p><p id="chinese">偶然的发现，有时也带来惊喜。</p></body></html>';
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST') {
    let raw = ''; for await (const part of req) raw += part;
    const payload = JSON.parse(raw); requests.push({ kind: 'llm', payload, auth: req.headers.authorization });
    const system = payload.messages[0].content;
    const output = system.startsWith('Identify the language') ? 'en' : system.includes('原语言学习助手') ? 'A happy discovery that happens by chance.\n\nVocabulary: An unexpected good event.' : system.includes('翻译为') ? '机缘巧合。' : '指意外遇到的美好事物。';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }] })); return;
  }
  if (url.pathname === '/free') {
    requests.push({ kind: 'free', query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(behavior === 'quota' ? { quotaFinished: true, responseStatus: 429 } : { responseStatus: 200, responseData: { translatedText: '机缘巧合 &amp; 幸运 &lt;img onerror=alert(1)&gt;' } })); return;
  }
  if (url.pathname.startsWith('/dictionary/')) {
    const word = url.pathname.split('/').at(-1); requests.push({ kind: 'dictionary', word, auth: req.headers.authorization });
    if (behavior === 'missing') { res.writeHead(404); res.end('{}'); return; }
    const send = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ word, phonetic: '/ˌserənˈdɪpəti/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'An unexpected fortunate discovery.', example: 'It was pure serendipity.' }] }], license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' }, sourceUrls: ['https://en.wiktionary.org/wiki/serendipity'] }])); };
    if (behavior === 'slow') { const timer = setTimeout(send, 5000); res.on('close', () => { clearTimeout(timer); aborted++; }); } else send(); return;
  }
  res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(fixture);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir('test-results', { recursive: true }); let context;
try {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'plainly-language-')), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(worker.url()).host;
  // Only this disposable worker redirects public-service requests to a local test fixture.
  await worker.evaluate(origin => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.mymemory.translated.net') return original(`${origin}/free${url.search}`, init);
      if (url.hostname === 'api.dictionaryapi.dev') return original(`${origin}/dictionary/${url.pathname.split('/').at(-1)}`, init);
      return original(input, init);
    };
  }, origin);
  const options = await context.newPage(); options.on('pageerror', e => errors.push(e.message));
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#enabled-actions').children.length === 4);
  await options.locator('[data-page=models]').click(); await options.locator('#provider').selectOption('custom');
  await options.locator('#model').fill('mock-model'); await options.locator('#api-key').fill('fake-llm-key');
  await options.locator('#page-models .advanced summary').click(); await options.locator('#base-url').fill(`${origin}/v1`);
  async function save() { await options.locator('#save').click(); await options.waitForFunction(() => document.querySelector('#save-status').textContent.includes('已保存')); }
  await save();
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin); await page.waitForTimeout(150);
  const card = page.locator('plainly-reader');
  async function select() { await page.bringToFront(); await page.locator('#word').dblclick(); await card.locator('.trigger').waitFor({ state: 'visible' }); }
  async function done() { await card.locator('.card').waitFor({ state: 'visible' }); await card.locator('.stop').waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.querySelector('plainly-reader')?.shadowRoot.querySelector('.answer').textContent.length > 0); }
  await options.locator('[data-page=general]').click();
  for (const size of [20, 34, 56]) {
    await options.locator('#trigger-size').evaluate((el, size) => { el.value = String(size); el.dispatchEvent(new Event('input', { bubbles: true })); }, size);
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      await options.locator('#trigger-corner').selectOption(corner); await save(); await page.waitForTimeout(70); await select();
      const box = await card.locator('.trigger').boundingBox(); assert.equal(box.width, size); assert.equal(box.height, size);
      const anchor = await page.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
      assert.ok(Math.abs(box.x - (corner.endsWith('left') ? anchor.left - size - 2 : anchor.right + 2)) < 1);
      assert.ok(Math.abs(box.y - (corner.startsWith('top') ? anchor.top - size - 2 : anchor.bottom + 2)) < 1);
      await page.keyboard.press('Escape');
    }
  }
  await options.locator('#trigger-icon-file').setInputFiles({ name: 'icon.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#6954af"/><circle cx="32" cy="32" r="14" fill="white"/></svg>') });
  await options.locator('#icon-crop-apply').click();
  await options.waitForFunction(() => document.querySelector('#icon-upload-status').textContent.includes('图标已准备好')); await save(); await page.waitForTimeout(70); await select();
  assert.equal((await card.locator('.trigger img').boundingBox()).width, 56);
  await page.screenshot({ animations: 'disabled', path: 'test-results/trigger-size-56.png' }); await page.keyboard.press('Escape');
  results.push('20/34/56px 在四角均保持 2px 间距，上传图标同步缩放');

  // All four enabled: saving a new default must update existing tabs and actual requests.
  const panel = await context.newPage(); panel.on('pageerror', e => errors.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelector('[data-action=explain]')?.getAttribute('aria-pressed') === 'true');
  await options.locator('#default-action').selectOption('translate'); await save();
  await panel.waitForFunction(() => document.querySelector('#reading-actions button')?.dataset.action === 'translate' && document.querySelector('[data-action=translate]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(await panel.locator('#mode').isVisible(), false);
  await panel.close();
  await options.reload(); await options.waitForFunction(() => document.querySelector('#default-action').value === 'translate');
  await select(); await card.locator('.trigger').click(); await done();
  assert.equal(await card.locator('.reading-actions button').first().getAttribute('data-action'), 'translate');
  assert.equal(await card.locator('[data-action=translate]').getAttribute('aria-pressed'), 'true');
  assert.equal(await card.locator('.mode').isVisible(), false);
  assert.match(requests.filter(r => r.kind === 'llm').at(-1).payload.messages[0].content, /翻译为/);
  // A temporary mode switch must not replace the saved default for the next selection.
  await card.locator('[data-action=explain]').click(); await done(); await page.keyboard.press('Escape');
  await select(); await card.locator('.trigger').click(); await done();
  assert.equal(await card.locator('[data-action=translate]').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  const defaultPopup = await context.newPage(); await defaultPopup.goto(`chrome-extension://${id}/popup.html`);
  await defaultPopup.waitForFunction(() => document.querySelector('#reading-actions button')?.dataset.action === 'translate');
  assert.equal(await defaultPopup.locator('[data-action=translate]').getAttribute('aria-pressed'), 'true'); await defaultPopup.close();
  results.push('四项全选时默认翻译排在首位并实际调用翻译，临时切换不改变下次默认；已打开侧栏与工具栏弹窗同步');

  for (const value of ['explain', 'learn', 'dictionary']) await options.locator(`#enabled-actions input[value=${value}]`).uncheck();
  assert.equal(await options.locator('#default-action').inputValue(), 'translate');
  await options.locator('#enabled-actions input[value=translate]').click();
  assert.equal(await options.locator('#enabled-actions input[value=translate]').isChecked(), true);
  await options.locator('[data-page=languages]').click();
  await options.locator('#language-preferences .source-language').selectOption('en');
  await options.locator('#learning-preferences .learning-level').selectOption('A2'); await save();
  await page.waitForTimeout(100); await select(); await card.locator('.trigger').click(); await done();
  assert.equal(await card.locator('.reading-actions').isVisible(), false);
  assert.match(requests.at(-1).payload.messages[0].content, /从English翻译为简体中文/);
  assert.equal(await page.locator('plainly-reader').count(), 1);
  results.push('功能可多选且至少保留一项；单选翻译直接打开，不额外显示悬浮按钮');

  await page.keyboard.press('Escape'); await options.locator('[data-page=general]').click();
  await options.locator('#enabled-actions input[value=learn]').check(); await options.locator('#enabled-actions input[value=dictionary]').check(); await save();
  await options.screenshot({ animations: 'disabled', path: 'test-results/function-settings.png', fullPage: true });
  await page.waitForTimeout(100); await select(); await card.locator('.trigger').click(); await done();
  assert.equal(await card.locator('[data-action]:visible').count(), 3); assert.equal(await card.locator('[data-action=explain]').isVisible(), false);
  await card.locator('[data-action=learn]').click(); await done();
  assert.match(requests.at(-1).payload.messages[0].content, /选中文字已单独识别为English/); assert.match(requests.at(-1).payload.messages[0].content, /A2/);
  assert.equal(await card.locator('.scroll .language-controls,.scroll select,.language-run,.learning-level,.translation-engine,.source-language,.notes-enabled').count(), 0);
  assert.equal(await card.locator('.head .learning-language').count(), 1);
  const beforeChange = requests.length; await card.locator('.head .learning-language').selectOption('en'); await done();
  assert.equal(requests.length, beforeChange + 1); assert.match(requests.at(-1).payload.messages[0].content, /用户手动指定本次学习输出语言为 English/);
  assert.match(requests.at(-1).payload.messages[0].content, /A2/);
  const saved = await options.evaluate(async () => (await chrome.storage.local.get('plainly')).plainly); assert.equal(saved.translation.level, 'A2'); assert.equal(saved.translation.learningLanguage, 'auto');
  await page.screenshot({ animations: 'disabled', path: 'test-results/same-language-learning.png' });
  results.push('正文无设置区；标题栏切换学习语言立即重新生成，使用设置中的难度且不覆盖默认语言');

  await page.keyboard.press('Escape'); await options.locator('[data-page=languages]').click();
  await options.locator('#language-preferences .translation-engine').selectOption('mymemory'); await save();
  await select(); await card.locator('.trigger').click(); await done();
  assert.equal(await card.locator('.head .target-language').count(), 1);
  assert.equal(requests.at(-1).kind, 'free'); assert.equal(requests.at(-1).query.langpair, 'en|zh-CN'); assert.equal(requests.at(-1).auth, undefined);
  assert.deepEqual(Object.keys(requests.at(-1).query).sort(), ['langpair', 'q']);
  assert.match(await card.locator('.answer').textContent(), /机缘巧合 & 幸运/); assert.equal(await card.locator('.answer img').count(), 0);
  const cached = requests.length; await card.locator('[data-action=translate]').click(); await done(); assert.equal(requests.length, cached);
  await page.keyboard.press('Escape');
  await options.locator('#language-preferences .swap-language').click(); await save();
  await select(); await card.locator('.trigger').click(); await done(); assert.equal(requests.at(-1).query.langpair, 'zh-CN|en');
  await page.screenshot({ animations: 'disabled', path: 'test-results/bilingual-translation.png' });
  results.push('翻译服务及原文语言从设置读取；标题栏仅保留目标语言，免费服务和缓存正常');

  behavior = 'quota'; const quotaStart = requests.length; await card.locator('.head .target-language').selectOption('ja');
  await card.locator('.status.error').waitFor({ state: 'visible' });
  assert.match(await card.locator('.status').textContent(), /额度/); assert.equal(requests.length, quotaStart + 1); assert.equal(requests.at(-1).kind, 'free');
  behavior = 'normal'; await card.locator('[data-action=dictionary]').click(); await done();
  assert.equal(requests.at(-1).kind, 'dictionary'); assert.match(await card.locator('.answer').textContent(), /CC BY-SA/); assert.match(await card.locator('.answer').textContent(), /Example:/);
  assert.equal(await card.locator('.actions').isVisible(), false); assert.equal(await card.locator('.context pre').textContent(), '选中文字：\nserendipity');
  await page.screenshot({ animations: 'disabled', path: 'test-results/dictionary.png' });
  results.push('免费额度错误不自动调用 LLM；英英词典保留音标、释义、例句、来源与许可');

  await page.keyboard.press('Escape'); await options.locator('[data-page=general]').click();
  await options.locator('#enabled-actions input[value=translate]').uncheck(); await options.locator('#enabled-actions input[value=learn]').uncheck();
  await options.locator('[data-page=models]').click(); await options.locator('#api-key').fill(''); await options.locator('#page-models .advanced').evaluate(el => { el.open = true; }); await options.locator('#base-url').fill('https://example.invalid/v1'); await save();
  await page.waitForTimeout(100); await page.locator('#word').evaluate(el => el.textContent = 'resilience');
  behavior = 'slow'; await select(); await card.locator('.trigger').click();
  await page.waitForTimeout(250); await card.locator('.stop').click(); await page.waitForTimeout(150); assert.ok(aborted > 0);
  assert.match(await card.locator('.status').textContent(), /已停止/);
  behavior = 'normal'; await card.locator('.retry').click(); await done(); assert.equal(requests.at(-1).kind, 'dictionary');
  results.push('没有 LLM 密钥仍可查词，慢请求能立即停止并取消连接，重试成功');

  const popup = await context.newPage(); popup.on('pageerror', e => errors.push(e.message));
  await popup.goto(`chrome-extension://${id}/popup.html`); await popup.locator('#text').fill('hello'); await popup.locator('#submit').click();
  await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('词条由'));
  assert.equal(await popup.locator('#reading-actions').isVisible(), false); assert.match(await popup.locator('#answer').textContent(), /fortunate discovery/);
  await options.locator('[data-page=general]').click(); await options.locator('#theme').selectOption('dark'); await save();
  await page.waitForTimeout(100); await select(); await card.locator('.trigger').click(); await done();
  await page.screenshot({ animations: 'disabled', path: 'test-results/dictionary-dark.png' });
  await options.setViewportSize({ width: 390, height: 740 }); assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  results.push('工具栏遵循同一功能选择，深色主题与窄屏设置页保持可用');
  assert.deepEqual(errors, []);
  await writeFile('test-results/language-report.json', JSON.stringify({ passed: results.length, results, errors, requests: requests.length }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, requests: requests.length }, null, 2));
} catch (error) {
  await writeFile('test-results/language-failure.json', JSON.stringify({ results, errors, error: String(error) }, null, 2));
  if (context) for (const [i, page] of context.pages().entries()) await page.screenshot({ animations: 'disabled', path: `test-results/language-failure-${i}.png` }).catch(() => {});
  throw error;
} finally { await context?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
