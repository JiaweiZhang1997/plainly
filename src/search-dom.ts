import type { SearchGranularity } from './core.ts';
import { SEARCH_LIMITS, segmentSize, splitText, type SearchSegment } from './search-core.ts';

export interface Passage extends SearchSegment { range: Range; }
export interface PageSnapshot { passages: Passage[]; total: number; incomplete: boolean; url: string; }
const EXCLUDED = 'script,style,noscript,template,svg,canvas,iframe,object,embed,input,textarea,select,button,nav,[role=navigation],[contenteditable]:not([contenteditable=false]),[hidden],[inert],[aria-hidden=true],plainly-reader,plainly-search';
const BLOCK = 'p,li,td,th,pre,blockquote,dd,dt,h1,h2,h3,h4,h5,h6,div,section,article,main,body';

// Keep original text offsets so inline formatting and repeated passages remain locatable.
export async function collectPassages(granularity: SearchGranularity, signal: AbortSignal): Promise<PageSnapshot> {
  const passages: Passage[] = [];
  let total = 0, incomplete = false, heading = '', owner: Element | null = null;
  let nodes: { node: Text; start: number; end: number }[] = [], text = '';
  let batch = 1, batchCount = 0, batchChars = 0, capped = false;
  const flush = () => {
    if (!text.trim()) { text = ''; nodes = []; return; }
    for (const slice of splitText(text, granularity)) {
      const segment: SearchSegment = { id: `S${total++}`, text: text.slice(slice.start, slice.end), heading,
        context: granularity === 'sentence' ? `${text.slice(Math.max(0, slice.start - 120), slice.start)}\n${text.slice(slice.end, slice.end + 119)}` : '' };
      const size = segmentSize(segment);
      if (!capped && (batchCount >= SEARCH_LIMITS.batchSegments || batchChars + size > SEARCH_LIMITS.batchChars)) { batch++; batchCount = 0; batchChars = 0; }
      if (batch > SEARCH_LIMITS.batchCount || passages.length >= SEARCH_LIMITS.maxSegments) capped = true;
      if (capped) continue;
      const start = nodes.find(n => n.end > slice.start), end = nodes.find(n => n.end >= slice.end);
      if (!start || !end) continue;
      const range = document.createRange(); range.setStart(start.node, slice.start - start.start); range.setEnd(end.node, slice.end - end.start);
      if (range.toString() !== segment.text) continue;
      passages.push({ ...segment, range }); batchChars += size; batchCount++;
    }
    text = ''; nodes = [];
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        const closedDetails = node.parentElement?.matches('details:not([open])') && node.tagName !== 'SUMMARY';
        if (node.matches(EXCLUDED) || closedDetails || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.contentVisibility === 'hidden') { flush(); return NodeFilter.FILTER_REJECT; }
      }
      if (node instanceof Text && node.parentElement?.matches('details:not([open])')) { flush(); return NodeFilter.FILTER_REJECT; }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let visited = 0, chars = 0;
  while (walker.nextNode()) {
    signal.throwIfAborted();
    const node = walker.currentNode;
    if (node instanceof Element) {
      if (node.tagName === 'BR') flush();
      if (/^H[1-6]$/.test(node.tagName)) { flush(); heading = (node.textContent || '').trim().slice(0, 120); }
    } else if (node instanceof Text) {
      const block = node.parentElement?.closest(BLOCK) || document.body;
      if (block !== owner) { flush(); owner = block; }
      nodes.push({ node, start: text.length, end: text.length + node.length }); text += node.data; chars += node.length;
    }
    if (++visited % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    if (visited >= 50000 || chars >= 2000000) { incomplete = true; break; }
  }
  flush(); signal.throwIfAborted();
  return { passages, total, incomplete, url: location.href };
}

export function locatePassage(passage: Passage, url: string) {
  const range = passage.range;
  if (location.href !== url || !range.startContainer.isConnected || !range.endContainer.isConnected || range.toString() !== passage.text) throw new Error('页面内容已变化，请重新搜索。');
  const element = range.startContainer.parentElement;
  if (!element || !range.getClientRects().length) throw new Error('该片段当前不可见，请重新搜索。');
  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  // Refine to the sentence itself, including inside nested scrolling containers.
  for (let parent = element; parent; parent = parent.parentElement!) {
    if (parent === document.body || parent === document.documentElement) break;
    const css = getComputedStyle(parent);
    if (/(auto|scroll)/.test(css.overflowY) && parent.scrollHeight > parent.clientHeight) {
      const rect = range.getBoundingClientRect(), box = parent.getBoundingClientRect();
      parent.scrollTop += rect.top - box.top - parent.clientHeight / 2 + Math.min(rect.height, parent.clientHeight) / 2;
    }
  }
  const rect = range.getBoundingClientRect();
  if (rect.top < 80 || rect.bottom > innerHeight - 80) window.scrollBy({ top: rect.top - innerHeight / 2 + Math.min(rect.height, innerHeight) / 2, behavior: 'instant' });
  const highlights = (CSS as any).highlights;
  if (highlights && (globalThis as any).Highlight) highlights.set('plainly-search-current', new (globalThis as any).Highlight(range));
}
export function clearSearchHighlight() { (CSS as any).highlights?.delete('plainly-search-current'); }
