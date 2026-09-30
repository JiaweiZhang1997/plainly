import type { Protocol } from './core.ts';
export interface TokenUsage { input?: number; output?: number; total?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; }
export interface UsageReport { usage?: TokenUsage; complete: boolean; }
export type UsageObserver = (report: UsageReport) => void | Promise<void>;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function parseUsage(protocol: Protocol | 'jev', raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return;
  let input: number | undefined, output: number | undefined, total: number | undefined, cacheRead: number | undefined, cacheWrite: number | undefined, reasoning: number | undefined;
  if (protocol === 'gemini') {
    input = count(raw.promptTokenCount); const visible = count(raw.candidatesTokenCount); reasoning = count(raw.thoughtsTokenCount);
    output = visible === undefined ? undefined : visible + (reasoning || 0); total = count(raw.totalTokenCount); cacheRead = count(raw.cachedContentTokenCount);
  } else if (protocol === 'anthropic' || protocol === 'jev') {
    input = count(raw.input_tokens); output = count(raw.output_tokens);
    cacheRead = count(raw.cache_read_input_tokens); cacheWrite = count(raw.cache_creation_input_tokens);
    if (protocol === 'anthropic' && input !== undefined) input += (cacheRead || 0) + (cacheWrite || 0);
    total = count(raw.total_tokens);
  } else {
    input = count(raw.prompt_tokens); output = count(raw.completion_tokens); total = count(raw.total_tokens);
    cacheRead = count(raw.prompt_tokens_details?.cached_tokens) ?? count(raw.prompt_cache_hit_tokens);
    reasoning = count(raw.completion_tokens_details?.reasoning_tokens);
  }
  total ??= input !== undefined && output !== undefined ? input + output : undefined;
  if ([input, output, total].every(v => v === undefined)) return;
  return { input, output, total, cacheRead, cacheWrite, reasoning };
}
// Streaming usage values are cumulative snapshots, not per-chunk increments.
export function mergeUsage(previous: Record<string, unknown>, next: unknown) {
  if (!next || typeof next !== 'object') return previous;
  return { ...previous, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null && value !== undefined)) };
}
export const TOKEN_FIELDS = ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
export interface UsageIdentity { key: string; name: string; model: string; protocol: Protocol | 'jev'; }
export interface UsageRow extends UsageIdentity {
  requests: number; completeReports: number; missing: number; partial: number; failed: number; updatedAt: number;
  tokens: Record<keyof TokenUsage, number>; reported: Record<keyof TokenUsage, number>;
}
export interface UsageStore { version: 1; since: number; rows: UsageRow[]; }
export function emptyUsage(): UsageStore { return { version: 1, since: Date.now(), rows: [] }; }
export function addUsage(store: UsageStore, identity: UsageIdentity, report: UsageReport, now = Date.now()) {
  let row = store.rows.find(r => r.key === identity.key);
  if (!row) {
    const zero = () => Object.fromEntries(TOKEN_FIELDS.map(f => [f, 0])) as Record<keyof TokenUsage, number>;
    row = { ...identity, requests: 0, completeReports: 0, missing: 0, partial: 0, failed: 0, updatedAt: now, tokens: zero(), reported: zero() }; store.rows.push(row);
  }
  row.name = identity.name; row.requests++; row.updatedAt = now;
  if (!report.complete) row.failed++;
  if (!report.usage) row.missing++;
  else {
    if (report.complete && report.usage.input !== undefined && report.usage.output !== undefined && report.usage.total !== undefined) row.completeReports++;
    else row.partial++;
    for (const field of TOKEN_FIELDS) {
      const value = count(report.usage[field]); if (value !== undefined) { row.tokens[field] += value; row.reported[field]++; }
    }
  }
  return store;
}
