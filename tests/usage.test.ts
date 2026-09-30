import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, mergeUsage, addUsage, emptyUsage } from '../src/usage.ts';
import { streamModel, buildRequest } from '../src/providers.ts';
import { searchJev } from '../src/jev.ts';
import { defaults } from '../src/core.ts';
const profile = { ...defaults().profiles[0], baseUrl: 'http://localhost:1234/v1', model: 'mock' };
const sse = events => new Response(events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
test('provider usage includes cache and thinking exactly once, missing fields remain unknown', () => {
  assert.deepEqual(parseUsage('openai', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } }), { input: 10, output: 5, total: 15, cacheRead: 4, cacheWrite: undefined, reasoning: 2 });
  assert.deepEqual(parseUsage('anthropic', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 6 }), { input: 20, output: 5, total: 25, cacheRead: 4, cacheWrite: 6, reasoning: undefined });
  const gemini = parseUsage('gemini', { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 8, totalTokenCount: 23, cachedContentTokenCount: 4 });
  assert.equal(gemini?.output, 13); assert.equal(gemini?.total, 23);
  assert.equal(parseUsage('jev', { input_tokens: 8, output_tokens: 2 })?.total, 10);
  assert.equal(parseUsage('openai', { total_tokens: 0 })?.total, 0);
  assert.equal(parseUsage('openai', { prompt_tokens: -2, completion_tokens: '4' }), undefined);
  assert.equal(parseUsage('gemini', { totalTokenCount: 10 })?.input, undefined);
});
test('cumulative updates replace values; aggregate unknown and partial reports separately', () => {
  const usage = mergeUsage({ input_tokens: 100, output_tokens: 1 }, { output_tokens: 15 }); assert.deepEqual(usage, { input_tokens: 100, output_tokens: 15 });
  const store = emptyUsage(), identity = { key: 'a', name: 'test', model: 'model', protocol: 'anthropic' as const };
  addUsage(store, identity, { usage: parseUsage('anthropic', usage), complete: true });
  addUsage(store, identity, { usage: parseUsage('anthropic', { input_tokens: 5 }), complete: false });
  addUsage(store, identity, { complete: true });
  assert.equal(store.rows[0].tokens.total, 115); assert.equal(store.rows[0].tokens.input, 105); assert.equal(store.rows[0].tokens.output, 15);
  assert.equal(store.rows[0].completeReports, 1); assert.equal(store.rows[0].partial, 1); assert.equal(store.rows[0].missing, 1); assert.equal(store.rows[0].failed, 1);
});
test('OpenAI reads usage after finish_reason; JSON and Gemini trailing metadata are counted once', async () => {
  const original = fetch; const reports: any[] = [];
  try {
    const observe = report => { reports.push(report); };
    globalThis.fetch = async () => sse([{ choices: [{ delta: { content: 'answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }, '[DONE]']);
    await streamModel(profile, '', [], new AbortController().signal, () => {}, 100, observe);
    assert.equal(reports.length, 1); assert.equal(reports[0].usage.total, 23);
    globalThis.fetch = async () => sse([{ candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] }, { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, thoughtsTokenCount: 4, totalTokenCount: 27 } }]);
    await streamModel({ ...profile, protocol: 'gemini' }, '', [], new AbortController().signal, () => {}, 100, observe);
    assert.equal(reports[1].usage.output, 7); assert.equal(reports[1].usage.total, 27);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
    await streamModel(profile, '', [], new AbortController().signal, () => {}, 100, observe); assert.equal(reports[2].usage.total, 3);
    assert.equal(JSON.parse(buildRequest(profile, '', []).init.body).stream_options.include_usage, true);
    assert.equal(JSON.parse(buildRequest({ ...profile, streamUsage: false }, '', []).init.body).stream_options, undefined);
  } finally { globalThis.fetch = original; }
});
test('Claude merges start and cumulative delta usage; interrupted streams retain partial official counts', async () => {
  const original = fetch, reports: any[] = [];
  try {
    const messages = [{ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 10 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }, { type: 'message_delta', usage: { output_tokens: 7 } }];
    globalThis.fetch = async () => sse([...messages, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }, { type: 'message_stop' }]);
    await streamModel({ ...profile, protocol: 'anthropic' }, '', [], new AbortController().signal, () => {}, 100, report => { reports.push(report); });
    assert.equal(reports[0].usage.total, 69); assert.equal(reports[0].usage.output, 9); assert.equal(reports[0].complete, true);
    globalThis.fetch = async () => sse(messages);
    await assert.rejects(streamModel({ ...profile, protocol: 'anthropic' }, '', [], new AbortController().signal, () => {}, 100, report => { reports.push(report); }), /中断/);
    assert.equal(reports[1].usage.total, 67); assert.equal(reports[1].complete, false);
    globalThis.fetch = async () => { throw new TypeError('failed'); };
    await assert.rejects(streamModel(profile, '', [], new AbortController().signal, () => {}, 100, report => { reports.push(report); }));
    assert.equal(reports[2].usage, undefined); assert.equal(reports[2].complete, false);
  } finally { globalThis.fetch = original; }
});
test('Jev reports each batch and rerank independently, including usage when answer validation fails', async () => {
  const original = fetch, reports: any[] = []; let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => { calls++; const body = JSON.parse(String(init?.body)), segments = body.state.passages; return Response.json({ usage: { input_tokens: 100, output_tokens: 10 }, answers: { where: { type: 'choice', probabilities: Object.fromEntries(segments.map(s => [s.id, 1 / segments.length])) }, exists: { type: 'noul', noul: .9 } } }); };
    const segments = Array.from({ length: 121 }, (_, i) => ({ id: `S${i}`, text: `Passage ${i}`, heading: '', context: '' }));
    await searchJev({ ...defaults().jev, baseUrl: profile.baseUrl }, { query: 'test', segments }, new AbortController().signal, () => {}, defaults().prompts, report => { reports.push(report); });
    assert.equal(calls, 3); assert.equal(reports.length, 3); assert.equal(reports.reduce((n, r) => n + r.usage.total, 0), 330);
    globalThis.fetch = async () => Response.json({ usage: { input_tokens: 4, output_tokens: 1 }, answers: {} });
    await assert.rejects(searchJev({ ...defaults().jev, baseUrl: profile.baseUrl }, { query: 'test', segments: segments.slice(0, 1) }, new AbortController().signal, () => {}, defaults().prompts, report => { reports.push(report); }));
    assert.equal(reports.at(-1).usage.total, 5); assert.equal(reports.at(-1).complete, false);
  } finally { globalThis.fetch = original; }
});
