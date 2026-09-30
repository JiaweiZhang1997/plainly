import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, normalizeSettings, makeMessages } from '../src/core.ts';
import { normalizePrompts, DEFAULT_PROMPTS, renderPrompt } from '../src/prompts.ts';
import { buildJevBody } from '../src/search-core.ts';
import { pageText, pdfSlices, pdfSource } from '../src/pdf-text.ts';

test('old settings gain defaults; user prompts survive normalization and all request builders', () => {
  const legacy = defaults(); delete (legacy as any).prompts;
  assert.deepEqual(normalizeSettings(legacy).prompts, DEFAULT_PROMPTS);
  const s = defaults(); s.prompts.explanation = '自定义 {{language}} {{modePrompt}}'; s.prompts.translate = '译成 {{targetLanguage}}：{{translationNotes}}'; s.prompts.learn = '难度 {{level}}';
  s.prompts.jevRank = '自定义排序'; s.prompts.jevExists = '自定义存在'; s.prompts.jevTrue = '相关标准'; s.prompts.jevFalse = '无关标准';
  assert.equal(normalizeSettings(s).prompts.jevRank, s.prompts.jevRank);
  const input = { text: 'example', context: '', modeId: 'smart' };
  assert.match(makeMessages(s, input).system, /自定义 简体中文/);
  assert.ok(makeMessages(s, input).system.includes(s.modes[0].prompt));
  assert.match(makeMessages(s, { ...input, action: 'translate' }).system, /^译成 简体中文/);
  assert.match(makeMessages(s, { ...input, action: 'learn' }).system, /^难度 B1\n/);
  assert.equal(s.prompts.learn, '难度 {{level}}');
  const body = buildJevBody('jev', 'query', [{ id: 'S0', text: 'data', heading: '', context: '' }], s.prompts);
  assert.equal(body.questions.where.instructions.task, '自定义排序'); assert.equal(body.questions.exists.instructions.task, '自定义存在');
  assert.deepEqual(body.questions.exists.criteria, { true: '相关标准', false: '无关标准' });
  assert.equal(body.questions.where.type, 'choice'); assert.deepEqual(body.questions.where.criteria, { S0: null });
});
test('prompt limits reject silent truncation; variables are expanded once', () => {
  assert.throws(() => normalizePrompts({ translate: '' }), /不能为空/);
  assert.throws(() => normalizePrompts({ followExample: 'x'.repeat(1001) }), /1000/);
  assert.throws(() => normalizePrompts({ jevRank: 'x'.repeat(16001) }), /16000/);
  assert.equal(renderPrompt('{{modePrompt}} {{language}} {{unknown}}', { modePrompt: '{{language}}', language: 'English' }), '{{language}} English {{unknown}}');
});
test('PDF physical line offsets survive paragraph and sentence segmentation', () => {
  const item = (str: string, y: number, hasEOL = false) => ({ str, height: 12, transform: [12, 0, 0, 12, 20, y], hasEOL });
  const { text, runs } = pageText([item('First sentence. ', 100), item('Same line.', 100, true), item('Next physical line.', 85, true), item('New paragraph.', 50)]);
  assert.equal(text, 'First sentence. Same line.\nNext physical line.\n\nNew paragraph.');
  for (const [i, word] of ['First sentence. ', 'Same line.', 'Next physical line.', 'New paragraph.'].entries()) assert.equal(text.slice(runs[i].start, runs[i].end), word);
  const paragraphs = pdfSlices(text, 'paragraph'); assert.equal(paragraphs.length, 2); assert.equal(text.slice(paragraphs[1].start, paragraphs[1].end), 'New paragraph.');
  assert.equal(pdfSlices(text, 'sentence').length, 4); assert.deepEqual(pdfSlices('', 'auto'), []);
});
test('PDF links preserve signed queries but reject privileged schemes and embedded passwords', () => {
  assert.equal(pdfSource('https://example.org/book.pdf?signature=abc#page=2'), 'https://example.org/book.pdf?signature=abc');
  for (const link of ['file:///tmp/a.pdf', 'javascript:alert(1)', 'chrome://settings', 'https://user:password@example.org/a.pdf']) assert.throws(() => pdfSource(link));
});
