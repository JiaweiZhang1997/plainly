import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, normalizeSettings, publicSettings } from '../src/core.ts';
import { splitText, packSegments, sanitizeSearchInput, buildJevBody, parseJevResult, segmentSize, SEARCH_LIMITS, searchVerdict, type SearchSegment } from '../src/search-core.ts';
import { searchJev } from '../src/jev.ts';
const segments = (n: number, size = 50): SearchSegment[] => Array.from({ length: n }, (_, i) => ({ id: `S${i}`, text: `${i} ${'句'.repeat(size)}`, heading: '', context: '' }));
function response(passages: SearchSegment[], exists = .9) { return { answers: { where: { type: 'choice', choice: passages[0].id, probabilities: Object.fromEntries(passages.map((s, i) => [s.id, i === 0 ? .8 : .2 / (passages.length - 1)])) }, exists: { type: 'noul', noul: exists } } }; }

test('Jev settings migrate safely and neither key nor private endpoint reaches content', () => {
  const old: any = defaults(); delete old.jev; old.profiles[0].apiKey = 'keep-llm';
  const migrated = normalizeSettings(old); assert.equal(migrated.jev.granularity, 'auto'); assert.equal(migrated.profiles[0].apiKey, 'keep-llm');
  migrated.jev = { ...migrated.jev, apiKey: 'jev-secret', baseUrl: 'https://private-jev.test/v1' };
  const publicValue = JSON.stringify(publicSettings(migrated));
  for (const secret of ['keep-llm', 'jev-secret', 'private-jev']) assert.ok(!publicValue.includes(secret));
  assert.equal(publicSettings(migrated).searchConfigured, true);
});
test('sentence splitting preserves exact Chinese/English offsets and automatic mode keeps short paragraphs', () => {
  const text = '  第一条规则。Second sentence! 最后一句？  ';
  const parts = splitText(text, 'sentence'); assert.deepEqual(parts.map(p => text.slice(p.start, p.end)), ['第一条规则。', 'Second sentence!', '最后一句？']);
  assert.deepEqual(splitText(text, 'auto').map(p => text.slice(p.start, p.end)), [text.trim()]);
  const long = '😀'.repeat(2100);
  for (const mode of ['auto', 'paragraph', 'sentence'] as const) {
    const chunks = splitText(long, mode).map(p => long.slice(p.start, p.end));
    assert.equal(chunks.join(''), long); assert.ok(chunks.every(c => c.isWellFormed() && c.length <= 1600));
  }
});
test('batch limits bound content and candidate counts; malformed and oversize input is rejected', () => {
  const chunks = packSegments(segments(250, 180));
  assert.ok(chunks.every(c => c.length <= 120 && c.reduce((n, s) => n + segmentSize(s), 0) <= 12000));
  assert.throws(() => sanitizeSearchInput({ query: ' ', segments: segments(2) }));
  assert.throws(() => sanitizeSearchInput({ query: 'q', segments: [segments(1)[0], segments(1)[0]] }));
  assert.throws(() => sanitizeSearchInput({ query: 'q', segments: segments(90, 1601) }));
  assert.throws(() => sanitizeSearchInput({ query: 'q', segments: segments(961) }));
  assert.throws(() => sanitizeSearchInput({ query: 'q', segments: segments(100, 1500) }));
});
test('Choice distribution does not imply relevance; unknown IDs cannot become navigation targets', () => {
  const input = segments(2), body = buildJevBody('jev-latest', '<script>query</script>', input);
  assert.equal(body.questions.where.type, 'choice'); assert.equal(body.questions.exists.type, 'noul');
  const answer = response(input, .1); (answer.answers.where.probabilities as any).evil = 1;
  const parsed = parseJevResult(answer, input); assert.deepEqual(parsed.matches.map(m => m.id), ['S0', 'S1']);
  assert.equal(searchVerdict(parsed.exists), 'absent'); assert.equal(searchVerdict(.5), 'uncertain');
  delete (answer.answers.where.probabilities as any).S0; assert.throws(() => parseJevResult(answer, input));
  assert.throws(() => parseJevResult({}, input));
  const zero = response(input); zero.answers.where.probabilities = { S0: 0, S1: 0 }; assert.throws(() => parseJevResult(zero, input));
});
test('long documents use bounded hierarchical reranking, not cross-batch probabilities', async () => {
  const original = globalThis.fetch, bodies: any[] = []; let inFlight = 0, peak = 0;
  const config = { ...defaults().jev, baseUrl: 'http://localhost:8099/v1', apiKey: 'test-key' };
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), 'http://localhost:8099/v1/systemone'); assert.equal((init?.headers as any).Authorization, 'Bearer test-key');
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      assert.ok(body.state.passages.reduce((n: number, s: SearchSegment) => n + segmentSize(s), 0) <= SEARCH_LIMITS.batchChars);
      peak = Math.max(peak, ++inFlight); await new Promise(r => setTimeout(r, 2)); inFlight--;
      return Response.json(response(body.state.passages));
    }) as typeof fetch;
    const input = sanitizeSearchInput({ query: 'related meaning', segments: segments(49, 1500) });
    const result = await searchJev(config, input, new AbortController().signal, () => {});
    assert.equal(result.batches, 7); assert.equal(result.scanned, 49); assert.equal(peak, 2);
    assert.ok(bodies.length > 8, 'large shortlisted paragraphs require bounded merge rounds');
    const finalIds = new Set(bodies.at(-1).state.passages.map((s: SearchSegment) => s.id));
    assert.ok(result.matches.every(m => finalIds.has(m.id)));
  } finally { globalThis.fetch = original; }
});
test('Jev service errors do not leak response bodies, and cancellation halts queued batches', async () => {
  const original = globalThis.fetch, config = { ...defaults().jev, baseUrl: 'http://localhost:8099/v1/systemone' };
  try {
    globalThis.fetch = (async () => new Response('secret-key', { status: 429 })) as typeof fetch;
    await assert.rejects(searchJev(config, { query: 'q', segments: segments(1) }, new AbortController().signal, () => {}), error => /额度/.test(String(error)) && !String(error).includes('secret-key'));
    const abort = new AbortController(); let calls = 0;
    globalThis.fetch = (async (_, init) => { calls++; abort.abort(); init?.signal?.throwIfAborted(); throw new Error('unreachable'); }) as typeof fetch;
    await assert.rejects(searchJev(config, { query: 'q', segments: segments(240) }, abort.signal, () => {}));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
