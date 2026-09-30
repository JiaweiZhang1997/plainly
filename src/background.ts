import { resolvePrompts, promptLocale } from './prompts.ts';
import { uiText } from './ui-language.ts';
import { syncPdfIntegration, openNativePdf } from './pdf-integration.ts';
import { addUsage, emptyUsage, type UsageStore, type UsageObserver } from './usage.ts';
import { pdfSource } from './pdf-text.ts';
import { defaults, normalizeSettings, publicSettings, sanitizeInput, makeMessages, outputTokenBudget, type Settings, type Profile, type ExplainInput } from './core.ts';
import { streamModel } from './providers.ts';
import { searchJev } from './jev.ts';
import { sanitizeSearchInput, type SearchResult } from './search-core.ts';
import { resolveLanguageSettings } from './language.ts';
import { LearningLanguageResolver } from './learning-language.ts';
import { translateFree, lookupDictionary } from './free-language.ts';

// Content scripts receive only a redacted projection through the message channel.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const cache = new Map<string, { output: string; time: number }>();
const learningLanguages = new LearningLanguageResolver();
let usageQueue: Promise<unknown> = Promise.resolve();
function usageObserver(identity: { id: string; name: string; model: string; protocol: Profile['protocol'] | 'jev'; baseUrl: string }): UsageObserver {
  return async report => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([identity.id, identity.protocol, identity.baseUrl, identity.model])));
    const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const update = usageQueue.then(async () => {
      await ready;
      const stored = (await chrome.storage.local.get('plainlyUsage')).plainlyUsage as UsageStore | undefined;
      const value = addUsage(stored?.version === 1 ? stored : emptyUsage(), { key, name: identity.name, model: identity.model, protocol: identity.protocol }, report);
      await chrome.storage.local.set({ plainlyUsage: value });
    });
    usageQueue = update.catch(() => {}); await update;
  };
}
const searchCache = new Map<string, { result: SearchResult; time: number }>();
async function settings(): Promise<Settings> {
  await ready;
  const data = await chrome.storage.local.get('plainly');
  return data.plainly ? normalizeSettings(data.plainly as Settings) : defaults();
}
void settings().then(s => syncPdfIntegration(s.pdfAutoOpen)).catch(() => {});
function trusted(sender: chrome.runtime.MessageSender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}
async function broadcast() {
  const value = publicSettings(await settings());
  await chrome.contextMenus.update('plainly-explain', { title: uiText('在侧栏解释 / 翻译', value.uiLanguage) + '「%s」' }).catch(() => {});
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter(t => t.id).map(t => chrome.tabs.sendMessage(t.id!, { type: 'settingsChanged', value })));
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.plainly) { cache.clear(); searchCache.clear(); learningLanguages.clear(); void settings().then(s => syncPdfIntegration(s.pdfAutoOpen)).catch(() => {}); void broadcast(); } });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    if (msg.type === 'publicSettings') return publicSettings(await settings());
    if (msg.type === 'openSettings') {
      if (msg.page === 'search') await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#search') });
      else await chrome.runtime.openOptionsPage();
      return true;
    }
    if (!trusted(sender)) throw new Error('此操作只能在插件设置页执行。');
    if (msg.type === 'getUsage') { await ready; await usageQueue; return (await chrome.storage.local.get('plainlyUsage')).plainlyUsage || emptyUsage(); }
    if (msg.type === 'getSettings') return settings();
    if (msg.type === 'saveSettings') { const value = normalizeSettings(msg.value); await syncPdfIntegration(value.pdfAutoOpen); await chrome.storage.local.set({ plainly: value }); return value; }
    if (msg.type === 'clearCache') { cache.clear(); searchCache.clear(); learningLanguages.clear(); return true; }
    if (msg.type === 'pdfIntegrationStatus') { await syncPdfIntegration((await settings()).pdfAutoOpen); return { fileAccess: await chrome.extension.isAllowedFileSchemeAccess() }; }
    if (msg.type === 'openFilePermissions') { await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }); return true; }
    if (msg.type === 'openNativePdf') {
      if (!sender.tab?.id || !sender.url?.startsWith(chrome.runtime.getURL('pdf.html'))) throw new Error('请在 PDF 阅读器中使用这个操作。');
      await openNativePdf(sender.tab.id, String(msg.url), Number(msg.page)); return true;
    }
    if (msg.type === 'openPdf') { const url = chrome.runtime.getURL('pdf.html') + (msg.url ? '?source=' + pdfSource(msg.url, true) : ''); if (Number.isInteger(msg.sameTabId) && msg.sameTabId >= 0) await chrome.tabs.update(msg.sameTabId, { url }); else await chrome.tabs.create({ url }); return true; }
    if (msg.type === 'openSearch') { await openSearch(); return true; }
    if (msg.type === 'testJev') {
      const config = normalizeSettings({ ...defaults(), jev: msg.jev }).jev;
      const start = Date.now();
      await searchJev(config, { query: '如何取消订单', segments: [
        { id: 'S0', text: '在订单详情中选择取消订单。', heading: '', context: '' },
        { id: 'S1', text: '配送一般需要三天。', heading: '', context: '' }
      ] }, AbortSignal.timeout(25000), () => {}, defaults().prompts, usageObserver({ ...config, id: 'jev', name: 'Jev', protocol: 'jev' }));
      return { ms: Date.now() - start };
    }
    if (msg.type === 'testProfile') {
      const profile = normalizeSettings({ ...defaults(), profiles: [msg.profile] }).profiles[0];
      const start = Date.now();
      await streamModel(profile, 'Reply with OK only.', [{ role: 'user', content: 'Connection test' }], AbortSignal.timeout(25000), () => {}, 256, usageObserver(profile));
      return { ms: Date.now() - start };
    }
    throw new Error('未知操作。');
  })().then(value => reply({ ok: true, value })).catch(e => reply({ ok: false, error: safeError(e) }));
  return true;
});
function safeError(error: unknown) {
  if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) return '请求超时或已取消，请重试。';
  if (error instanceof TypeError) return '无法连接模型服务，请检查网络、API 地址及服务是否允许浏览器访问。';
  return error instanceof Error ? error.message : '暂时无法解释，请重试。';
}

