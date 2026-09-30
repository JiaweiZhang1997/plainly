import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
function fixture(pages, rotation = 0) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach(lines => { const stream = lines.map((text, i) => `BT /F1 16 Tf 60 ${720 - i * 40} Td (${text}) Tj ET`).join('\n'); objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); });
  let body = '%PDF-1.7\n', offsets = [0]; objects.forEach((o, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`; return Buffer.from(body);
}
const pdf = fixture([['Serendipity means a happy discovery.', 'This is the first page.'], ['Cancellation is available within thirty days.', 'Refunds arrive in five business days.']]);
const requests = [], errors = [], results = [];
const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); res.setHeader('Content-Type', 'application/json');
    if (body.questions) { const passages = body.state.passages; const best = passages.find(p => /Cancellation/.test(p.text)) || passages[0]; res.end(JSON.stringify({ answers: { where: { type: 'choice', probabilities: Object.fromEntries(passages.map(p => [p.id, p.id === best.id ? .97 : .01])) }, exists: { type: 'noul', noul: .98 } } })); }
    else res.end(JSON.stringify({ choices: [{ message: { content: '测试回答。' }, finish_reason: 'stop' }] }));
    return;
  }
  res.setHeader('Content-Type', 'application/pdf'); res.end(pdf);
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
let context;
await mkdir('test-results', { recursive: true });
try {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'plainly-pdf-')), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 980 }, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(worker.url()).host;
  const options = await context.newPage(); options.on('pageerror', e => errors.push(e.message)); await options.goto(`chrome-extension://${id}/options.html#prompts`);
  await options.waitForFunction(() => document.querySelector('#function-prompt').options.length === 9);
  async function rpc(type, data = {}) { return options.evaluate(async ({ type, data }) => { const response = await chrome.runtime.sendMessage({ type, ...data }); if (!response.ok) throw new Error(response.error); return response.value; }, { type, data }); }
  const s = await rpc('getSettings'); s.profiles[0].baseUrl = `${origin}/v1`; s.profiles[0].apiKey = ''; s.profiles[0].model = 'mock'; s.jev.baseUrl = `${origin}/v1`; s.jev.apiKey = ''; await rpc('saveSettings', { value: s }); await options.reload();
  const custom = { explanation: 'CUSTOM EXPLAIN {{modePrompt}}', translate: 'CUSTOM TRANSLATE {{targetLanguage}}', learn: 'CUSTOM LEARN {{level}}', jevRank: 'CUSTOM RANK', jevExists: 'CUSTOM EXISTS', jevTrue: 'CUSTOM TRUE', jevFalse: 'CUSTOM FALSE', followExample: 'CUSTOM EXAMPLE', followSimpler: 'CUSTOM SIMPLER' };
  for (const [key, value] of Object.entries(custom)) { await options.locator('#function-prompt').selectOption(key); await options.locator('#function-prompt-text').fill(value); }
  await options.locator('#save').click(); await options.waitForFunction(() => document.querySelector('#save-status').textContent.includes('已保存'));
  await options.reload(); await options.locator('#function-prompt').selectOption('jevRank'); assert.equal(await options.locator('#function-prompt-text').inputValue(), custom.jevRank);
  results.push('9 类提示词可编辑保存并跨刷新保留');
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(`chrome-extension://${id}/pdf.html`);
  await page.locator('#pdf-file').setInputFiles({ name: 'reading.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => document.querySelector('#pdf-status').textContent.includes('选中文字'));
  assert.equal(await page.locator('#page-count').textContent(), '2'); assert.equal(requests.length, 0);
  const firstText = page.locator('#pdf-text span').filter({ hasText: 'Serendipity' }); assert.equal(await firstText.count(), 1);
  await firstText.dblclick({ position: { x: 38, y: 9 } }); const card = page.locator('plainly-reader'); await card.locator('.trigger').waitFor({ state: 'visible' }); await card.locator('.trigger').click();
  async function done() { await page.waitForFunction(() => document.querySelector('plainly-reader')?.shadowRoot.querySelector('.answer').textContent === '测试回答。'); await card.locator('.stop').waitFor({ state: 'hidden' }); }
  await done(); assert.match(requests.at(-1).messages[0].content, /^CUSTOM EXPLAIN/);
  await card.locator('.example').click(); await done(); assert.equal(requests.at(-1).messages.at(-1).content, custom.followExample);
  await card.locator('.simpler').click(); await done(); assert.equal(requests.at(-1).messages.at(-1).content, custom.followSimpler);
  await card.locator('[data-action=translate]').click(); await done(); assert.equal(requests.at(-1).messages[0].content, 'CUSTOM TRANSLATE 简体中文');
  await card.locator('[data-action=learn]').click(); await done(); assert.equal(requests.at(-1).messages[0].content, 'CUSTOM LEARN B1');
  results.push('本地 PDF 仅本机解析；真实文字层可划词，解释/翻译/同语学习/快捷追问使用自定义提示词');
  await page.keyboard.press('Escape'); await page.locator('#pdf-search').click(); const panel = page.locator('plainly-search');
  await panel.locator('#query').fill('How to cancel?'); await panel.locator('#submit').click(); await panel.locator('.result').first().waitFor();
  const query = requests.at(-1); assert.equal(query.questions.where.instructions.task, custom.jevRank); assert.equal(query.questions.exists.instructions.task, custom.jevExists); assert.deepEqual(query.questions.exists.criteria, { true: custom.jevTrue, false: custom.jevFalse });
  assert.ok(query.state.passages.some(p => p.heading === '第 2 页')); assert.ok(query.state.passages.every(p => !('range' in p) && !('page' in p)));
  await panel.locator('.result').first().click(); await page.waitForFunction(() => document.querySelector('#page-number').value === '2' && CSS.highlights.has('plainly-search-current'));
  assert.match(await panel.locator('#coverage').textContent(), /2 \/ 2 页/);
  await page.screenshot({ path: 'test-results/pdf-search.png', fullPage: true });
  results.push('Jev 使用自定义排序/相关性标准，搜索整份 PDF，结果定位到第 2 页并高亮');
  const before = requests.length; const latest = await rpc('getSettings'); latest.prompts.jevRank = 'UPDATED RANK'; await rpc('saveSettings', { value: latest });
  await panel.locator('#submit').click(); await panel.locator('.result').first().waitFor(); assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).questions.where.instructions.task, 'UPDATED RANK');
  results.push('修改 Jev 提示词后同一查询不会复用旧缓存');
  await page.keyboard.press('Escape'); await page.locator('#zoom').selectOption('0.75'); await page.waitForFunction(() => document.querySelector('#pdf-status').textContent.includes('选中文字'));
  await page.locator('#prev-page').click(); await page.waitForFunction(() => document.querySelector('#page-number').value === '1');
  await page.locator('#pdf-file').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: fixture([[]]) }); await page.waitForFunction(() => document.querySelector('#pdf-status').textContent.includes('没有可选文字'));
  await page.locator('#pdf-search').click(); await panel.locator('#submit').click(); await page.waitForFunction(() => document.querySelector('plainly-search').shadowRoot.querySelector('#status').textContent.includes('没有可搜索的文字层'));
  results.push('翻页/缩放可用；换文档清除旧结果，扫描件给出无文字层提示');
  await page.keyboard.press('Escape'); await page.locator('#pdf-file').setInputFiles({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a pdf') }); await page.waitForFunction(() => document.querySelector('#pdf-status').textContent.includes('不是有效的 PDF'));
  const newPagePromise = context.waitForEvent('page'); await rpc('openPdf', { url: `${origin}/book.pdf?signed=yes` }); const remote = await newPagePromise;
  await remote.waitForFunction(() => document.querySelector('#page-count')?.textContent === '2'); assert.equal(new URL(remote.url()).hash, '');
  await remote.waitForFunction(() => document.querySelector('#pdf-status').textContent.includes('选中文字'));
  results.push('无效 PDF 错误可恢复；在线 PDF 通过插件入口打开，签名链接不会留在阅读器地址栏');
  await remote.locator('#pdf-file').setInputFiles({ name: 'rotated.pdf', mimeType: 'application/pdf', buffer: fixture([['Serendipity in a rotated document.']], 90) });
  await remote.waitForFunction(() => document.querySelector('#pdf-status').textContent.includes('选中文字'));
  const rotated = await remote.locator('#pdf-text span').first().boundingBox(), canvas = await remote.locator('#pdf-canvas').boundingBox();
  assert.ok(rotated.height > rotated.width); assert.ok(rotated.x >= canvas.x && rotated.x + rotated.width <= canvas.x + canvas.width);
  assert.ok(rotated.y >= canvas.y && rotated.y + rotated.height <= canvas.y + canvas.height);
  results.push('旋转 PDF 的文字层按页面方向对齐，未超出画布');
  await options.locator('#function-prompt').selectOption('jevRank'); await options.locator('#restore-function-prompt').click(); assert.notEqual(await options.locator('#function-prompt-text').inputValue(), custom.jevRank);
  assert.deepEqual(errors, []); results.push('提示词支持恢复默认，浏览器无未捕获错误');
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
  await writeFile('test-results/pdf-report.json', JSON.stringify({ passed: results.length, results }, null, 2));
} finally { await context?.close(); await new Promise(r => server.close(r)); }
