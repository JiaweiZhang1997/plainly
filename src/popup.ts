import { UiLocalizer, uiText } from './ui-language.ts';
const ui = new UiLocalizer(document);
import { explain, rpc } from './client.ts';
import { localizedModeField, normalizeSettings, type Settings } from './core.ts';
import { orderedActions, type ReadAction } from './language.ts';
import { ReadingLanguageControl } from './reading-language-control.ts';
const inSidePanel = location.pathname.endsWith('/sidepanel.html');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
let cancel: (() => void) | undefined, result = '', epoch = 0, busy = false;
async function main() {
  let s = await rpc<Settings>('getSettings'); ui.setLanguage(s.uiLanguage); document.documentElement.dataset.theme = s.theme; document.documentElement.style.setProperty('--answer-font-size', `${s.appearance.fontSize}px`);
  let action: ReadAction = s.defaultAction;
  const tabs = $('reading-actions');
  const invalidate = () => { cancel?.(); epoch++; busy = false; result = ''; $('answer').hidden = true; $('status').textContent = ''; $('submit').textContent = action === 'explain' ? '解释 ↗' : action === 'learn' ? '同语学习 ↗' : action === 'dictionary' ? '查词 ↗' : '翻译 ↗'; document.querySelector<HTMLElement>('.popup-result-actions')!.hidden = true; };
  const languageControls = new ReadingLanguageControl($<HTMLSelectElement>('language-choice'), s.translation, () => { const rerun = busy || !!result; invalidate(); if (rerun) run(); });
  function updateAction() { languageControls.show(action); $('mode').hidden = action !== 'explain'; tabs.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.action === action))); invalidate(); }
  function renderSettings() {
    ui.setLanguage(s.uiLanguage); document.documentElement.dataset.theme = s.theme;
    document.documentElement.style.setProperty('--answer-font-size', `${s.appearance.fontSize}px`);
    tabs.replaceChildren();
    for (const a of orderedActions(s.enabledActions, s.defaultAction)) { const b = document.createElement('button'); b.textContent = a.name; b.type = 'button'; b.dataset.action = a.id; b.onclick = () => { action = a.id; updateAction(); }; tabs.append(b); }
    tabs.hidden = s.enabledActions.length < 2;
    languageControls.setUiLanguage(s.uiLanguage); languageControls.set(s.translation);
    $('mode').replaceChildren(...s.modes.map(m => { const o = new Option(localizedModeField(m, 'name', s.uiLanguage), m.id); o.dataset.i18nSkip = ''; return o; })); $<HTMLSelectElement>('mode').value = s.defaultMode;
    const p = s.profiles.find(p => p.id === s.activeProfile);
    $('model-label').textContent = p?.model ? `${p.name} · ${p.model}` : uiText('先在设置中连接模型', s.uiLanguage);
    updateAction();
  }
  renderSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.plainly?.newValue) return;
    const updated = normalizeSettings(changes.plainly.newValue as Settings);
    const actionChanged = updated.defaultAction !== s.defaultAction || !updated.enabledActions.includes(action);
    const readingChanged = actionChanged || JSON.stringify([updated.enabledActions, updated.translation, updated.modes, updated.defaultMode, updated.activeProfile, updated.profiles]) !== JSON.stringify([s.enabledActions, s.translation, s.modes, s.defaultMode, s.activeProfile, s.profiles]);
    s = updated;
    ui.setLanguage(s.uiLanguage); document.documentElement.dataset.theme = s.theme;
    document.documentElement.style.setProperty('--answer-font-size', `${s.appearance.fontSize}px`);
    languageControls.setUiLanguage(s.uiLanguage);
    if (actionChanged) action = s.defaultAction;
    if (readingChanged) renderSettings();
    else for (const option of $<HTMLSelectElement>('mode').options) { const mode = s.modes.find(m => m.id === option.value); if (mode) option.textContent = localizedModeField(mode, 'name', s.uiLanguage); }
  });
  const pending = await chrome.storage.session.get('pendingSelection');
  if (!inSidePanel && typeof pending.pendingSelection === 'string') { $<HTMLTextAreaElement>('text').value = pending.pendingSelection; await chrome.storage.session.remove('pendingSelection'); }
  $('settings').onclick = () => void chrome.runtime.openOptionsPage();
  $('search-page').onclick = async () => {
    try { await rpc('openSearch'); if (!inSidePanel) window.close(); }
    catch (error) { $('status').textContent = (error as Error).message; $('status').classList.add('error'); }
  };
  function run(fresh = false) {
    if (busy) { invalidate(); $('status').textContent = '已停止'; return; }
    const text = $<HTMLTextAreaElement>('text').value.trim(); if (!text) { $('text').focus(); return; }
    cancel?.(); const current = ++epoch; result = ''; busy = true; $('submit').textContent = '停止生成'; $('answer').textContent = ''; $('answer').hidden = true;
    document.querySelector<HTMLElement>('.popup-result-actions')!.hidden = true;
    $('status').textContent = '正在理解这段内容…'; $('status').classList.remove('error');
    const submitLabel = action === 'explain' ? '解释 ↗' : action === 'learn' ? '同语学习 ↗' : action === 'dictionary' ? '查词 ↗' : '翻译 ↗';
    cancel = explain({ text, context: '', modeId: $<HTMLSelectElement>('mode').value, fresh, action, translation: languageControls.value }, event => {
      if (current !== epoch) return;
      if (event.type === 'start') $('model-label').textContent = event.model;
      if (event.type === 'chunk') { result += event.text; $('answer').textContent = result; $('answer').hidden = false; }
      if (event.type === 'error' || event.type === 'done') {
        busy = false; $('submit').textContent = submitLabel; $('status').textContent = event.type === 'error' ? event.error : event.truncated ? '已达到输出上限。可以缩短选中文字后重试。' : action === 'dictionary' ? '词条由 Free Dictionary API 提供' : action === 'translate' && languageControls.value.engine === 'mymemory' ? '译文来自 MyMemory' : '';
        $('status').classList.toggle('error', event.type === 'error'); document.querySelector<HTMLElement>('.popup-result-actions')!.hidden = !result && event.type !== 'error';
      }
    });
  }
  $('explain-form').onsubmit = e => { e.preventDefault(); run(); };
  $('retry').onclick = () => run(true);
  $('text').oninput = invalidate; $('mode').onchange = invalidate;
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText(result); $('copy').textContent = '已复制'; } catch { $('status').textContent = '请选中正文后复制。'; } };
  if (inSidePanel) {
    $('site-toggle').hidden = true; $('search-page').hidden = true;
    let tabId: number | undefined, selectionId = '', sourceUrl = '', loadVersion = 0;
    const seen = new Set<string>();
    $('open-pdf').textContent = '全文检索与原文高亮 → 释义阅读器';
    $('open-pdf').hidden = true;
    $('open-pdf').onclick = async () => { try { await rpc('openPdf', { url: sourceUrl, sameTabId: tabId }); } catch (e) { $('status').textContent = (e as Error).message; } };
    const loadSelection = async () => {
      const version = ++loadVersion;
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (version !== loadVersion) return;
      const nextTab = active?.id, changedTab = nextTab !== tabId; tabId = nextTab;
      const key = `panelSelection:${tabId}`;
      const selection = (await chrome.storage.session.get(key))[key] as { id: string; text: string; sourceUrl: string; nativePdf: boolean } | undefined;
      if (version !== loadVersion) return;
      if (changedTab || !selection) { invalidate(); selectionId = ''; sourceUrl = ''; $('open-pdf').hidden = true; $<HTMLTextAreaElement>('text').value = ''; }
      if (!selection || selection.id === selectionId) return;
      action = s.defaultAction; languageControls.set(s.translation); updateAction(); selectionId = selection.id; sourceUrl = selection.sourceUrl || '';
      $<HTMLTextAreaElement>('text').value = selection.text;
      $('open-pdf').hidden = !selection.nativePdf;
      if (!seen.has(selectionId)) { seen.add(selectionId); if (seen.size > 50) seen.delete(seen.values().next().value!); run(); }
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && Object.keys(changes).some(k => k.startsWith('panelSelection:'))) void loadSelection();
    });
    chrome.tabs.onActivated.addListener(() => { void loadSelection(); });
    await loadSelection();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pdfUrl = tab?.url && /^(https?|file):/i.test(tab.url) && /\.pdf(?:$|[?#])/i.test(tab.url) ? tab.url : '';
  if (pdfUrl) $('open-pdf').textContent = '在释义中打开当前 PDF ↗';
  $('open-pdf').onclick = async () => { try { await rpc('openPdf', { url: pdfUrl }); window.close(); } catch (e) { $('status').textContent = (e as Error).message; } };
  if (tab?.url && /^https?:/.test(tab.url)) {
    const hostname = new URL(tab.url).hostname; const toggle = $('site-toggle'); toggle.hidden = false;
    let disabled = s.disabledSites.includes(hostname);
    const label = () => toggle.textContent = `${disabled ? '开启' : '暂停'} ${hostname} 的划词按钮`;
    label(); toggle.onclick = async () => {
      try { const latest = await rpc<Settings>('getSettings'); disabled = !latest.disabledSites.includes(hostname); latest.disabledSites = latest.disabledSites.filter(h => h !== hostname); if (disabled) latest.disabledSites.push(hostname); await rpc('saveSettings', { value: latest }); label(); }
      catch (e) { $('status').textContent = (e as Error).message; }
    };
  }
}
main().catch(e => { $('status').textContent = (e as Error).message; });
window.addEventListener('pagehide', () => cancel?.());
