import { UI_EN } from './ui-strings.ts';
export type UiLanguage = 'zh-CN' | 'en';
const patterns: [RegExp, (...parts: string[]) => string][] = [
  [/^(正在按含义查找…|正在分段搜索长网页…|正在整理相关片段…) (\d+)\/(\d+)$/, (stage, done, total) => `${uiText(stage, 'en')} ${done}/${total}`],
  [/^([\s\S]+)\n本次搜索未完成，请重试。$/, error => `${uiText(error, 'en')}\nSearch did not finish. Try again.`],
  [/^页面很长，仅搜索已扫描正文中的前 (\d+) 个片段，后续内容未覆盖。$/, n => `Long page: only the first ${n} scanned passages were searched. Later content is not covered.`],
  [/^仅搜索前 (\d+) \/ (\d+) 个正文片段，后续内容未覆盖。$/, (n, total) => `Only the first ${n} of ${total} passages were searched. Later content is not covered.`],
  [/^正在读取 PDF 文字… (\d+) \/ (\d+) 页$/, (n, total) => `Reading PDF text… ${n} / ${total} pages`],
  [/^正在显示第 (\d+) 页…$/, n => `Displaying page ${n}…`],
  [/^搜索范围：(\d+) \/ (\d+) 页 · (\d+) 个片段(。已达到本次文字上限，最后一页仅覆盖部分，后续未搜索。|。仅扫描前 200 页，后续未搜索。|。无文字层的页面无法搜索。)$/, (n, total, passages, suffix) => `Search scope: ${n} / ${total} pages · ${passages} passages. ${suffix.startsWith('。已达到') ? 'Text limit reached; the last page is only partially covered and later pages were not searched.' : suffix.startsWith('。仅扫描') ? 'Only the first 200 pages were scanned; later pages were not searched.' : 'Pages without a text layer cannot be searched.'}`],
  [/^(Jev|免费语言服务) 暂时不可用（HTTP (\d+)），请稍后重试。$/, (service, code) => `${service === 'Jev' ? service : 'The free language service'} is unavailable (HTTP ${code}). Try again later.`],
  [/^下载失败（HTTP (\d+)）。可以切回原生阅读器继续阅读。$/, code => `Download failed (HTTP ${code}). You can continue in the native viewer.`],
  [/^(.+)不能为空，最多 (\d+) 字符。$/, (field, max) => `${uiText(field, 'en')} cannot be empty and must be no more than ${max} characters.`],
  [/^无法加载设置：([\s\S]+)$/, error => `Cannot load settings: ${uiText(error, 'en')}`],
  [/^无法读取用量：([\s\S]+)$/, error => `Cannot read usage: ${uiText(error, 'en')}`],
  [/^跟随系统语言 · (.+)$/, value => `Follow interface · ${UI_EN[value] || value}`],
  [/^自 (.+) 起 · (\d+) 次未返回用量 · (\d+) 次仅有部分用量。数字仅累加接口已报告的 token。$/, (date,missing,partial) => `Since ${date} · ${missing} unreported · ${partial} partial. Only API-reported tokens are counted.`],
  [/^(\d+) 完整 \/ (\d+) 部分 \/ (\d+) 未提供$/, (a,b,c) => `${a} complete / ${b} partial / ${c} unreported`],
  [/^删除“(.+)”？保存后生效。$/, name => `Delete “${name}”? Applies after saving.`],
  [/^第 (\d+) \/ (\d+) 页$/, (a,b) => `Page ${a} / ${b}`],
  [/^正在分析 (.+)$/, detail => `Analyzing ${detail}`],

  [/^版本 (.+)$/, v => `Version ${v}`], [/^恢复 (\d+) px$/, n => `Reset to ${n} px`],
  [/^选择上传图标 (\d+)$/, n => `Choose uploaded icon ${n}`], [/^删除上传图标 (\d+)$/, n => `Delete uploaded icon ${n}`], [/^上传图标 (\d+)$/, n => `Uploaded icon ${n}`],
  [/^正文 (\d+) px · 宽 (\d+) px · 高度最多 (\d+) px$/, (f,w,h) => `Text ${f} px · Width ${w} px · Max height ${h} px`],
  [/^(\d+) × (\d+) px · 预览比例 (\d+)%$/, (w,h,s) => `${w} × ${h} px · Preview ${s}%`],
  [/^([\d.]+) 秒$/, n => `${n} s`], [/^连接成功 · (.+) 秒$/, n => `Connected · ${n} s`],
  [/^连接成功 · (.+)$/, n => `Connected · ${n}`], [/^已停止 · (.+)$/, n => `Stopped · ${n}`],
  [/^([↑↓]) 第 (\d+) 页$/, (arrow,n) => `${arrow} Page ${n}`],
  [/^(\d+) 处线索$/, n => `${n} matches`], [/^搜索范围：当前已加载正文 · (\d+) 个片段$/, n => `Search scope: loaded text · ${n} passages`],
  [/^([\s\S]+) · 默认$/, n => `${n} · Default`],
  [/^可用变量：(.+)。保存时保留这些变量，使用时自动填入当前选项。$/, n => `Variables: ${n}. Keep these placeholders to insert your current preferences.`],
  [/^(开启|暂停) (.+) 的划词按钮$/, (a,host) => `${a === '开启' ? 'Enable' : 'Pause'} selection button on ${host}`],
];
export function uiText(text: string, language: UiLanguage): string {
  if (language !== 'en') return text;
  const source = text.trim(); let translated = UI_EN[source];
  if (translated === undefined) for (const [pattern, render] of patterns) { const match = source.match(pattern); if (match) { translated = render(...match.slice(1)); break; } }
  return translated === undefined ? text : text.replace(source, translated);
}
// Only extension-owned UI is localized. Never translate document text, model responses,
// prompts, user-entered names, API configuration values, or search excerpts.
const protectedContent = 'script,style,[data-i18n-skip],.answer,#answer,.term,.context pre,#pdf-text,.model,#model-label';
export class UiLocalizer {
  private language: UiLanguage = 'zh-CN';
  private originals = new WeakMap<Node, Map<string, { source: string; rendered: string }>>();
  private observer: MutationObserver;
  private root: Document | ShadowRoot;
  constructor(root: Document | ShadowRoot) {
    this.root = root;
    this.observer = new MutationObserver(records => {
      this.observer.disconnect();
      for (const record of records) {
        if (record.type === 'childList') record.addedNodes.forEach(node => this.translate(node));
        else if (record.type === 'attributes') this.translateAttribute(record.target as Element, record.attributeName!);
        else this.translate(record.target);
      }
      this.observe();
    });
    this.observe();
  }
  destroy() { this.observer.disconnect(); }
  private observe() { this.observer.observe(this.root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder', 'data-tooltip'] }); }
  setLanguage(language: UiLanguage) {
    this.language = language === 'en' ? 'en' : 'zh-CN';
    this.observer.disconnect(); this.translate(this.root);
    if (this.root instanceof Document) this.root.documentElement.lang = this.language;
    else (this.root.host as HTMLElement).lang = this.language;
    this.observe();
  }
  private localized(node: Node, key: string, value: string) {
    let entries = this.originals.get(node); if (!entries) { entries = new Map(); this.originals.set(node, entries); }
    const previous = entries.get(key);
    const source = previous && previous.rendered === value ? previous.source : value;
    const rendered = uiText(source, this.language); entries.set(key, { source, rendered }); return rendered;
  }
  private translateAttribute(el: Element, attr: string) {
    if (el.closest(protectedContent)) return;
    const value = el.getAttribute(attr); if (value === null) return;
    const translated = this.localized(el, attr, value); if (translated !== value) el.setAttribute(attr, translated);
  }
  private translate(node: Node) {
    const el = node instanceof Element ? node : node.parentElement;
    if (el?.closest(protectedContent)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      // Textarea contents are user data, but its placeholder and accessible name are UI.
      if (el?.closest('textarea')) return;
      const value = node.nodeValue || '', translated = this.localized(node, 'text', value);
      if (value !== translated) {
        // An option without an explicit value uses its label as its value.
        if (el instanceof HTMLOptionElement && !el.hasAttribute('value')) el.value = el.textContent || '';
        node.nodeValue = translated;
      }
      return;
    }
    if (node instanceof Element) for (const attr of ['title', 'aria-label', 'placeholder', 'data-tooltip']) this.translateAttribute(node, attr);
    if (node instanceof HTMLTextAreaElement) return;
    node.childNodes.forEach(child => this.translate(child));
  }
}
