import { UiLocalizer } from './ui-language.ts';
const ui = new UiLocalizer(document);
import { getDocument, GlobalWorkerOptions, TextLayer, PasswordResponses, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { redirectedPdfSource, pdfPageNumber } from './pdf-routing.ts';
import { rpc } from './client.ts';
import type { PublicSettings, SearchGranularity } from './core.ts';
import { SearchPanel, type SearchSnapshot } from './search.ts';
import { clearSearchHighlight } from './search-dom.ts';
import { SEARCH_LIMITS, segmentSize, type SearchSegment } from './search-core.ts';
import { pageText, pdfSlices, pdfSource } from './pdf-text.ts';

if (window.top !== window) { document.body.textContent = '请在独立标签页打开 PDF。'; throw new Error('PDF 阅读器仅允许在独立标签页运行。'); }
void import('./content.ts');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const MAX_BYTES = 50 * 1024 * 1024;
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');
let pdf: PDFDocumentProxy | undefined, loading: PDFDocumentLoadingTask | undefined, request: AbortController | undefined;
let generation = 0, rendering = 0, current = 1, task: RenderTask | undefined, layer: TextLayer | undefined;
let renderedText: ReturnType<typeof pageText> | undefined;
let documentId = '';
let sourceUrl = '';
const SOURCE_KEY = 'plainlyPdfDocument';
function rememberSource(page = 1) { try { if (sourceUrl) sessionStorage.setItem(SOURCE_KEY, JSON.stringify({ url: sourceUrl, page })); else sessionStorage.removeItem(SOURCE_KEY); } catch {} }
const locations = new Map<string, { page: number; start: number; end: number }>();
const status = (message: string, error = false) => { $('pdf-status').textContent = message; $('pdf-status').classList.toggle('error', error); };
function documentTitle(name: string, fallback: string) {
  const title = $('document-title');
  if (name) title.dataset.i18nSkip = ''; else delete title.dataset.i18nSkip;
  title.textContent = name || fallback;
}
function controls() {
  $<HTMLButtonElement>('prev-page').disabled = !pdf || current <= 1;
  $<HTMLButtonElement>('next-page').disabled = !pdf || current >= pdf.numPages;
  $<HTMLInputElement>('page-number').disabled = !pdf;
  $<HTMLSelectElement>('zoom').disabled = !pdf;
  $<HTMLButtonElement>('pdf-search').disabled = !pdf;
  $<HTMLInputElement>('page-number').value = String(current);
  $<HTMLInputElement>('page-number').max = String(pdf?.numPages || 1);
  $('page-count').textContent = pdf ? String(pdf.numPages) : '—';
}
const panel = new SearchPanel({
  title: '在这份 PDF，找一找。',
  privacy: '点击搜索后，将文档文字片段发送至你配置的 Jev 服务。最多扫描前 200 页，超出搜索范围会提示；不上传 PDF 文件。',
  empty: '已扫描页面没有可搜索的文字层。扫描件暂不支持 OCR；可以尝试其他带文字层的 PDF。',
  collect: collectPdf,
  async locate(passage, url, signal) {
    signal.throwIfAborted();
    const target = locations.get(passage.id);
    if (url !== documentId || !target || !pdf) throw new Error('文档已更换，请重新搜索。');
    const ownGeneration = generation;
    if (current !== target.page || !renderedText) await renderPage(target.page);
    signal.throwIfAborted();
    if (ownGeneration !== generation || current !== target.page || !renderedText || !layer) throw new Error('页面已变化，请再次点击结果。');
    const start = renderedText.runs.find(r => r.end > target.start && r.start <= target.start);
    const end = renderedText.runs.find(r => r.end >= target.end && r.start < target.end);
    if (!start || !end || renderedText.text.slice(target.start, target.end) !== passage.text) throw new Error('无法定位这个片段，请重新搜索。');
    const a = layer.textDivs[start.index]?.firstChild, b = layer.textDivs[end.index]?.firstChild;
    if (!a || !b) throw new Error('该片段没有可定位的文字层。');
    const range = new Range(); range.setStart(a, target.start - start.start); range.setEnd(b, target.end - end.start);
    (CSS as any).highlights?.set('plainly-search-current', new (globalThis as any).Highlight(range));
    a.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return range.getBoundingClientRect();
  }
});
async function collectPdf(granularity: SearchGranularity, signal: AbortSignal): Promise<SearchSnapshot> {
  if (!pdf) throw new Error('请先打开 PDF。');
  const document = pdf, id = documentId; const passages: SearchSegment[] = []; locations.clear();
  let batch = 1, count = 0, chars = 0, scanned = 0, capped = false, total = 0;
  const limit = Math.min(document.numPages, 200);
  for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
    signal.throwIfAborted(); if (id !== documentId) throw new Error('文档已更换，请重新搜索。');
    const page = await document.getPage(pageNumber);
    const data = await page.getTextContent();
    signal.throwIfAborted(); if (id !== documentId) throw new Error('文档已更换，请重新搜索。');
    const { text } = pageText(data.items.filter(item => 'str' in item));
    scanned = pageNumber;
    for (const slice of pdfSlices(text, granularity)) {
      const segment = { id: `S${total++}`, text: text.slice(slice.start, slice.end), heading: `第 ${pageNumber} 页`, context: granularity === 'sentence' ? `${text.slice(Math.max(0, slice.start - 120), slice.start)}\n${text.slice(slice.end, slice.end + 119)}` : '' };
      const size = segmentSize(segment);
      if (count >= SEARCH_LIMITS.batchSegments || chars + size > SEARCH_LIMITS.batchChars) { batch++; count = 0; chars = 0; }
      if (batch > SEARCH_LIMITS.batchCount || passages.length >= SEARCH_LIMITS.maxSegments) { capped = true; break; }
      passages.push(segment); locations.set(segment.id, { page: pageNumber, ...slice }); chars += size; count++;
    }
    if (capped) break;
    panel.status(`正在读取 PDF 文字… ${pageNumber} / ${limit} 页`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  const incomplete = capped || scanned < document.numPages;
  return { passages, total, incomplete, url: id, coverage: `搜索范围：${scanned} / ${document.numPages} 页 · ${passages.length} 个片段${capped ? '。已达到本次文字上限，最后一页仅覆盖部分，后续未搜索。' : incomplete ? '。仅扫描前 200 页，后续未搜索。' : '。无文字层的页面无法搜索。'}` };
}
async function renderPage(number: number) {
  if (!pdf) return;
  const pdfDocument = pdf, ownGeneration = generation, ownRender = ++rendering;
  task?.cancel(); layer?.cancel(); renderedText = undefined; clearSearchHighlight();
  window.getSelection()?.removeAllRanges(); window.dispatchEvent(new Event('plainly-document-change'));
  const target = Math.max(1, Math.min(pdfDocument.numPages, Math.round(number) || 1));
  status(`正在显示第 ${target} 页…`);
  try {
    const page = await pdfDocument.getPage(target);
    if (ownRender !== rendering || ownGeneration !== generation) return;
    const base = page.getViewport({ scale: 1 });
    const zoom = $<HTMLSelectElement>('zoom').value;
    const scale = zoom === 'fit' ? Math.max(.25, Math.min(1.8, (innerWidth - 64) / base.width)) : Number(zoom);
    const viewport = page.getViewport({ scale });
    // Keep very large engineering drawings within a reasonable canvas memory budget.
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
    const canvas = document.createElement('canvas'); canvas.id = 'pdf-canvas';
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    task = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: 0 });
    const [, data] = await Promise.all([task.promise, page.getTextContent()]);
    if (ownRender !== rendering || ownGeneration !== generation) return;
    const container = document.createElement('div'); container.id = 'pdf-text'; container.className = 'textLayer';
    const wrapper = $('pdf-page'); wrapper.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit));
    wrapper.style.width = `${viewport.width}px`; wrapper.style.height = `${viewport.height}px`;
    wrapper.replaceChildren(canvas, container); wrapper.hidden = false; $('pdf-welcome').hidden = true;
    const textLayer = new TextLayer({ textContentSource: data, container, viewport }); layer = textLayer;
    await textLayer.render();
    // Explicit dimensions also support Chrome versions before CSS round().
    const unrotated = page.getViewport({ scale, rotation: 0 });
    container.style.width = `${unrotated.width}px`; container.style.height = `${unrotated.height}px`;
    if (ownRender !== rendering || ownGeneration !== generation) return;
    renderedText = pageText(data.items.filter(item => 'str' in item));
    current = target; rememberSource(current); controls();
    status(renderedText.text.trim() ? '选中文字，点击问号。按意思搜索可以跨页定位。' : '这一页没有可选文字，可能是扫描件。暂不支持 OCR；其他页仍可尝试。');
  } catch (error) {
    if (ownRender !== rendering || ownGeneration !== generation) return;
    throw error;
  }
}
async function showPage(number: number) { try { await renderPage(number); } catch { status('这一页无法显示，请尝试其他页或重新打开 PDF。', true); } }
async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
  if (new URL(url).protocol === 'file:') return loadLocalPdf(url, signal);
  const response = await fetch(url, { signal, credentials: 'include', referrerPolicy: 'no-referrer' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`下载失败（HTTP ${response.status}）。可以切回原生阅读器继续阅读。`); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('文件超过 50 MB，请使用较小的 PDF。'); }
  if (!response.body) throw new Error('在线文件没有内容。');
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) throw new Error('文件超过 50 MB，请使用较小的 PDF。'); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes;
}
async function loadLocalPdf(url: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.responseType = 'arraybuffer';
    const abort = () => xhr.abort(); signal.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    xhr.onerror = () => reject(new Error('无法读取本地 PDF，请检查文件是否存在，以及文件访问权限。'));
    xhr.onabort = () => reject(signal.reason || new Error('文件超过 50 MB，无法在释义中打开。'));
    xhr.onprogress = e => { if (e.loaded > MAX_BYTES || e.lengthComputable && e.total > MAX_BYTES) xhr.abort(); };
    xhr.onload = () => {
      if (!(xhr.response instanceof ArrayBuffer) || xhr.response.byteLength > MAX_BYTES) { reject(new Error('文件为空或超过 50 MB。')); return; }
      resolve(new Uint8Array(xhr.response));
    };
    xhr.send();
  });
}
async function openDocument(source: File | string, initialPage = 1) {
  const ownGeneration = ++generation; ++rendering; request?.abort(); request = new AbortController();
  task?.cancel(); layer?.cancel(); panel.invalidate('文档已更换，请重新搜索。'); locations.clear();
  window.getSelection()?.removeAllRanges(); window.dispatchEvent(new Event('plainly-document-change'));
  const old = loading; loading = undefined; pdf = undefined; renderedText = undefined; documentId = crypto.randomUUID(); current = 1;
  const dialog = $<HTMLDialogElement>('password-dialog'); dialog.onclose = null; if (dialog.open) dialog.close();
  sourceUrl = ''; rememberSource(); $('native-pdf').hidden = true; $('enable-file-access').hidden = true; $('retry-pdf').hidden = true;
  $('pdf-page').hidden = true; $('pdf-welcome').hidden = true; controls(); status('正在打开 PDF…');
  try {
    await old?.destroy(); if (ownGeneration !== generation) return;
    let bytes: Uint8Array;
    if (typeof source === 'string') {
      const url = pdfSource(source, true); sourceUrl = url; rememberSource(initialPage); $('native-pdf').hidden = false;
      const local = url.startsWith('file:');
      try { documentTitle(decodeURIComponent(new URL(url).pathname.split('/').at(-1) || ''), local ? '本地 PDF' : '在线 PDF'); } catch { documentTitle('', 'PDF'); }
      if (local && !(await chrome.extension.isAllowedFileSchemeAccess())) {
        $('enable-file-access').hidden = false;
        throw new Error('首次读取本地 PDF：请开启扩展的“允许访问文件网址”，之后直接打开文件即可。');
      }
      bytes = await download(url, AbortSignal.any([request.signal, AbortSignal.timeout(90000)]));
    } else {
      if (source.size > MAX_BYTES) throw new Error('文件超过 50 MB，请使用较小的 PDF。');
      documentTitle(source.name, '本地 PDF'); bytes = new Uint8Array(await source.arrayBuffer());
    }
    if (ownGeneration !== generation) return;
    const load = getDocument({ data: bytes, cMapUrl: chrome.runtime.getURL('pdf-assets/cmaps/'), cMapPacked: true, standardFontDataUrl: chrome.runtime.getURL('pdf-assets/standard_fonts/'), wasmUrl: chrome.runtime.getURL('pdf-assets/wasm/'), iccUrl: chrome.runtime.getURL('pdf-assets/iccs/'), enableXfa: false });
    loading = load;
    load.onPassword = (update: (password: string) => void, reason: number) => {
      if (ownGeneration !== generation) return;
      $('password-note').textContent = reason === PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重试。' : '密码仅用于在本机打开文件。';
      $<HTMLInputElement>('pdf-password').value = ''; dialog.returnValue = 'cancel';
      dialog.onclose = () => {
        if (ownGeneration !== generation) return;
        if (dialog.returnValue === 'open') { const password = $<HTMLInputElement>('pdf-password').value; $<HTMLInputElement>('pdf-password').value = ''; update(password); }
        else { $<HTMLInputElement>('pdf-password').value = ''; void load.destroy(); status('已取消打开加密 PDF。'); $('pdf-welcome').hidden = false; }
      };
      dialog.showModal(); $<HTMLInputElement>('pdf-password').focus();
    };
    const loaded = await load.promise; if (ownGeneration !== generation) { await load.destroy(); return; }
    pdf = loaded; controls(); await renderPage(initialPage); $('url-form').hidden = true;
  } catch (error) {
    if (ownGeneration !== generation) return;
    const message = (error as Error).message;
    status((error as Error).name === 'InvalidPDFException' ? '文件不是有效的 PDF，或链接返回了网页。请下载 PDF 后重新打开。' : (error as Error).name === 'TimeoutError' ? '下载超时，请重试或下载后打开。' : error instanceof TypeError ? '无法读取这份 PDF。该网站可能限制插件访问，可以切回原生阅读器。' : message || '无法打开这份 PDF。', true);
    $('pdf-welcome').hidden = false; $('retry-pdf').hidden = !sourceUrl;
  }
}
$('native-pdf').onclick = async () => { if (!sourceUrl) return; try { await rpc('openNativePdf', { url: sourceUrl, page: current }); } catch (error) { status((error as Error).message, true); } };
$('retry-pdf').onclick = () => { if (sourceUrl) void openDocument(sourceUrl, current); };
$('enable-file-access').onclick = () => void rpc('openFilePermissions');
window.addEventListener('focus', () => {
  if (!sourceUrl.startsWith('file:') || $('enable-file-access').hidden) return;
  void chrome.extension.isAllowedFileSchemeAccess().then(allowed => { if (allowed && sourceUrl && !$('enable-file-access').hidden) void openDocument(sourceUrl); });
});
$('open-file').onclick = $('welcome-open').onclick = () => $<HTMLInputElement>('pdf-file').click();
$('pdf-file').onchange = () => { const input = $<HTMLInputElement>('pdf-file'); const file = input.files?.[0]; input.value = ''; if (file) void openDocument(file); };
$('show-url').onclick = () => { $('url-form').hidden = false; $('pdf-url').focus(); };
$('hide-url').onclick = () => { $('url-form').hidden = true; };
$('url-form').onsubmit = e => { e.preventDefault(); void openDocument($<HTMLInputElement>('pdf-url').value.trim()); };
$('prev-page').onclick = () => void showPage(current - 1); $('next-page').onclick = () => void showPage(current + 1);
$('page-number').onchange = () => void showPage(Number($<HTMLInputElement>('page-number').value));
$('zoom').onchange = () => void showPage(current);
$('pdf-search').onclick = () => void panel.open();
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'openPdfSearch') { void panel.open(); reply(true); }
  if (msg.type === 'settingsChanged') { document.documentElement.dataset.theme = msg.value.theme; ui.setLanguage(msg.value.uiLanguage); }
});
document.addEventListener('keydown', event => {
  if (event.altKey && event.shiftKey && event.code === 'KeyF') { event.preventDefault(); void panel.open(); }
});
void rpc<PublicSettings>('publicSettings').then(s => { document.documentElement.dataset.theme = s.theme; ui.setLanguage(s.uiLanguage); });
let resize: ReturnType<typeof setTimeout>;
window.addEventListener('resize', () => { clearTimeout(resize); resize = setTimeout(() => { if (pdf && $<HTMLSelectElement>('zoom').value === 'fit') void showPage(current); }, 180); });
window.addEventListener('pagehide', () => { request?.abort(); task?.cancel(); void loading?.destroy(); });
// Keep document restoration in this tab's session storage, outside visible URLs.
let initialSource = redirectedPdfSource(location.search), initialPage = pdfPageNumber(location.hash);
if (!initialSource && location.hash) {
  try { const legacy = decodeURIComponent(location.hash.slice(1)); if (/^https?:/.test(legacy)) initialSource = legacy; } catch {}
}
if (!initialSource) { try { const saved = JSON.parse(sessionStorage.getItem(SOURCE_KEY) || 'null'); if (saved?.url) { initialSource = saved.url; initialPage = saved.page || 1; } } catch {} }
if (location.search || location.hash) history.replaceState(null, '', location.pathname);
if (initialSource) { $<HTMLInputElement>('pdf-url').value = initialSource; void openDocument(initialSource, initialPage); }
