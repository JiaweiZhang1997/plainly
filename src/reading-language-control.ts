import { LANGUAGES, normalizeLanguageSettings, followSystemLabel, type LanguageSettings, type ReadAction } from './language.ts';

/** A single language choice for the reading header; advanced controls live in Settings. */
export class ReadingLanguageControl {
  value: LanguageSettings;
  private action: ReadAction = 'explain';
  private uiLanguage: 'zh-CN' | 'en' = 'zh-CN';
  constructor(private host: HTMLSelectElement, value: LanguageSettings, onChange: () => void) {
    this.value = normalizeLanguageSettings(value);
    host.classList.add('language-choice');
    host.onchange = () => {
      if (this.action === 'translate') this.value.target = host.value;
      else if (this.action === 'learn') this.value.learningLanguage = host.value;
      else return;
      onChange();
    };
    this.render();
  }
  setUiLanguage(language: 'zh-CN' | 'en') { this.uiLanguage = language; this.render(); }
  set(value: LanguageSettings) { this.value = normalizeLanguageSettings(value); this.render(); }
  show(action: ReadAction) { this.action = action; this.render(); }
  private render() {
    const learning = this.action === 'learn';
    this.host.hidden = this.action !== 'translate' && !learning;
    this.host.classList.toggle('target-language', this.action === 'translate');
    this.host.classList.toggle('learning-language', learning);
    const label = learning ? '学习输出语言' : '目标语言';
    this.host.setAttribute('aria-label', label); this.host.title = label;
    this.host.replaceChildren(...(learning ? [new Option('跟随原文', 'auto')] : []), new Option(followSystemLabel(this.uiLanguage), 'system'), ...LANGUAGES.map(([id, name]) => new Option(name, id)));
    this.host.value = learning ? this.value.learningLanguage : this.value.target;
  }
}
