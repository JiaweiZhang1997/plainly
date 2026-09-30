// Opt-in, small real-service probe. Read the key from stdin; never persist it.
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { defaults } from '../src/core.ts';
import { searchJev } from '../src/jev.ts';
const reader = createInterface({ input: process.stdin, terminal: false });
console.log('READY_FOR_KEY');
let apiKey = '';
for await (const line of reader) { apiKey = line.trim(); break; }
reader.close(); process.stdin.pause();
if (!apiKey.startsWith('apikey_')) throw new Error('Expected a Jev key on stdin.');
const config = { ...defaults().jev, apiKey };
const texts = ['商品签收后七天内，可在订单详情申请退货退款。', '账户设置中可以修改昵称、头像和密码。', '我们采用检索增强生成：先从文档找到资料，再让模型组织回答。', 'Annual subscriptions renew automatically. You can turn off renewal in Billing.'];
const segments = texts.map((text, i) => ({ id: `S${i}`, text, heading: '', context: '' }));
const cases = [
  { name: '中文同义改写', query: '买的东西不想要了，钱能拿回来吗', expected: 'S0' },
  { name: '无关键词的英文意图', query: 'How do I stop being charged next year?', expected: 'S3' },
  { name: '跨语言检索', query: '明年不想继续扣费了怎么办', expected: 'S3' },
  { name: '专业术语释义匹配', query: '这里说的 RAG 是怎么工作的', expected: 'S2' },
  { name: '无相关结果', query: '如何在火星上维修核聚变发动机', expected: null }
];
const report = { date: new Date().toISOString(), model: config.model, cases: [] };
for (const sample of cases) {
  const start = performance.now();
  try {
    const result = await searchJev(config, { query: sample.query, segments }, AbortSignal.timeout(45000), () => {});
    const actual = result.verdict === 'absent' ? null : result.matches[0]?.id;
    const row = { ...sample, actual, verdict: result.verdict, exists: result.exists, ms: Math.round(performance.now() - start), passed: actual === sample.expected };
    report.cases.push(row); console.log(JSON.stringify(row));
  } catch (error) {
    const row = { name: sample.name, error: String(error.message).replaceAll(apiKey, '[redacted]'), ms: Math.round(performance.now() - start) };
    report.cases.push(row); console.log(JSON.stringify(row)); break;
  }
}
apiKey = ''; config.apiKey = '';
await mkdir('test-results', { recursive: true });
await writeFile('test-results/live-jev-report.json', JSON.stringify(report, null, 2));
