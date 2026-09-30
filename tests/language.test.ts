import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, normalizeSettings, publicSettings, makeMessages, sanitizeInput, placeTrigger } from '../src/core.ts';
import { languageDefaults, normalizeLanguageSettings } from '../src/language.ts';
import { translateFree, lookupDictionary, decodeEntities } from '../src/free-language.ts';

test('legacy settings migrate sizes and actions without losing credentials; actions cannot be empty', () => {
  const legacy: any = defaults(); delete legacy.triggerSize; delete legacy.enabledActions; delete legacy.defaultAction; delete legacy.translation;
  legacy.profiles[0].apiKey = 'secret'; const restored = normalizeSettings(legacy);
  assert.equal(restored.triggerSize, 24); assert.equal(restored.enabledActions.length, 4); assert.equal(restored.profiles[0].apiKey, 'secret');
  const solo = normalizeSettings({ ...restored, enabledActions: ['learn'], defaultAction: 'translate', triggerSize: 999 });
  assert.equal(solo.triggerSize, 56); assert.equal(solo.defaultAction, 'learn');
  assert.throws(() => normalizeSettings({ ...restored, enabledActions: [] }), /至少保留/);
  assert.ok(!JSON.stringify(publicSettings(restored)).includes('secret'));
});
test('all trigger sizes stay 2px from their selected corner with edge avoidance', () => {
  for (const size of [20, 34, 56]) for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
    const r = { left: 200, right: 300, top: 200, bottom: 220 }, p = placeTrigger(r, corner, size, size, 1000, 800);
    assert.equal(p.left, corner.endsWith('left') ? r.left - size - 2 : r.right + 2);
    assert.equal(p.top, corner.startsWith('top') ? r.top - size - 2 : r.bottom + 2);
    const edge = placeTrigger({ left: 0, right: 20, top: 0, bottom: 20 }, corner, size, size, 390, 740);
    assert.ok(edge.left >= 6 && edge.top >= 6 && edge.left + size <= 384);
  }
});
test('language learning remains in source language and translation uses explicit direction, not explanation prompts', () => {
  const s = defaults(); s.modes[0].prompt = 'CUSTOM_EXPLANATION_ONLY';
  const input = sanitizeInput({ text: 'Nevertheless, the outcome remained uncertain.', context: 'context-marker', modeId: 'smart', action: 'learn', translation: { ...languageDefaults(), level: 'A2' } });
  const learning = makeMessages(s, input); assert.match(learning.system, /原文的同一种语言/); assert.match(learning.system, /A2/); assert.ok(!learning.system.includes('CUSTOM_EXPLANATION_ONLY'));
  assert.ok(learning.turns[0].content.includes('context-marker')); s.context = false;
  const translating = makeMessages(s, { ...input, action: 'translate', translation: { ...languageDefaults(), source: 'zh-CN', target: 'en', notes: true } });
  assert.match(translating.system, /从简体中文翻译为English/); assert.match(translating.system, /学习/); assert.ok(!translating.turns[0].content.includes('context-marker'));
  assert.equal(normalizeLanguageSettings({ source: 'made-up', engine: 'invalid' as any }).engine, 'llm');
});
test('MyMemory byte limits, same-language and explicit source checks run before network access', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('unexpected network'); }) as typeof fetch;
  const signal = new AbortController().signal;
  try {
    await assert.rejects(translateFree('test', languageDefaults(), signal), /原文语言/);
    await assert.rejects(translateFree('test', { ...languageDefaults(), source: 'en', target: 'en' }, signal), /同语学习/);
    await assert.rejects(translateFree('你'.repeat(167), { ...languageDefaults(), source: 'zh-CN', target: 'en' }, signal), /500 字节/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('free adapters send only selected text without keys; errors never become translations', async () => {
  const original = globalThis.fetch; const signal = new AbortController().signal;
  try {
    globalThis.fetch = (async (url, init) => {
      const u = new URL(String(url)); assert.equal(u.origin, 'https://api.mymemory.translated.net'); assert.equal(u.searchParams.get('q'), 'Hello'); assert.equal(u.searchParams.get('langpair'), 'en|zh-CN');
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.headers, undefined);
      return Response.json({ responseStatus: 200, responseData: { translatedText: '你好 &amp; 再见' } });
    }) as typeof fetch;
    assert.equal(await translateFree('Hello', { ...languageDefaults(), source: 'en' }, signal), '你好 & 再见');
    globalThis.fetch = (async () => Response.json({ responseStatus: 403, responseData: { translatedText: 'QUOTA ERROR' } })) as typeof fetch;
    await assert.rejects(translateFree('Hello', { ...languageDefaults(), source: 'en' }, signal), /未能返回/);
    globalThis.fetch = (async () => Response.json({ responseStatus: 200, quotaFinished: true, responseData: { translatedText: 'quota' } })) as typeof fetch;
    await assert.rejects(translateFree('Hello', { ...languageDefaults(), source: 'en' }, signal), /额度/);
  } finally { globalThis.fetch = original; }
});
test('dictionary validates a single English word and retains definitions, examples and licensing', async () => {
  const original = globalThis.fetch; let calls = 0; const signal = new AbortController().signal;
  try {
    globalThis.fetch = (async url => {
      calls++; assert.equal(String(url), 'https://api.dictionaryapi.dev/api/v2/entries/en/hello');
      return Response.json([{ word: 'hello', phonetic: '/həˈləʊ/', meanings: [{ partOfSpeech: 'interjection', definitions: [{ definition: 'A greeting.', example: 'Hello, friend!' }] }], license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' }, sourceUrls: ['javascript:alert(1)', 'https://en.wiktionary.org/wiki/hello'] }]);
    }) as typeof fetch;
    await assert.rejects(lookupDictionary('two words', signal), /单个英文单词/); await assert.rejects(lookupDictionary('你好', signal), /单个英文单词/); assert.equal(calls, 0);
    const answer = await lookupDictionary('Hello', signal); assert.match(answer, /A greeting/); assert.match(answer, /Hello, friend/); assert.match(answer, /CC BY-SA/); assert.ok(!answer.includes('javascript:'));
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    await assert.rejects(lookupDictionary('unknown', signal), /暂未收录/);
  } finally { globalThis.fetch = original; }
});
test('entity decoding stays plain text, including malicious markup and malformed Unicode', () => {
  assert.equal(decodeEntities('&lt;script&gt;alert(1)&lt;/script&gt; &#x1F600;'), '<script>alert(1)</script> 😀');
  assert.equal(decodeEntities('&#999999999; &#xD800;'), '&#999999999; &#xD800;');
});

test('learning language migrates to auto and is independent of translation and interface settings', () => {
  const legacy: any = defaults(); delete legacy.translation.learningLanguage; delete legacy.uiLanguage;
  legacy.translation.source = 'en'; legacy.translation.target = 'en'; legacy.language = 'English'; legacy.profiles[0].apiKey = 'test-key';
  const s = normalizeSettings(legacy); assert.equal(s.translation.learningLanguage, 'auto'); assert.equal(s.uiLanguage, 'zh-CN'); assert.equal(s.profiles[0].apiKey, 'test-key');
  s.prompts.learn = 'CUSTOM: use English. Level {{level}}, language {{learningLanguage}}';
  for (const text of ['山重水复疑无路，柳暗花明又一村。', '桜が咲いています。', 'A small but meaningful discovery.']) {
    s.uiLanguage = 'zh-CN';
    const before = makeMessages(s, { text, context: '', modeId: 'smart', action: 'learn' });
    assert.match(before.system, /中文输入就用中文，日文输入就用日文，英文输入才用英文/);
    assert.match(before.system, /优先于上述提示词中冲突的语言要求/);
    assert.match(before.system, /^CUSTOM:/);
    s.uiLanguage = 'en'; const after = makeMessages(s, { text, context: '', modeId: 'smart', action: 'learn' });
    assert.match(after.system, /Chinese input requires Chinese, Japanese input requires Japanese, and English input requires English/);
    assert.match(after.system, /overrides conflicting language instructions/);
    assert.equal(JSON.parse(after.turns[0].content).selectedText, text);
  }
  s.uiLanguage = 'zh-CN';
  for (const [code, label] of [['en', 'English'], ['ja', '日本語'], ['zh-CN', '简体中文']]) {
    s.translation.learningLanguage = code;
    const prompt = makeMessages(s, { text: '示例', context: '', modeId: 'smart', action: 'learn' }).system;
    assert.ok(prompt.includes(`输出语言硬性要求：仅使用${label}。`));
    assert.ok(!makeMessages(s, { text: '示例', context: '', modeId: 'smart', action: 'translate' }).system.includes('本次同语学习'));
  }
  assert.equal(s.prompts.learn, 'CUSTOM: use English. Level {{level}}, language {{learningLanguage}}');
  assert.equal(normalizeLanguageSettings({ learningLanguage: 'invalid' }).learningLanguage, 'auto');
});

test('system output choice is persisted explicitly and resolved only for requests', () => {
  const s = defaults(); assert.equal(s.language, 'system'); assert.equal(s.translation.target, 'system'); assert.equal(s.translation.learningLanguage, 'auto');
  for (const [ui, label] of [['zh-CN', '简体中文'], ['en', 'English']] as const) {
    s.uiLanguage = ui;
    const normalized = normalizeSettings(s); assert.equal(normalized.language, 'system'); assert.equal(normalized.translation.target, 'system');
    for (const mode of s.modes) {
      const system = makeMessages(s, { text: 'RAG', context: '', modeId: mode.id }).system;
      assert.ok(system.includes(ui === 'en' ? `Respond in ${label}.` : `默认用${label}回答`)); assert.ok(!system.includes('通俗中文含义'));
    }
    const input = { text: '原文', context: '', modeId: 'smart' };
    assert.ok(makeMessages(s, { ...input, action: 'translate' }).system.includes(ui === 'en' ? `into ${label}` : `翻译为${label}`));
    assert.match(makeMessages(s, { ...input, action: 'learn' }).system, ui === 'en' ? /Chinese input requires Chinese/ : /原文的同一种语言/);
    assert.ok(makeMessages(s, { ...input, action: 'learn', translation: { ...s.translation, learningLanguage: 'system' } }).system.includes(ui === 'en' ? `selected ${label} as the learning output language` : `本次学习输出语言为 ${label}`));
    assert.ok(makeMessages(s, { ...input, action: 'translate', translation: { ...s.translation, target: 'ja' } }).system.includes(ui === 'en' ? 'into Japanese' : '翻译为日本語'));
  }
  s.language = '简体中文'; s.translation.target = 'zh-CN'; s.uiLanguage = 'en';
  const legacy = normalizeSettings(s); assert.equal(legacy.language, '简体中文'); assert.equal(legacy.translation.target, 'zh-CN');
  assert.match(makeMessages(legacy, { text: 'RAG', context: '', modeId: 'smart' }).system, /Respond in Simplified Chinese/ );
  s.prompts.explanation = 'CUSTOM {{language}}'; const stored = normalizeSettings(s); assert.equal(stored.prompts.explanation, 'CUSTOM {{language}}');
});

test('free translation resolves system target to a real language code', async () => {
  const original = globalThis.fetch; const pairs: string[] = [];
  try {
    globalThis.fetch = (async url => { pairs.push(new URL(String(url)).searchParams.get('langpair')!); return Response.json({responseStatus:200,responseData:{translatedText:'ok'}}); }) as typeof fetch;
    const language = { ...languageDefaults(), source: 'ja' };
    await translateFree('例', language, new AbortController().signal, 'en');
    await translateFree('例', language, new AbortController().signal, 'zh-CN');
    assert.deepEqual(pairs,['ja|en','ja|zh-CN']); assert.equal(language.target,'system');
  } finally { globalThis.fetch = original; }
});
