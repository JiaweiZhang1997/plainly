import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
function fixture() {
  const lines = ['Serendipity in the first page.', 'Cancellation is available within thirty days.'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  lines.forEach(text => { const stream = `BT /F1 16 Tf 60 720 Td (${text}) Tj ET`; objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); });
  let body = '%PDF-1.7\n'; const offsets = [0]; objects.forEach((o, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`; return Buffer.from(body);
}
const pdf = fixture(), requests = [], results = [], errors = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push({ method: req.method, url: req.url, cookie: req.headers.cookie || '' });
  if (url.pathname === '/v1/chat/completions') { for await (const _ of req) {} res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '这是一段测试解释。' }, finish_reason: 'stop' }] })); return; }
  if (url.pathname === '/' || url.pathname === '/fake.pdf') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><a id="pdf" href="/document.pdf#page=2">Read PDF</a><a id="download" href="/attachment">Download PDF</a><p>ordinary web page</p>'); return; }
  if (url.pathname === '/login-document' && !req.headers.cookie?.includes('test-session=yes')) { res.writeHead(401); res.end('login required'); return; }
  if (url.pathname === '/attachment') res.setHeader('content-disposition', 'attachment; filename="download.pdf"');
  res.setHeader('content-type', url.pathname === '/binary.pdf' ? 'application/octet-stream' : 'application/pdf'); res.end(pdf);
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir('test-results', { recursive: true }); let context;
try {
  const dir = await mkdtemp(join(tmpdir(), 'plainly-auto-pdf-'));
  context = await chromium.launchPersistentContext(join(dir, 'profile'), { channel: 'chromium', headless: true, acceptDownloads: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(worker.url()).host;
  let options = await context.newPage(); options.on('pageerror', e => errors.push(e.message)); await options.goto(`chrome-extension://${id}/options.html`);
  async function rpc(type, data = {}) { return options.evaluate(async ({ type, data }) => { const r = await chrome.runtime.sendMessage({ type, ...data }); if (!r.ok) throw new Error(r.error); return r.value; }, { type, data }); }
  await rpc('pdfIntegrationStatus');
  const s = await rpc('getSettings'); s.pdfAutoOpen = true; s.profiles[0].baseUrl = `${origin}/v1`; s.profiles[0].apiKey = ''; s.profiles[0].model = 'mock'; await rpc('saveSettings', { value: s });
  let page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  async function ready(target = page) { await target.waitForFunction(() => document.querySelector('#pdf-status')?.textContent.includes('选中文字'), { timeout: 15000 }); }
  async function go(url, target = page) { await target.goto(url).catch(e => { if (!/ERR_ABORTED/.test(e.message)) throw e; }); await ready(target); }
  await page.goto(origin); const count = context.pages().length; await page.locator('#pdf').click(); await ready();
  assert.equal(context.pages().length, count); assert.equal(await page.locator('#page-count').textContent(), '2');
  assert.equal(await page.locator('#page-number').inputValue(), '2');
  await page.locator('#pdf-text span').first().dblclick({ position: { x: 30, y: 10 } }); const card = page.locator('plainly-reader'); await card.locator('.trigger').click();
  await page.waitForFunction(() => document.querySelector('plainly-reader')?.shadowRoot.querySelector('.answer').textContent.includes('测试解释'));
  await page.keyboard.press('Escape'); await page.reload(); await ready(); assert.equal(await page.locator('#page-number').inputValue(), '2');
  results.push('普通网页直接点击 PDF 后同标签自动阅读、可划词解释，#page=2 与刷新后的页码保留');
  await go(`${origin}/download?signature=a%2Fb%3D&value=1+2`); assert.ok(requests.some(r => r.url === '/download?signature=a%2Fb%3D&value=1+2'));
  assert.equal(new URL(page.url()).search, ''); await page.reload(); await ready();
  await go(`${origin}/binary.pdf#page=2`); assert.equal(await page.locator('#page-number').inputValue(), '2');
  results.push('按真实 MIME 识别不带 .pdf 后缀的地址，保留签名参数，兼容 octet-stream PDF，无循环跳转');
  await context.addCookies([{ name: 'test-session', value: 'yes', url: origin }]); await go(`${origin}/login-document`);
  assert.ok(requests.filter(r => r.url === '/login-document').every(r => r.cookie.includes('test-session=yes')));
  results.push('原网页登录 Cookie 能用于正常读取 PDF，不需要手动下载');
  await page.locator('#native-pdf').click(); await page.waitForURL(`${origin}/login-document#page=1`); await page.waitForTimeout(400);
  assert.equal(new URL(page.url()).pathname, '/login-document');
  await page.goto(origin); await options.waitForFunction(async () => !(await chrome.declarativeNetRequest.getSessionRules()).length); await go(`${origin}/login-document`); await page.goto(origin); await page.locator('#pdf').click(); await ready();
  results.push('可切回原生阅读器且不重复接管；离开该文档后恢复正常自动接管');
  s.pdfAutoOpen = false; await rpc('saveSettings', { value: s }); const native = await context.newPage(); await native.goto(`${origin}/document.pdf`).catch(e => { if (!/ERR_ABORTED/.test(e.message)) throw e; });
  await native.waitForTimeout(500); assert.equal(new URL(native.url()).pathname, '/document.pdf'); assert.equal(await native.locator('#pdf-text').count(), 0);
  s.pdfAutoOpen = true; await rpc('saveSettings', { value: s }); await native.reload().catch(e => { if (!/ERR_ABORTED/.test(e.message)) throw e; }); await ready(native);
  results.push('自动接管可关闭；重新开启后，已有原生 PDF 刷新即可直接使用');
  await page.goto(`${origin}/fake.pdf`); assert.equal(await page.locator('p').textContent(), 'ordinary web page');
  const downloadEvent = page.waitForEvent('download'); await page.locator('#download').click(); const download = await downloadEvent; assert.equal(download.suggestedFilename(), 'download.pdf');
  assert.ok(!page.url().startsWith('chrome-extension:'));
  results.push('普通 HTML 即使 URL 带 .pdf 也不会接管，附件下载保持正常');
  await page.goto(origin);
  const fetched = await page.evaluate(async () => { const r = await fetch('/document.pdf'); return { type: r.headers.get('content-type'), body: (await r.text()).slice(0, 5) }; });
  assert.deepEqual(fetched, { type: 'application/pdf', body: '%PDF-' });
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/document.pdf'; document.body.append(frame); });
  await page.waitForFunction(() => document.querySelector('iframe'));
  await page.waitForTimeout(500); assert.ok(page.frames().some(f => f.url().endsWith('/document.pdf'))); assert.ok(!page.frames().some(f => f.url().includes('/pdf.html')));
  await page.evaluate(() => { const form = document.createElement('form'); form.method = 'post'; form.action = '/document.pdf'; document.body.append(form); form.submit(); });
  await page.waitForURL(`${origin}/document.pdf`); await page.waitForTimeout(300); assert.ok(!page.url().startsWith('chrome-extension:'));
  results.push('POST、网页内嵌框架和后台 API 请求不被自动接管');
  const localPath = join(dir, 'local document.pdf'); await writeFile(localPath, pdf);
  const access = await rpc('pdfIntegrationStatus');
  if (access.fileAccess) { await go(pathToFileURL(localPath).href + '#page=2'); assert.equal(await page.locator('#page-number').inputValue(), '2'); assert.equal(await page.locator('#page-count').textContent(), '2'); await page.reload(); await ready(); results.push('已授权的本地 PDF 可直接打开和刷新，无需再次选择文件'); }
  else {
    const permissions = await context.newPage(); await permissions.goto(`chrome://extensions/?id=${id}`);
    const toggle = permissions.locator('extensions-detail-view #allow-on-file-urls cr-toggle'); await toggle.click(); await permissions.close();
    await go(pathToFileURL(localPath).href); assert.equal(await page.locator('#page-count').textContent(), '2'); results.push('首次开启浏览器文件权限后，本地 PDF 直接打开即可阅读');
  }
  const permissions = await context.newPage(); await permissions.goto(`chrome://extensions/?id=${id}`);
  await permissions.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const fileToggle = permissions.locator('extensions-detail-view #allow-on-file-urls cr-toggle');
  await fileToggle.click(); await permissions.waitForTimeout(1000); options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`); assert.equal((await rpc('pdfIntegrationStatus')).fileAccess, false);
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/pdf.html?source=${pathToFileURL(localPath).href}`);
  await page.locator('#enable-file-access').waitFor({ state: 'visible' }); assert.match(await page.locator('#pdf-status').textContent(), /允许访问文件网址/);
  await fileToggle.click(); await permissions.waitForTimeout(1000); options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`); assert.equal((await rpc('pdfIntegrationStatus')).fileAccess, true);
  page = await context.newPage(); await go(pathToFileURL(localPath).href);
  await permissions.close(); results.push('缺少本地权限时给出明确入口，开启后直接打开本地文件即可自动阅读');
  assert.deepEqual(errors, []); await page.screenshot({ path: 'test-results/pdf-auto-open.png' });
  console.log(JSON.stringify({ passed: results.length, results }, null, 2)); await writeFile('test-results/pdf-auto-report.json', JSON.stringify({ passed: results.length, results }, null, 2));
} finally { await context?.close(); await new Promise(r => server.close(r)); }