const active = new Map<string, AbortController>();
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'plainly-search' || port.sender?.id !== chrome.runtime.id) return;
  let controller: AbortController | undefined, disconnected = false;
  const post = (data: object) => { if (!disconnected) try { port.postMessage(data); } catch { controller?.abort(); } };
  port.onDisconnect.addListener(() => { disconnected = true; controller?.abort(); });
  port.onMessage.addListener(msg => {
    if (msg.type === 'cancel') { controller?.abort(); return; }
    if (msg.type !== 'search') return;
    controller?.abort(); const request = new AbortController(); controller = request;
    const id = String(msg.id || '').slice(0, 100);
    const send = (data: object) => { if (!request.signal.aborted) post({ ...data, id }); };
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
    const timeout = setTimeout(() => { send({ type: 'error', error: '本次搜索超时，请重试。' }); request.abort(); }, 120000);
    (async () => {
      const input = sanitizeSearchInput(msg.input), prefs = await settings(), config = prefs.jev;
      request.signal.throwIfAborted();
      const prompts = resolvePrompts(prefs.prompts, promptLocale(prefs));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([config, prompts, input])));
      const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const hit = searchCache.get(key);
      if (hit && Date.now() - hit.time < 600000) { send({ type: 'done', result: { ...hit.result, cached: true } }); return; }
      const result = await searchJev(config, input, request.signal, (done, total, stage) => send({ type: 'progress', done, total, stage }), prompts, usageObserver({ ...config, id: 'jev', name: 'Jev', protocol: 'jev' }));
      request.signal.throwIfAborted();
      searchCache.set(key, { result, time: Date.now() });
      while (searchCache.size > 10) searchCache.delete(searchCache.keys().next().value!);
      send({ type: 'done', result });
    })().catch(error => { if (!request.signal.aborted) send({ type: 'error', error: safeError(error) }); }).finally(() => { clearInterval(heartbeat); clearTimeout(timeout); request.abort(); });
  });
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'plainly-explain' || port.sender?.id !== chrome.runtime.id) return;
  const client = port.sender?.tab ? `${port.sender.tab.id}:${port.sender.frameId}` : `page:${crypto.randomUUID()}`;
  let controller: AbortController | undefined, disconnected = false;
  const post = (data: unknown) => { if (!disconnected) try { port.postMessage(data); } catch { disconnected = true; controller?.abort(); } };
  port.onDisconnect.addListener(() => { disconnected = true; controller?.abort(); if (active.get(client) === controller) active.delete(client); });
  port.onMessage.addListener(msg => {
    if (msg.type === 'cancel') { controller?.abort(); return; }
    if (msg.type !== 'explain') return;
    controller?.abort(); active.get(client)?.abort();
    const request = new AbortController(); controller = request; active.set(client, request);
    const id = String(msg.id || '').slice(0, 100);
    const send = (data: object) => { if (!request.signal.aborted) post({ ...data, id }); };
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
    const timeout = setTimeout(() => { send({ type: 'error', error: '等待模型响应超时，请重试或更换模型。' }); request.abort(); }, 90000);
    (async () => {
      const s = await settings();
      if (request.signal.aborted) return;
      const input = sanitizeInput(msg.input as ExplainInput);
      const p = s.profiles.find(p => p.id === s.activeProfile)!;
      const language = resolveLanguageSettings({ ...s.translation, ...input.translation }, s.uiLanguage);
      const free = input.action === 'dictionary' || input.action === 'translate' && language.engine === 'mymemory';
      const modelLabel = input.action === 'dictionary' ? uiText('Free Dictionary API · 英英词典', s.uiLanguage) : free ? uiText('MyMemory · 免费翻译', s.uiLanguage) : `${p.name} · ${p.model}`;
      if (free && (input.question || input.history?.length)) throw new Error('免费翻译和词典不支持追问，请切换 LLM。');
      send({ type: 'start', model: modelLabel });
      const detectedLanguage = input.action === 'learn' && language.learningLanguage === 'auto'
        ? await learningLanguages.resolve(JSON.stringify([p.id, p.baseUrl, p.model, p.protocol]), input.text, request.signal,
          ({ system, turns }) => streamModel(p, system, turns, request.signal, () => {}, 256, usageObserver(p)))
        : undefined;
      const { system, turns } = makeMessages(s, input, detectedLanguage);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(free ? [modelLabel, input.text, language.source, language.target] : [p, system, turns])));
      const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (request.signal.aborted) return;
      const hit = cache.get(key);
      if (!input.fresh && hit && Date.now() - hit.time < 600000) { send({ type: 'chunk', text: hit.output }); send({ type: 'done', cached: true }); return; }
      const freeSignal = free ? AbortSignal.any([request.signal, AbortSignal.timeout(25000)]) : request.signal;
      const result = free ? { output: input.action === 'dictionary' ? await lookupDictionary(input.text, freeSignal, s.uiLanguage) : await translateFree(input.text, language, freeSignal), truncated: false }
        : await streamModel(p as Profile, system, turns, request.signal, text => send({ type: 'chunk', text }), outputTokenBudget(s, input.action), usageObserver(p));
      if (free) send({ type: 'chunk', text: result.output });
      if (request.signal.aborted) return;
      if (!result.truncated) {
        cache.delete(key); cache.set(key, { output: result.output, time: Date.now() });
        while (cache.size > 40) cache.delete(cache.keys().next().value!);
      }
      send({ type: 'done', truncated: result.truncated });
    })().catch(error => { if (!request.signal.aborted) send({ type: 'error', error: safeError(error) }); }).finally(() => {
      clearInterval(heartbeat); clearTimeout(timeout);
      if (active.get(client) === request) active.delete(client);
    });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'plainly-explain', title: '在侧栏解释 / 翻译「%s」', contexts: ['selection'] }, () => { void settings().then(s => chrome.contextMenus.update('plainly-explain', { title: uiText('在侧栏解释 / 翻译', s.uiLanguage) + '「%s」' })).catch(() => {}); });
  });
  void (async () => {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter(t => t.id && /^https?:/.test(t.url || '')).map(t => chrome.scripting.executeScript({ target: { tabId: t.id!, allFrames: true }, files: ['content.js'] })));
  })();
});
async function openForSelection(tabId: number, frameId?: number, text?: string) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'explainSelection', text }, frameId !== undefined ? { frameId } : {}); }
  catch {
    if (text) await chrome.storage.session.set({ pendingSelection: text.slice(0, 4000) });
    await chrome.action.openPopup().catch(() => {});
  }
}
const panelSelections = new Map<number, string>();
// Open synchronously inside the browser gesture; awaiting a message first loses permission.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'plainly-explain' || tab?.id === undefined || !info.selectionText) return;
  const selectionId = crypto.randomUUID(); panelSelections.set(tab.id, selectionId);
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  const sourceUrl = tab.url || info.pageUrl || '';
  void (async () => {
    let nativePdf = (info.frameUrl || '').startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/') || /\.pdf(?:$|[?#])/i.test(sourceUrl);
    if (!nativePdf) {
      try { const result = await chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, func: () => document.contentType === 'application/pdf' || !!document.querySelector('embed[type="application/pdf"],object[type="application/pdf"]') }); nativePdf = !!result[0]?.result; } catch {}
    }
    const current = await chrome.tabs.get(tab.id!);
    if (panelSelections.get(tab.id!) !== selectionId || (current.url && sourceUrl && current.url !== sourceUrl)) return;
    await chrome.storage.session.set({ [`panelSelection:${tab.id}`]: { id: selectionId, text: info.selectionText!.slice(0, 4000), sourceUrl, nativePdf } });
  })().catch(() => {});
  void opening.catch(async () => { await chrome.storage.session.set({ pendingSelection: info.selectionText!.slice(0, 4000) }); await chrome.action.openPopup().catch(() => {}); });
});
chrome.tabs.onRemoved.addListener(tabId => { panelSelections.delete(tabId); void chrome.storage.session.remove(`panelSelection:${tabId}`); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') { panelSelections.delete(tabId); void chrome.storage.session.remove(`panelSelection:${tabId}`); } });
chrome.commands.onCommand.addListener(command => {
  if (command === 'explain-selection') void chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => { if (tabs[0]?.id) void openForSelection(tabs[0].id); });
  if (command === 'search-page') void openSearch().catch(() => chrome.action.openPopup().catch(() => {}));
});
async function openSearch() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.url?.startsWith(chrome.runtime.getURL('pdf.html'))) { await chrome.tabs.sendMessage(tab.id, { type: 'openPdfSearch' }); return; }
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('请在普通网页中打开页内搜索。PDF 请先使用插件中的 PDF 阅读器打开。');
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['search.js'] }); }
  catch { throw new Error('这个页面不允许插件运行，请换一个普通网页。'); }
}
