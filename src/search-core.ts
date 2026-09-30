import { DEFAULT_PROMPTS, type PromptSettings } from './prompts.ts';
import type { SearchGranularity } from './core.ts';
export interface SearchSegment { id: string; text: string; heading: string; context: string; }
export interface SearchInput { query: string; segments: SearchSegment[]; }
export interface SearchMatch { id: string; weight: number; }
export interface SearchResult { matches: SearchMatch[]; exists: number; verdict: 'found' | 'uncertain' | 'absent'; scanned: number; batches: number; cached?: boolean; }
export const SEARCH_LIMITS = { batchCount: 8, batchSegments: 120, batchChars: 12000, maxSegments: 960, maxChars: 96000, segmentChars: 1600, queryChars: 400 };
export interface TextSlice { start: number; end: number; }

function trimmed(text: string, start: number, end: number): TextSlice | undefined {
  const piece = text.slice(start, end); const leading = piece.length - piece.trimStart().length;
  const trailing = piece.length - piece.trimEnd().length;
  return start + leading < end - trailing ? { start: start + leading, end: end - trailing } : undefined;
}
export function splitText(text: string, granularity: SearchGranularity): TextSlice[] {
  if (!text.trim()) return [];
  const limit = granularity === 'paragraph' ? 1600 : granularity === 'auto' ? 400 : 900;
  if (granularity !== 'sentence' && text.length <= limit) { const slice = trimmed(text, 0, text.length); return slice ? [slice] : []; }
  const sentences: TextSlice[] = [];
  for (const item of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)) {
    let start = item.index; const end = start + item.segment.length;
    while (end - start > limit) {
      let cut = start + limit;
      const whitespace = text.lastIndexOf(' ', cut);
      if (whitespace > start + limit / 2) cut = whitespace + 1;
      // Don't split a surrogate pair when exceptionally long sentences need a hard boundary.
      if (/^[\uDC00-\uDFFF]$/.test(text[cut] || '')) cut--;
      const part = trimmed(text, start, cut); if (part) sentences.push(part); start = cut;
    }
    const part = trimmed(text, start, end); if (part) sentences.push(part);
  }
  if (granularity === 'sentence') return sentences;
  const merged: TextSlice[] = [];
  for (const s of sentences) {
    const last = merged.at(-1);
    if (last && s.end - last.start <= limit) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged;
}
export function segmentSize(segment: SearchSegment) { return segment.text.length + segment.heading.length + segment.context.length + 40; }
export function packSegments(segments: SearchSegment[]): SearchSegment[][] {
  const batches: SearchSegment[][] = []; let batch: SearchSegment[] = [], chars = 0;
  for (const s of segments) {
    if (batch.length && (batch.length >= SEARCH_LIMITS.batchSegments || chars + segmentSize(s) > SEARCH_LIMITS.batchChars)) { batches.push(batch); batch = []; chars = 0; }
    batch.push(s); chars += segmentSize(s);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export function sanitizeSearchInput(raw: SearchInput): SearchInput {
  if (!raw || typeof raw.query !== 'string' || !raw.query.trim()) throw new Error('请描述你想在本页找到的内容。');
  if (raw.query.length > SEARCH_LIMITS.queryChars) throw new Error('搜索描述最多 400 个字符。');
  if (!Array.isArray(raw.segments) || !raw.segments.length) throw new Error('当前页面没有可搜索的正文。');
  if (raw.segments.length > SEARCH_LIMITS.maxSegments) throw new Error('页面片段过多，请缩小搜索范围。');
  const ids = new Set<string>();
  const segments = raw.segments.map(s => {
    if (!s || !/^S\d{1,5}$/.test(s.id) || ids.has(s.id) || typeof s.text !== 'string' || !s.text.trim() || s.text.length > SEARCH_LIMITS.segmentChars) throw new Error('页面片段格式无效，请重新提取。');
    ids.add(s.id);
    return { id: s.id, text: s.text, heading: String(s.heading || '').slice(0, 120), context: String(s.context || '').slice(0, 240) };
  });
  if (segments.reduce((n, s) => n + segmentSize(s), 0) > SEARCH_LIMITS.maxChars || packSegments(segments).length > SEARCH_LIMITS.batchCount) throw new Error('本次页面内容超出搜索上限，请缩小范围。');
  return { query: raw.query.trim(), segments };
}
export function buildJevBody(model: string, query: string, segments: SearchSegment[], prompts: PromptSettings = DEFAULT_PROMPTS) {
  return {
    model,
    state: { passages: segments },
    questions: {
      where: { type: 'choice', instructions: { query, task: prompts.jevRank }, criteria: Object.fromEntries(segments.map(s => [s.id, null])) },
      exists: { type: 'noul', instructions: { query, task: prompts.jevExists }, criteria: { true: prompts.jevTrue, false: prompts.jevFalse } }
    }
  };
}
export function parseJevResult(data: any, segments: SearchSegment[]): { matches: SearchMatch[]; exists: number } {
  const where = data?.answers?.where, exists = data?.answers?.exists;
  if (where?.type !== 'choice' || exists?.type !== 'noul' || typeof exists.noul !== 'number' || !Number.isFinite(exists.noul) || exists.noul < 0 || exists.noul > 1 || !where.probabilities || typeof where.probabilities !== 'object') throw new Error('Jev 响应格式不符合预期，请检查接口与模型配置。');
  const matches = segments.map(s => {
    const weight = where.probabilities[s.id];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('Jev 没有返回完整的片段排序，请重试。');
    return { id: s.id, weight };
  }).sort((a, b) => b.weight - a.weight);
  if (!matches.some(m => m.weight > 0)) throw new Error('Jev 返回的片段排序无效，请重试。');
  return { matches, exists: exists.noul };
}
export function searchVerdict(exists: number): SearchResult['verdict'] { return exists >= 0.7 ? 'found' : exists < 0.35 ? 'absent' : 'uncertain'; }
