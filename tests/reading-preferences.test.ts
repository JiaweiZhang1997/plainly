import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, normalizeSettings, makeMessages, outputTokenBudget } from '../src/core.ts';

test('reading appearance migrates without changing existing preferences and bounds invalid dimensions', () => {
  const legacy: any = defaults(); delete legacy.appearance; delete legacy.targetCharacters;
  legacy.length = 'detailed'; legacy.modes[0].prompt = 'Keep my prompt';
  const s = normalizeSettings(legacy); assert.deepEqual(s.appearance, { fontSize: 12, cardWidth: 350, cardMaxHeight: 580 });
  assert.equal(s.length, 'detailed'); assert.equal(s.modes[0].prompt, 'Keep my prompt'); assert.equal(s.targetCharacters, 300);
  const corrupt = normalizeSettings({ ...s, appearance: { fontSize: NaN, cardWidth: 90000, cardMaxHeight: -10 }, targetCharacters: Infinity });
  assert.deepEqual(corrupt.appearance, { fontSize: 12, cardWidth: 800, cardMaxHeight: 180 }); assert.equal(corrupt.targetCharacters, 300);
});
test('custom character target reaches explanation prompt with adequate budget and does not shorten translations', () => {
  const s = normalizeSettings({ ...defaults(), length: 'custom', targetCharacters: 5000 });
  const input = { text: 'RAG', context: '', modeId: 'term' };
  assert.match(makeMessages(s, input).system, /约 5000 个字符/); assert.ok(outputTokenBudget(s) >= 10000);
  assert.ok(!makeMessages(s, { ...input, action: 'translate' }).system.includes('5000'));
  assert.equal(outputTokenBudget(s, 'translate'), 8192);
  assert.equal(outputTokenBudget(s, 'learn'), 2048);
  assert.equal(normalizeSettings({ ...s, targetCharacters: 1 }).targetCharacters, 50);
});

test('drag dismissal defaults to keeping cards and preserves an explicit opt-in', () => {
  const legacy: any = defaults(); delete legacy.closeAfterDrag;
  assert.equal(normalizeSettings(legacy).closeAfterDrag, false);
  assert.equal(normalizeSettings({ ...legacy, closeAfterDrag: true }).closeAfterDrag, true);
  assert.equal(normalizeSettings({ ...legacy, closeAfterDrag: 'false' } as any).closeAfterDrag, false);
});

test('appearance sliders center defaults and round-trip every supported pixel value', async () => {
  const { APPEARANCE_DEFAULTS, APPEARANCE_LIMITS, appearanceToSlider, appearanceFromSlider } = await import('../src/reading-preferences.ts');
  for (const field of Object.keys(APPEARANCE_DEFAULTS) as (keyof typeof APPEARANCE_DEFAULTS)[]) {
    const [min, max] = APPEARANCE_LIMITS[field];
    assert.equal(appearanceToSlider(field, APPEARANCE_DEFAULTS[field]), 500);
    assert.equal(appearanceFromSlider(field, 500), APPEARANCE_DEFAULTS[field]);
    assert.equal(appearanceFromSlider(field, -50), min);
    assert.equal(appearanceFromSlider(field, 1050), max);
    for (let value = min; value <= max; value++) assert.equal(appearanceFromSlider(field, appearanceToSlider(field, value)), value);
  }
});
