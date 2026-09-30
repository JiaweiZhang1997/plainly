import { LANGUAGES, LEVELS, followSystemLabel, normalizeLanguageSettings, type LanguageSettings, type ReadAction } from './language.ts';

/** Full language preferences, available only on the settings page. */
export class LanguageControls {
  value: LanguageSettings;
  action: ReadAction = 'explain';
  private uiLanguage: 'zh-CN' | 'en' = 'zh-CN';
  constructor(public host: HTMLElement, value: LanguageSettings, onChange: () => void) {
    this.value = { ...value };
    host.classList.add('language-controls');
    host.innerHTML = `<div class="translation-fields"><div class="language-direction"><select class="source-language" aria-label="原文语言"></select><button class="swap-language" type="button" title="交换两种语言" aria-label="交换两种语言">⇄</button><select class="target-language" aria-label="目标语言"></select></div><div class="engine-row"><select class="translation-engine" aria-label="翻译服务"><option value="llm">当前 LLM</option><option value="mymemory">MyMemory · 免费</option></select><label class="translation-notes"><input type="checkbox" class="notes-enabled"> 学习注释</label></div></div><div class="learning-fields"><label>学习输出语言 <select class="learning-language" aria-label="学习输出语言"></select></label><label>表达难度 <select class="learning-level" aria-label="学习难度"></select></label></div><p class="language-hint"></p>`;
    const select = (selector: string) => host.querySelector<HTMLSelectElement>(selector)!;
    select('.source-language').replaceChildren(new Option('自动识别', 'auto'), ...LANGUAGES.map(([id, name]) => new Option(name, id)));
    select('.target-language').replaceChildren(new Option(followSystemLabel(this.uiLanguage), 'system'), ...LANGUAGES.map(([id, name]) => new Option(name, id)));
    select('.learning-language').replaceChildren(new Option('自动跟随原文', 'auto'), new Option(followSystemLabel(this.uiLanguage), 'system'), ...LANGUAGES.map(([id, name]) => new Option(name, id)));
    select('.learning-level').replaceChildren(...LEVELS.map(id => new Option(`${id} · ${{ A1: '入门', A2: '基础', B1: '中级', B2: '中高级', C1: '高级', C2: '精通' }[id]}`, id)));
    for (const [selector, key] of [['.source-language', 'source'], ['.target-language', 'target'], ['.translation-engine', 'engine'], ['.learning-level', 'level'], ['.learning-language', 'learningLanguage']] as const) select(selector).onchange = () => { (this.value as any)[key] = select(selector).value; this.render(); onChange(); };
    host.querySelector<HTMLInputElement>('.notes-enabled')!.onchange = e => { this.value.notes = (e.target as HTMLInputElement).checked; onChange(); };
    host.querySelector<HTMLButtonElement>('.swap-language')!.onclick = () => { if (this.value.source === 'auto') return; [this.value.source, this.value.target] = [this.value.target === 'system' ? this.uiLanguage : this.value.target, this.value.source]; this.render(); onChange(); };
    this.render();
  }
  setUiLanguage(language: 'zh-CN' | 'en') { this.uiLanguage = language; this.render(); }
  set(value: LanguageSettings) { this.value = normalizeLanguageSettings(value); this.render(); }
  show(action: ReadAction) { this.action = action; this.render(); }
  render() {
    for (const option of this.host.querySelectorAll<HTMLOptionElement>('option[value=system]')) option.textContent = followSystemLabel(this.uiLanguage);
    const h = this.host, free = this.value.engine === 'mymemory';
    h.hidden = this.action === 'explain';
    h.querySelector<HTMLElement>('.translation-fields')!.hidden = this.action !== 'translate';
    h.querySelector<HTMLElement>('.learning-fields')!.hidden = this.action !== 'learn';
    for (const [selector, key] of [['.source-language', 'source'], ['.target-language', 'target'], ['.translation-engine', 'engine'], ['.learning-level', 'level'], ['.learning-language', 'learningLanguage']] as const) h.querySelector<HTMLSelectElement>(selector)!.value = this.value[key];
    h.querySelector<HTMLInputElement>('.notes-enabled')!.checked = this.value.notes;
    h.querySelector<HTMLElement>('.translation-notes')!.hidden = free;
    h.querySelector<HTMLButtonElement>('.swap-language')!.disabled = this.value.source === 'auto';
    h.querySelector<HTMLElement>('.language-hint')!.textContent = this.action === 'dictionary' ? '免费英英词典 · 只发送选中单词到 Free Dictionary API，不需要密钥。' : this.action === 'learn' ? (this.value.learningLanguage === 'auto' ? '先单独识别选中文字的语言，再锁定该语言讲解。首次识别会增加一次短 LLM 请求，计入用量；手动选择语言可跳过。' : this.value.learningLanguage === 'system' ? '学习输出跟随系统语言；改写和讲解都使用当前系统语言。' : '已手动指定学习输出语言；改写和讲解都使用所选语言。') : free ? '仅将选中文字发送至 MyMemory。需指定原文语言，最多 500 字节，有每日免费额度。' : '使用当前 LLM，可结合上下文。选择明确的原文语言后，可用 ⇄ 交换方向。';
  }
}
