import { UiLocalizer, uiText } from './ui-language.ts';
import css from './card.css';
import questionMark from '../public/question-mark.svg';
import { explain, rpc } from './client.ts';
import { localizedModeField, place, placeTrigger, type PublicSettings, type Turn } from './core.ts';
import { ACTIONS, orderedActions, type ReadAction } from './language.ts';
import { ReadingLanguageControl } from './reading-language-control.ts';
const ICONS = {
  drag: '<path d="M6 3h.01M10 3h.01M6 8h.01M10 8h.01M6 13h.01M10 13h.01" stroke-width="3"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>', lock: '<rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2M8 10v1"/>', unlock: '<rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 5.7-1.3M8 10v1"/>',
  copy: '<rect x="5" y="5" width="8" height="9" rx="2"/><path d="M10 3V2H2v9h1"/>',
  settings: '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="2" fill="var(--paper)"/><circle cx="10" cy="11" r="2" fill="var(--paper)"/>'
};
const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
export class ExplainCard {
  host = document.createElement('plainly-reader');
  root = this.host.attachShadow({ mode: 'open' });
  private ui = new UiLocalizer(this.root);
  pinned = false; showing = false; triggerVisible = false;
  private dragged = false;
  private lockChoice?: boolean;
  private drag?: { id: number; x: number; y: number; left: number; top: number; moved: boolean };
  get positionLocked() { return this.pinned || this.dragged; }
  get keepOnOutside() { return this.pinned; }
  private cancel?: () => void;
  private answer = ''; private text = ''; private context = ''; private history: Turn[] = [];
  private busy = false; private expanded = false; private generation = 0;
  private anchor = { left: 20, right: 20, top: 30, bottom: 50 };
  private selection = { text: '', context: '', rect: { ...this.anchor } };
  private pendingQuestion = ''; private observer: ResizeObserver;
  private action: ReadAction = 'explain';
  private languageControls: ReadingLanguageControl;
  private shell: HTMLDivElement; private panel: HTMLDivElement;
  constructor(public settings: PublicSettings) {
    this.host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:2147483647!important;width:max-content!important;height:max-content!important;color-scheme:normal!important;';
    this.host.setAttribute('popover', 'manual');
    this.root.innerHTML = `<style>${css}</style><div class="shell"><button class="trigger" title="打开释义" aria-label="打开释义" hidden>${questionMark}</button><div class="card" role="dialog" aria-label="释义" hidden><div class="head"><span class="mark">${questionMark}</span><select class="mode" aria-label="解释模式"></select><span class="spacer"></span><button class="icon pin" title="锁定提示框" aria-label="锁定提示框" aria-pressed="false">${icon('unlock')}</button><button class="icon close" title="关闭 · Esc" aria-label="关闭释义">${icon('close')}</button></div><div class="scroll"><div class="term"></div><details class="context"><summary>已结合上下文</summary><pre></pre></details><div class="loading" aria-label="正在处理选中文字"><span></span><span></span><span></span></div><div class="answer"></div><div class="status" role="status" aria-live="polite"></div><div class="retryrow" hidden><button class="chip retry">重试</button><button class="chip setup">模型设置 ↗</button></div><div class="actions"><button class="chip example">举个例子</button><button class="chip simpler">再讲简单点</button><button class="chip expand">展开 ↗</button></div><form class="follow" hidden><input aria-label="追问" placeholder="还有哪里不明白？" maxlength="1000"><button type="submit" title="发送追问" aria-label="发送追问">↑</button></form></div><div class="foot"><span>PLAINLY</span><span class="spacer"></span><span class="toast"></span><span class="model"></span><button class="icon copy" title="复制结果" aria-label="复制结果">${icon('copy')}</button><button class="icon settings" title="打开设置" aria-label="打开设置">${icon('settings')}</button></div></div></div>`;
    this.shell = this.$('.shell'); this.panel = this.$('.card');
    this.initDragging();
    const tabs = document.createElement('div'); tabs.className = 'reading-actions'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '阅读功能');
    for (const action of ACTIONS) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action.id; button.textContent = action.name;
      button.onclick = () => { this.action = action.id; this.history = []; this.updateAction(); this.run(); }; tabs.append(button);
    }
    this.$('.head').after(tabs);
    const controls = document.createElement('select'); this.$('.mode').after(controls);
    this.languageControls = new ReadingLanguageControl(controls, settings.translation, () => { this.history = []; this.run(); });
    const stop = document.createElement('button'); stop.className = 'chip stop'; stop.textContent = '停止'; stop.hidden = true;
    stop.onclick = () => { this.cancel?.(); this.generation++; this.busy = false; this.$('.loading').hidden = true; this.$('.answer').classList.remove('streaming'); this.$('.status').textContent = '已停止，可重新尝试。'; this.$('.retryrow').hidden = false; stop.hidden = true; this.toggleBusy(false); };
    this.$('.status').after(stop);
    this.updateSettings(settings);
    this.$('.trigger').addEventListener('pointerdown', e => e.preventDefault());
    this.$('.trigger').addEventListener('click', () => this.open());
    this.$('.close').addEventListener('click', () => this.close());
    this.$('.pin').addEventListener('click', () => { this.lockChoice = !this.pinned; this.setLocked(this.lockChoice); });
    this.$('.mode').addEventListener('change', () => { this.history = []; this.run(); });
    this.$('.settings').addEventListener('click', () => void rpc('openSettings', this.action === 'translate' || this.action === 'learn' || this.action === 'dictionary' ? { page: 'languages' } : {}));
    this.$('.setup').addEventListener('click', () => void rpc('openSettings'));
    this.$('.retry').addEventListener('click', () => this.run(this.pendingQuestion, true));
    this.$('.example').addEventListener('click', () => this.follow(this.settings.prompts.followExample));
    this.$('.simpler').addEventListener('click', () => this.follow(this.settings.prompts.followSimpler));
    this.$('.expand').addEventListener('click', () => { this.expanded = !this.expanded; this.panel.classList.toggle('expanded', this.expanded); this.$('.follow').hidden = !this.expanded; this.$('.expand').textContent = this.expanded ? '收起 ↙' : '展开 ↗'; this.reposition(); if (this.expanded) this.$<HTMLInputElement>('.follow input').focus(); });
    this.$('.follow').addEventListener('submit', e => { e.preventDefault(); const input = this.$<HTMLInputElement>('.follow input'); if (input.value.trim() && !this.busy) { this.follow(input.value.trim()); input.value = ''; } });
    this.$('.copy').addEventListener('click', async () => { if (!this.answer) return; try { await navigator.clipboard.writeText(this.answer); this.$('.toast').textContent = '已复制'; setTimeout(() => this.$('.toast').textContent = '', 1600); } catch { this.$('.toast').textContent = '请选择正文复制'; } });
    this.observer = new ResizeObserver(() => this.reposition()); this.observer.observe(this.shell);
  }
  private $<T extends HTMLElement = HTMLElement>(s: string): T { return this.root.querySelector(s)! as T; }
  private initDragging() {
    const head = this.$('.head'); head.title = '拖动标题栏移动提示框';
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'icon drag-handle';
    handle.title = '按住六点手柄拖动，或用方向键微调'; handle.dataset.tooltip = '按住拖动 · 方向键微调'; handle.setAttribute('aria-label', '移动提示框，支持拖动或方向键'); handle.innerHTML = icon('drag');
    head.querySelector('.pin')!.before(handle);
    head.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0 || !this.showing) return;
      const target = e.target as Element;
      if (target.closest('button,select,input,a') && !target.closest('.drag-handle')) return;
      e.preventDefault();
      const rect = this.host.getBoundingClientRect();
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', e => {
      const drag = this.drag; if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; this.markMoved(); head.classList.add('dragging');
      this.setPosition(drag.left + dx, drag.top + dy);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) head.addEventListener(event, () => this.endDrag());
    handle.addEventListener('keydown', e => {
      const step = e.shiftKey ? 30 : 10;
      const movement: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (!movement[e.key]) return;
      e.preventDefault(); this.markMoved();
      const rect = this.host.getBoundingClientRect(), [dx, dy] = movement[e.key]; this.setPosition(rect.left + dx, rect.top + dy);
    });
  }
  private setLocked(locked: boolean) {
    this.pinned = locked;
    const button = this.$('.pin');
    button.setAttribute('aria-pressed', String(locked));
    button.innerHTML = icon(locked ? 'lock' : 'unlock');
    const label = locked ? '已锁定 · 点击空白保留，点击此处解锁' : '未锁定 · 点击空白关闭，点击此处锁定';
    button.title = label; button.setAttribute('aria-label', label); button.dataset.tooltip = label;
  }
  private markMoved() {
    // Preference initializes the current lock state; an explicit toggle wins until closed.
    if (!this.dragged && this.lockChoice === undefined) this.setLocked(!this.settings.closeAfterDrag);
    this.dragged = true;
  }
  private endDrag() {
    const drag = this.drag; this.drag = undefined;
    const head = this.$('.head'); head.classList.remove('dragging');
    if (drag && head.hasPointerCapture(drag.id)) head.releasePointerCapture(drag.id);
  }
  private setPosition(left: number, top: number) {
    const bounds = this.shell.getBoundingClientRect();
    left = Math.max(12, Math.min(left, innerWidth - bounds.width - 12));
    top = Math.max(12, Math.min(top, innerHeight - bounds.height - 12));
    this.host.style.setProperty('left', `${left}px`, 'important'); this.host.style.setProperty('top', `${top}px`, 'important');
  }
  private mount() {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    try { if (!this.host.matches(':popover-open')) this.host.showPopover(); } catch {}
  }
  updateSettings(s: PublicSettings) {
    const previous = this.$<HTMLSelectElement>('.mode').value;
    this.ui.setLanguage(s.uiLanguage);
    this.settings = s; this.shell.dataset.theme = s.theme;
    this.shell.style.setProperty('--answer-font-size', `${s.appearance.fontSize}px`);
    this.shell.style.setProperty('--card-width', `${s.appearance.cardWidth}px`);
    this.shell.style.setProperty('--card-expanded-width', `${s.appearance.cardWidth + 90}px`);
    this.shell.style.setProperty('--card-max-height', `${s.appearance.cardMaxHeight}px`);
    this.shell.style.setProperty('--trigger-size', `${s.triggerSize}px`);
    this.languageControls.setUiLanguage(s.uiLanguage); this.languageControls.set(s.translation);
    const trigger = this.$('.trigger'); trigger.replaceChildren(); trigger.classList.toggle('custom-icon', !!s.triggerIcon);
    if (s.triggerIcon) {
      const img = document.createElement('img'); img.src = s.triggerIcon; img.alt = ''; img.draggable = false;
      img.onerror = () => { trigger.innerHTML = questionMark; trigger.classList.remove('custom-icon'); };
      trigger.append(img);
    } else trigger.innerHTML = questionMark;
    const select = this.$<HTMLSelectElement>('.mode'); select.replaceChildren(...s.modes.map(m => { const o = new Option(localizedModeField(m, 'name', s.uiLanguage), m.id); o.dataset.i18nSkip = ''; return o; }));
    select.value = this.showing && s.modes.some(m => m.id === previous) ? previous : s.defaultMode;
    this.$('.model').textContent = s.configured ? s.modelLabel : uiText('尚未连接模型', s.uiLanguage);
    if (!s.enabledActions.includes(this.action)) this.action = s.defaultAction;
    this.updateAction();
  }
  setSelection(text: string, context: string, rect: { left: number; right: number; top: number; bottom: number }) {
    // Pending selections must not alter the open card's follow-ups or mode changes.
    this.selection = { text, context, rect };
  }
  showTrigger() { this.mount(); this.triggerVisible = true; this.$('.trigger').hidden = false; this.reposition(); }
  hideTrigger() { this.triggerVisible = false; this.$('.trigger').hidden = true; if (!this.showing) this.unmount(); }
  private unmount() { try { this.host.hidePopover(); } catch {} this.host.remove(); }
  open() {
    const retainPosition = this.showing && this.positionLocked;
    this.endDrag(); if (!retainPosition) { this.dragged = false; this.lockChoice = undefined; this.pinned = false; }
    this.text = this.selection.text; this.context = this.selection.context; this.anchor = this.selection.rect;
    this.cancel?.(); this.history = []; this.showing = true; this.triggerVisible = false;
    this.shell.classList.add('has-card');
    this.setLocked(this.pinned); this.$('.trigger').hidden = true; this.panel.hidden = false;
    this.$<HTMLSelectElement>('.mode').value = this.settings.defaultMode;
    this.action = this.settings.defaultAction; this.languageControls.set(this.settings.translation); this.updateAction();
    this.$('.term').textContent = this.text.length > 90 ? this.text.slice(0, 90) + '…' : this.text;
    this.$('.term').title = this.text;
    this.$('.context summary').textContent = this.settings.context && this.context ? '已结合上下文 · 查看发送内容' : '仅解释选中文字 · 查看发送内容';
    this.$('.context pre').textContent = `${uiText('选中文字：', this.settings.uiLanguage)}\n${this.text}${this.settings.context && this.context ? '\n\n' + uiText('附近上下文：', this.settings.uiLanguage) + '\n' + this.context : ''}`;
    this.$<HTMLDetailsElement>('.context').open = false;
    this.mount(); this.run(); this.reposition();
  }
  private follow(question: string) {
    if (this.busy || !this.answer) return;
    this.history.push({ role: 'assistant', content: this.answer });
    this.run(question);
  }
  private updateAction() {
    for (const a of orderedActions(this.settings.enabledActions, this.settings.defaultAction)) this.$('.reading-actions').append(this.$(`[data-action=${a.id}]`));
    this.languageControls.show(this.action);
    this.root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(b => { b.hidden = !this.settings.enabledActions.includes(b.dataset.action as ReadAction); b.setAttribute('aria-pressed', String(b.dataset.action === this.action)); });
    this.$('.reading-actions').hidden = this.settings.enabledActions.length < 2;
    this.$('.mode').hidden = this.action !== 'explain';
    this.$('.actions').hidden = this.action !== 'explain'; this.$('.follow').hidden = this.action !== 'explain' || !this.expanded;
  }
  private run(question = '', fresh = false) {
    this.cancel?.(); const epoch = ++this.generation;
    this.pendingQuestion = question; this.answer = ''; this.busy = true;
    this.$('.answer').textContent = ''; this.$('.answer').classList.add('streaming');
    this.$('.loading').hidden = false; this.$('.status').textContent = question ? '正在补充解释…' : '正在理解这段内容…';
    this.$('.status').classList.remove('error'); this.$('.retryrow').hidden = true; this.toggleBusy(true);
    this.$('.scroll').scrollTop = 0;
    const free = this.action === 'dictionary' || this.action === 'translate' && this.languageControls.value.engine === 'mymemory';
    this.$('.stop').hidden = false;
    if (this.action === 'dictionary') this.$('.status').textContent = '正在查询免费词典，可随时停止…';
    else if (this.action === 'translate') this.$('.status').textContent = '正在翻译…';
    else if (this.action === 'learn') this.$('.status').textContent = '正在整理学习说明…';
    this.$('.context summary').textContent = free ? '仅发送选中文字 · 查看' : this.settings.context && this.context ? '已结合上下文 · 查看发送内容' : '仅使用选中文字 · 查看';
    this.$('.context pre').textContent = `${uiText('选中文字：', this.settings.uiLanguage)}\n${this.text}${!free && this.settings.context && this.context ? '\n\n' + uiText('附近上下文：', this.settings.uiLanguage) + '\n' + this.context : ''}`;
    this.cancel = explain({ text: this.text, context: this.settings.context ? this.context : '', modeId: this.$<HTMLSelectElement>('.mode').value, history: this.history, question, fresh, action: this.action, translation: this.languageControls.value }, event => {
      if (epoch !== this.generation) return;
      if (event.type === 'start') this.$('.model').textContent = event.model;
      if (event.type === 'chunk') { this.$('.loading').hidden = true; this.answer += event.text; this.$('.answer').textContent = this.answer; }
      if (event.type === 'error' || event.type === 'done') {
        this.$('.stop').hidden = true;
        this.busy = false; this.$('.loading').hidden = true; this.$('.answer').classList.remove('streaming'); this.toggleBusy(false);
        this.$('.status').classList.toggle('error', event.type === 'error');
        this.$('.status').textContent = event.type === 'error' ? event.error : event.truncated ? '已达到输出上限，请缩短选中文字后重试。' : event.cached ? this.action === 'explain' ? '来自近期解释' : '来自近期结果' : this.action === 'dictionary' ? '词条由 Free Dictionary API 提供' : free ? '译文来自 MyMemory' : '';
        this.$('.retryrow').hidden = event.type !== 'error';
        if (event.type === 'done') { if (question) this.history.push({ role: 'user', content: question }); this.history = this.history.slice(-6); this.formatAnswer(); }
      }
    });
  }
  private formatAnswer() {
    const answer = this.$('.answer'); answer.replaceChildren();
    // Only render plain text and bold; model HTML, links and scripts never execute.
    for (const paragraph of this.answer.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      const parts = paragraph.replace(/^#{1,6}\s+/gm, '').split(/(\*\*[^*]+\*\*)/g);
      for (const part of parts) { if (part.startsWith('**') && part.endsWith('**')) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); p.append(b); } else p.append(document.createTextNode(part)); }
      answer.append(p);
    }
  }
  private toggleBusy(busy: boolean) {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.example,.simpler,.follow button')) button.disabled = busy;
  }
  moveAnchor(rect: { left: number; right: number; top: number; bottom: number }) {
    this.selection.rect = rect;
    if (!this.positionLocked) this.anchor = rect;
    this.reposition();
  }
  reposition() {
    if (!this.host.isConnected) return;
    if (this.triggerVisible) {
      const trigger = this.$('.trigger'), bounds = trigger.getBoundingClientRect();
      const pos = placeTrigger(this.selection.rect, this.settings.triggerCorner, bounds.width, bounds.height, innerWidth, innerHeight);
      if (this.showing) { trigger.style.left = `${pos.left}px`; trigger.style.top = `${pos.top}px`; }
      else {
        trigger.style.removeProperty('left'); trigger.style.removeProperty('top');
        this.host.style.setProperty('left', `${pos.left}px`, 'important'); this.host.style.setProperty('top', `${pos.top}px`, 'important');
        return;
      }
    }
    const bounds = this.shell.getBoundingClientRect();
    const pos = place(this.anchor, bounds.width, bounds.height, window.innerWidth, window.innerHeight);
    // Manually positioned cards stay put as streamed content changes their size.
    if (this.positionLocked && this.showing) { this.setPosition(parseFloat(this.host.style.left) || 12, parseFloat(this.host.style.top) || 12); return; }
    this.host.style.setProperty('left', `${pos.left}px`, 'important'); this.host.style.setProperty('top', `${pos.top}px`, 'important');
  }
  destroy() { this.close(); this.observer.disconnect(); this.ui.destroy(); }
  close() { this.endDrag(); this.dragged = false; this.lockChoice = undefined; this.generation++; this.cancel?.(); this.showing = false; this.pinned = false; this.triggerVisible = false; this.panel.hidden = true; this.$('.trigger').hidden = true; this.shell.classList.remove('has-card'); this.unmount(); }
}
