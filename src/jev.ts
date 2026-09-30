import { parseUsage, type UsageObserver } from './usage.ts';
import { DEFAULT_PROMPTS, type PromptSettings } from './prompts.ts';
import { isLoopback, validateEndpoint, type JevSettings } from './core.ts';
import { buildJevBody, parseJevResult, packSegments, searchVerdict, type SearchInput, type SearchSegment, type SearchResult } from './search-core.ts';

async function evaluate(config: JevSettings, query: string, segments: SearchSegment[], signal: AbortSignal, prompts: PromptSettings, onUsage?: UsageObserver) {
  const base = validateEndpoint(config.baseUrl);
  if (!config.apiKey && !isLoopback(base)) throw new Error('请先在设置的“页内搜索”中填写 Jev API Key。');
  const url = base.endsWith('/systemone') ? base : `${base}/systemone`;
  let payload: any, complete = false;
  try {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify(buildJevBody(config.model, query, segments, prompts)), signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    if ([401,403].includes(response.status)) throw new Error('Jev 授权失败，请检查 API Key 与账户权限。');
    if ([429,529].includes(response.status)) throw new Error('Jev 当前繁忙或请求额度不足，请稍后重试。');
    if ([400,404,422].includes(response.status)) throw new Error('Jev 接口或模型配置不匹配，请核对地址和模型名称。');
    throw new Error(`Jev 暂时不可用（HTTP ${response.status}），请稍后重试。`);
  }
  payload = await response.json();
  const result = parseJevResult(payload, segments); complete = true; return result;
  } finally { await Promise.resolve(onUsage?.({ usage: parseUsage('jev', payload?.usage), complete })).catch(() => {}); }
}
export async function searchJev(config: JevSettings, input: SearchInput, signal: AbortSignal, progress: (done: number, total: number, stage: string) => void, prompts: PromptSettings = DEFAULT_PROMPTS, onUsage?: UsageObserver): Promise<SearchResult> {
  const batches = packSegments(input.segments);
  // A single shared distribution for normal pages; no need for another ranking request.
  if (batches.length === 1) {
    progress(0, 1, '正在按含义查找…');
    const result = await evaluate(config, input.query, batches[0], signal, prompts, onUsage);
    return { matches: result.matches.filter(m => m.weight > 0).slice(0, 8), exists: result.exists, verdict: searchVerdict(result.exists), scanned: input.segments.length, batches: 1 };
  }
  const candidates: SearchSegment[] = [];
  let index = 0, done = 0;
  const scan = async () => {
    while (index < batches.length) {
      signal.throwIfAborted(); const batch = batches[index++];
      const result = await evaluate(config, input.query, batch, signal, prompts, onUsage);
      const top = new Set(result.matches.slice(0, 3).map(m => m.id));
      candidates.push(...batch.filter(s => top.has(s.id)));
      progress(++done, batches.length, '正在分段搜索长网页…');
    }
  };
  await Promise.all([scan(), scan()]);
  signal.throwIfAborted(); progress(done, batches.length, '正在整理相关片段…');
  // Choice probabilities from separate batches are not comparable: rank all shortlisted IDs together.
  candidates.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  // Keep every merge within the same context budget, including paragraph mode.
  let shortlist = candidates;
  while (packSegments(shortlist).length > 1) {
    const next: SearchSegment[] = [];
    for (const batch of packSegments(shortlist)) {
      signal.throwIfAborted();
      const ranked = await evaluate(config, input.query, batch, signal, prompts, onUsage);
      const top = new Set(ranked.matches.slice(0, 3).map(m => m.id));
      next.push(...batch.filter(s => top.has(s.id)));
    }
    shortlist = next;
  }
  const result = await evaluate(config, input.query, shortlist, signal, prompts, onUsage);
  return { matches: result.matches.filter(m => m.weight > 0).slice(0, 8), exists: result.exists, verdict: searchVerdict(result.exists), scanned: input.segments.length, batches: batches.length };
}
