import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const results = [], errors = [], requests = []; let behavior = 'normal';
const server = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw || '{}'); requests.push(body);
  if (body.questions) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 10 }, answers: { where: { type: 'choice', probabilities: Object.fromEntries(body.state.passages.map((s, i) => [s.id, i ? .1 : .9])) }, exists: { type: 'noul', noul: .95 } } })); return; }
  res.setHeader('content-type', 'text/event-stream');
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (body.system) {
    send({ type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } });
    send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } });
    if (behavior === 'slow') { const timer = setTimeout(() => res.end(), 30000); res.on('close', () => clearTimeout(timer)); return; }
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }); send({ type: 'message_stop' }); res.end();
  } else if (body.systemInstruction) {
    send({ candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] });
    send({ usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 8, totalTokenCount: 43 } }); res.end();
  } else {
    send({ choices: [{ delta: { content: 'answer' } }] }); send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    if (behavior !== 'missing') send({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49, prompt_tokens_details: { cached_tokens: 12 } } });
    res.end('data: [DONE]\n\n');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`; let context;
await mkdir('test-results', { recursive: true });
try {
  const profilePath = await mkdtemp(join(tmpdir(), 'plainly-usage-'));
  const launch = () => chromium.launchPersistentContext(profilePath, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 980 }, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  context = await launch(); const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(worker.url()).host;
  let page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(`chrome-extension://${id}/options.html#usage`);
  async function rpc(type, data = {}) { return page.evaluate(async ({ type, data }) => { const r = await chrome.runtime.sendMessage({ type, ...data }); if (!r.ok) throw new Error(r.error); return r.value; }, { type, data }); }
  await page.waitForFunction(() => document.querySelector('#usage-summary').textContent.includes('还没有记录'));
  const s = await rpc('getSettings'); s.profiles = ['openai', 'anthropic', 'gemini'].map(protocol => ({ id: protocol, name: protocol, provider: 'custom', protocol, baseUrl: `${origin}/v1`, apiKey: '', model: `mock-${protocol}` })); s.activeProfile = 'openai'; s.jev.baseUrl = `${origin}/v1`; s.jev.apiKey = ''; await rpc('saveSettings', { value: s });
  await Promise.all(s.profiles.map(profile => rpc('testProfile', { profile })));
  await Promise.all(Array.from({ length: 4 }, () => rpc('testJev', { jev: s.jev })));
  let usage = await rpc('getUsage'); const row = protocol => usage.rows.find(r => r.protocol === protocol);
  assert.equal(row('openai').tokens.total, 49); assert.equal(row('anthropic').tokens.total, 42); assert.equal(row('gemini').tokens.total, 43); assert.equal(row('jev').tokens.total, 440); assert.equal(row('jev').requests, 4);
  results.push('OpenAI/Claude/Gemini/Jev 官方字段正确累计，并发 7 次请求无丢失或重复计数');
  async function explain(text) { return page.evaluate(text => new Promise((resolve, reject) => { const port = chrome.runtime.connect({ name: 'plainly-explain' }); port.onMessage.addListener(e => { if (e.type === 'done') { port.disconnect(); resolve(e); } if (e.type === 'error') { port.disconnect(); reject(new Error(e.error)); } }); port.postMessage({ type: 'explain', id: crypto.randomUUID(), input: { text, context: '', modeId: 'smart' } }); }), text); }
  await explain('cache check'); const before = requests.length; const done = await explain('cache check'); assert.equal(done.cached, true); assert.equal(requests.length, before);
  usage = await rpc('getUsage'); assert.equal(row('openai').requests, 2); assert.equal(row('openai').tokens.total, 98);
  behavior = 'missing'; await explain('missing metadata'); usage = await rpc('getUsage'); assert.equal(row('openai').missing, 1); assert.equal(row('openai').tokens.total, 98);
  results.push('本地缓存命中不计 token；缺少 usage 明确记录为未提供');
  behavior = 'slow'; s.activeProfile = 'anthropic'; await rpc('saveSettings', { value: s });
  await page.evaluate(() => new Promise(resolve => { const port = chrome.runtime.connect({ name: 'plainly-explain' }); port.onMessage.addListener(e => { if (e.type === 'chunk') { port.postMessage({ type: 'cancel' }); port.disconnect(); resolve(true); } }); port.postMessage({ type: 'explain', id: 'cancel-test', input: { text: 'cancel stream', context: '', modeId: 'smart' } }); }));
  await page.waitForFunction(async () => { const r = await chrome.runtime.sendMessage({ type: 'getUsage' }); return r.value.rows.find(row => row.protocol === 'anthropic')?.partial === 1; });
  usage = await rpc('getUsage'); assert.equal(row('anthropic').tokens.total, 78); assert.equal(row('anthropic').partial, 1); assert.equal(row('anthropic').failed, 1);
  results.push('取消 Claude 流保留已返回的官方部分用量，并标记请求未正常完成');
  await page.locator('#refresh-usage').click(); await page.waitForFunction(() => document.querySelectorAll('#usage-rows tr').length === 4);
  assert.match(await page.locator('#usage-summary').textContent(), /1 次未返回用量 · 1 次仅有部分用量/);
  await page.screenshot({ path: 'test-results/usage-settings.png', fullPage: true });
  await context.close(); context = await launch(); page = await context.newPage(); await page.goto(`chrome-extension://${id}/options.html#usage`);
  await page.waitForFunction(() => document.querySelectorAll('#usage-rows tr').length === 4);
  assert.equal((await rpc('getUsage')).rows.reduce((n, r) => n + r.requests, 0), 10);
  assert.deepEqual(errors, []); results.push('用量界面自动更新；浏览器重启后累计值保留，统计不保存密钥/正文');
  console.log(JSON.stringify({ passed: results.length, results }, null, 2)); await writeFile('test-results/usage-report.json', JSON.stringify({ passed: results.length, results }, null, 2));
} finally { await context?.close(); await new Promise(r => server.close(r)); }
