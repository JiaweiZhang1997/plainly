import type { SearchGranularity } from './core.ts';
import { splitText, type TextSlice } from './search-core.ts';
export interface PdfTextItem { str: string; hasEOL?: boolean; transform: number[]; height: number; }
export interface PdfTextRun extends TextSlice { index: number; }
export function pageText(items: PdfTextItem[]) {
  let text = ''; const runs: PdfTextRun[] = []; let previous: PdfTextItem | undefined;
  items.forEach((item, index) => {
    if (previous && text && !text.endsWith('\n') && previous.hasEOL) text += '\n';
    // PDF has physical lines, not semantic paragraphs: use the larger vertical gaps as boundaries.
    if (previous && Math.abs(item.transform[5] - previous.transform[5]) > Math.max(item.height, previous.height, 1) * 1.7 && text && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n';
    const start = text.length; text += item.str; runs.push({ index, start, end: text.length });
    if (item.hasEOL) text += '\n';
    previous = item;
  });
  return { text, runs };
}
export function pdfSlices(text: string, granularity: SearchGranularity): TextSlice[] {
  return [...text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)].flatMap(block => splitText(block[0], granularity).map(slice => ({ start: block.index! + slice.start, end: block.index! + slice.end })));
}
export function pdfSource(value: string, allowLocal = false) {
  let url: URL; try { url = new URL(value); } catch { throw new Error('请填写 PDF 文件的完整在线地址。'); }
  if (allowLocal && url.protocol === 'file:' && /\.pdf$/i.test(url.pathname)) { url.hash = ''; return url.href; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('在线 PDF 仅支持 HTTP / HTTPS 链接；本地文件请用“打开文件”。');
  url.hash = ''; return url.href;
}
