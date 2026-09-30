import { UiLocalizer } from './ui-language.ts';
import { rpc, requestPort } from './client.ts';
import type { PublicSettings, SearchGranularity } from './core.ts';
import { collectPassages, locatePassage, clearSearchHighlight, type PageSnapshot, type Passage } from './search-dom.ts';
import type { SearchResult, SearchSegment } from './search-core.ts';
import css from './search.css';
import questionMark from '../public/question-mark.svg';

export interface SearchSnapshot extends Omit<PageSnapshot, 'passages'> { passages: SearchSegment[]; coverage?: string; }
export interface SearchSource {
  collect: (granularity: SearchGranularity, signal: AbortSignal) => Promise<SearchSnapshot>;
  locate: (passage: SearchSegment, url: string, signal: AbortSignal) => DOMRect | Promise<DOMRect>;
  title?: string; privacy?: string; empty?: string;
}
const webpage: SearchSource = {
  collect: collectPassages,
  locate(p, url) { const passage = p as Passage; locatePassage(passage, url); return passage.range.getBoundingClientRect(); }
};
export class SearchPanel {
  host = document.createElement('plainly-search');
  root = this.host.attachShadow({ mode: 'open' });
  private ui = new UiLocalizer(this.root);
  cancel?: () => void;
  extraction?: AbortController;
  navigation?: AbortController;
  epoch = 0;
  selectionEpoch = 0;
  busy = false;
  snapshot?: SearchSnapshot;
  matches: SearchSegment[] = [];
  index = -1;
  initialized = false;
  highlightStyle = document.createElement('style');
  constructor(private source: SearchSource = webpage) {
    this.host.setAttribute('popover', 'manual');
    this.host.style.cssText = 'all:initial;position:fixed;inset:12px 12px auto auto;margin:0;padding:0;border:0;background:transparent;z-index:2147483647;';
    this.highlightStyle.textContent = '::highlight(plainly-search-current){background-color:#efd26b;color:#182719;text-decoration:underline;text-decoration-color:#9b7e26}';
    this.root.innerHTML = `<style>${css}</style><section class="panel" role="dialog" aria-label="释义 · 页内语义搜索"><header><span class="brand">${questionMark}</span><strong>在这一页，找一找。</strong><span class="spacer"></span><button class="icon" id="close" aria-label="关闭搜索">×</button></header><form><input id="query" aria-label="搜索描述" maxlength="400" placeholder="描述你记得的意思，不必记住原词…" autocomplete="off"><div class="controls"><select id="granularity" aria-label="切分方式"><option value="auto">自动 · 段落优先</option><option value="sentence">按句查找</option><option value="paragraph">按段查找</option></select><button class="submit" id="submit" type="submit">找一找 ↗</button></div></form><div class="body"><p class="status" id="status" role="status" aria-live="polite">用自己的话，描述要找的内容。</p><p class="privacy">点击搜索后，将本页已加载的正文片段发送至你配置的 Jev 服务。寻找最相关的几处，不保证找全。</p><button id="settings" class="settings" hidden>连接 Jev，开始搜索 ↗</button><p id="coverage" class="coverage" hidden></p><div class="results" id="results"></div><div class="navigation" id="navigation" hidden><button id="prev" aria-label="上一个结果">↑ 上一个</button><button id="next" aria-label="下一个结果">↓ 下一个</button><span class="spacer"></span><span id="position"></span></div></div><footer><span>PLAINLY · 语义搜索</span><span><kbd>Alt ⇧ F</kbd> 打开 · <kbd>Esc</kbd> 关闭</span></footer></section>`;
    if (source.title) this.root.querySelector('header strong')!.textContent = source.title;
    if (source.privacy) this.root.querySelector('.privacy')!.textContent = source.privacy;
    this.$('close').onclick = () => this.close();
    const compact = document.createElement('button'); compact.id = 'compact'; compact.className = 'icon'; compact.textContent = '−'; compact.setAttribute('aria-label', '收起搜索'); compact.setAttribute('aria-expanded', 'true');
    this.$('close').before(compact);
    compact.onclick = () => this.compact(!this.root.querySelector('.panel')!.classList.contains('compact'));
    this.$('settings').onclick = () => void rpc('openSettings', { page: 'search' });
    this.root.querySelector('form')!.onsubmit = e => { e.preventDefault(); if (this.busy) this.stop(); else void this.run(); };
    this.$('granularity').onchange = () => this.invalidate('切分方式已更改，请重新搜索。');
    this.$('query').oninput = () => { if (this.busy || this.matches.length) this.invalidate('描述已更改，按 Enter 开始新搜索。'); };
    this.$('prev').onclick = () => this.select(this.index < 0 ? 0 : (this.index - 1 + this.matches.length) % this.matches.length);
    this.$('next').onclick = () => this.select((this.index + 1) % this.matches.length);
    document.addEventListener('keydown', e => { if (this.host.isConnected && e.key === 'Escape') { this.close(); e.preventDefault(); } }, true);
    chrome.runtime.onMessage.addListener(msg => { if (msg.type === 'settingsChanged' && this.host.isConnected) { this.invalidate('设置已更新，可以重新搜索。'); this.applySettings(msg.value); } });
    window.addEventListener('pagehide', () => this.close());
  }
  $<T extends HTMLElement = HTMLElement>(id: string) { return this.root.getElementById(id)! as T; }
  status(text: string, error = false) { this.$('status').textContent = text; this.$('status').classList.toggle('error', error); }
  applySettings(prefs: PublicSettings, resetGranularity = true) {
    this.ui.setLanguage(prefs.uiLanguage);
    this.host.dataset.theme = prefs.theme;
    if (resetGranularity) this.$<HTMLSelectElement>('granularity').value = prefs.searchGranularity;
    this.$('settings').hidden = prefs.searchConfigured;
    this.$<HTMLButtonElement>('submit').disabled = !prefs.searchConfigured;
    if (!prefs.searchConfigured) this.status('先在设置的“页内搜索”中连接 Jev。');
  }
  async open() {
    if (!this.host.isConnected) { document.documentElement.append(this.host, this.highlightStyle); this.host.showPopover(); }
    this.host.style.top = '12px'; this.host.style.bottom = 'auto';
    this.compact(false);
    this.$('query').focus();
    const epoch = this.epoch;
    try { const prefs = await rpc<PublicSettings>('publicSettings'); if (this.host.isConnected && epoch === this.epoch) { this.applySettings(prefs, !this.initialized); this.initialized = true; } }
    catch { this.status('插件已更新，请刷新网页后重试。', true); }
  }
  setBusy(value: boolean) { this.busy = value; this.$('submit').textContent = value ? '停止搜索' : '找一找 ↗'; }
  compact(value: boolean) {
    this.root.querySelector('.panel')!.classList.toggle('compact', value);
    this.$('compact').textContent = value ? '+' : '−';
    this.$('compact').setAttribute('aria-label', value ? '展开搜索' : '收起搜索'); this.$('compact').setAttribute('aria-expanded', String(!value));
  }
  stop() { this.epoch++; this.selectionEpoch++; this.navigation?.abort(); this.cancel?.(); this.cancel = undefined; this.extraction?.abort(); this.setBusy(false); this.status('已停止搜索。'); }
  invalidate(message: string) { this.stop(); clearSearchHighlight(); this.matches = []; this.$('results').replaceChildren(); this.$('coverage').hidden = true; this.$('navigation').hidden = true; this.status(message); }
  close() { this.stop(); clearSearchHighlight(); this.host.remove(); this.highlightStyle.remove(); }
  async run() {
    const query = this.$<HTMLInputElement>('query').value.trim();
    if (!query) { this.$('query').focus(); return; }
    this.invalidate('正在提取本页正文…'); const epoch = this.epoch;
    this.setBusy(true); this.extraction = new AbortController();
    try {
      const snapshot = await this.source.collect(this.$<HTMLSelectElement>('granularity').value as SearchGranularity, this.extraction.signal);
      if (epoch !== this.epoch) return;
      this.snapshot = snapshot;
      if (!snapshot.passages.length) throw new Error(this.source.empty || '当前页面没有可搜索的正文。PDF 请使用插件内的 PDF 阅读器打开。');
      this.$('coverage').hidden = false;
      this.$('coverage').textContent = snapshot.coverage || (snapshot.incomplete ? `页面很长，仅搜索已扫描正文中的前 ${snapshot.passages.length} 个片段，后续内容未覆盖。` : snapshot.total > snapshot.passages.length ? `仅搜索前 ${snapshot.passages.length} / ${snapshot.total} 个正文片段，后续内容未覆盖。` : `搜索范围：当前已加载正文 · ${snapshot.passages.length} 个片段`);
      this.cancel = requestPort('search', { query, segments: snapshot.passages.map(({ id, text, heading, context }) => ({ id, text, heading, context })) }, event => {
        if (epoch !== this.epoch) return;
        if (event.type === 'progress') this.status(`${event.stage}${event.total > 1 ? ` ${event.done}/${event.total}` : ''}`);
        if (event.type === 'error') { this.setBusy(false); this.status(`${event.error}\n本次搜索未完成，请重试。`, true); }
        if (event.type === 'done') { this.setBusy(false); this.render(event.result); }
      });
    } catch (error) { if (epoch === this.epoch) { this.setBusy(false); this.status((error as Error).message, true); } }
  }
  render(result: SearchResult) {
    if (!this.snapshot) return;
    const absent = result.verdict === 'absent';
    this.status(absent ? '已搜索范围内未找到明确结果。试试换一种描述。' : result.verdict === 'uncertain' ? '可能相关，但还不确定。点击原文查看。' : '找到相关线索。以下片段可能相关，点击定位。');
    this.matches = absent ? [] : result.matches.slice(0, 3).map(m => this.snapshot!.passages.find(p => p.id === m.id)).filter((p): p is SearchSegment => !!p);
    this.index = -1; this.$('position').textContent = `${this.matches.length} 处线索`;
    this.$('results').replaceChildren(...this.matches.map((p, i) => {
      const b = document.createElement('button'); b.className = 'result'; b.setAttribute('aria-pressed', 'false');
      const meta = document.createElement('small'); meta.append(`${i + 1} · `);
      const heading = document.createElement('span'); heading.textContent = p.heading || '原文片段';
      if (p.heading) heading.dataset.i18nSkip = '';
      meta.append(heading);
      const text = document.createElement('p'); text.dataset.i18nSkip = ''; text.textContent = p.text; b.append(meta, text); b.onclick = () => this.select(i); return b;
    }));
    this.$('navigation').hidden = !this.matches.length;
  }
  async select(index: number) {
    const passage = this.matches[index]; if (!passage || !this.snapshot) return;
    this.navigation?.abort(); this.navigation = new AbortController();
    const epoch = this.epoch, selectionEpoch = ++this.selectionEpoch;
    try { const rect = await this.source.locate(passage, this.snapshot.url, this.navigation.signal); if (selectionEpoch !== this.selectionEpoch || epoch !== this.epoch) return; this.index = index;
      this.$('position').textContent = `${index + 1} / ${this.matches.length}`;
      [...this.$('results').children].forEach((el, i) => { el.classList.toggle('active', i === index); el.setAttribute('aria-pressed', String(i === index)); });
      if (innerWidth < 600) {
        this.compact(true);
        const nearTop = rect.top < 130;
        this.host.style.top = nearTop ? 'auto' : '12px'; this.host.style.bottom = nearTop ? '12px' : 'auto';
      }
    } catch (error) { if (epoch === this.epoch && selectionEpoch === this.selectionEpoch) { clearSearchHighlight(); this.status((error as Error).message, true); } }
  }
}
