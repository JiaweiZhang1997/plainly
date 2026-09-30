import { UiLocalizer, uiText } from './ui-language.ts';
import { APPEARANCE_DEFAULTS, APPEARANCE_LIMITS, appearanceToSlider, appearanceFromSlider, type ReadingAppearance } from './reading-preferences.ts';
import { initUsage, renderUsage } from './usage-view.ts';
import { DEFAULT_PROMPTS, isBuiltinPrompt, resolvePrompts, promptLocale, PROMPT_FIELDS, type PromptKey } from './prompts.ts';
import { DEFAULT_TRIGGER_SIZE, localizedModeField, isBuiltinModePrompt, resolveModePrompt, MODES, PROVIDERS, defaults, type Settings, type Profile, type Mode } from './core.ts';
import { rpc } from './client.ts';
import { prepareTriggerIcon } from './icon-upload.ts';
import readingLogo from '../public/icons/reading-logo.png';
import questionMark from '../public/question-mark.svg';
import { ACTIONS, followSystemLabel, languageName } from './language.ts';
import { LanguageControls } from './language-controls.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const ui = new UiLocalizer(document);
let s: Settings, selectedProfile = '', selectedMode = '', dirty = false, revision = 0, iconRequest = 0;
let notificationTimer: ReturnType<typeof setTimeout>;
function notify(text: string) { $('notification').textContent = text; $('notification').hidden = false; clearTimeout(notificationTimer); notificationTimer = setTimeout(() => $('notification').hidden = true, 3500); }
function changed() { dirty = true; revision++; $('save-status').textContent = '有尚未保存的修改'; $('save').textContent = '保存修改'; ($('save') as HTMLButtonElement).disabled = false; }
function profile() { return s.profiles.find(p => p.id === selectedProfile)!; }
function mode() { return s.modes.find(m => m.id === selectedMode)!; }
function val(id: string, value: string) { ($<HTMLInputElement>(id)).value = value; }
function inputValue(id: string) { return $<HTMLInputElement>(id).value; }
function option(text: string, value: string) { return new Option(text, value); }
function applyTheme() { document.documentElement.dataset.theme = s.theme; ui.setLanguage(s.uiLanguage); }
function renderEnabledActions() {
  $('enabled-actions').replaceChildren(...ACTIONS.map(action => {
    const label = document.createElement('label'); label.className = 'enabled-action';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = action.id; checkbox.checked = s.enabledActions.includes(action.id);
    checkbox.onchange = () => {
      if (!checkbox.checked && s.enabledActions.length === 1) { checkbox.checked = true; notify('请至少保留一项功能。'); return; }
      s.enabledActions = ACTIONS.filter(a => a.id === action.id ? checkbox.checked : s.enabledActions.includes(a.id)).map(a => a.id);
      if (!s.enabledActions.includes(s.defaultAction)) s.defaultAction = s.enabledActions[0];
      changed(); renderEnabledActions();
    };
    label.append(checkbox, document.createTextNode(action.name)); return label;
  }));
  $('default-action').replaceChildren(...ACTIONS.filter(a => s.enabledActions.includes(a.id)).map(a => option(a.name, a.id))); val('default-action', s.defaultAction);
}
function renderIconLibrary() {
  const library = $('icon-presets'); library.replaceChildren();
  // Older versions only saved the selected image. Avoid listing the built-in twice.
  s.triggerIcons = s.triggerIcons.filter(icon => icon !== readingLogo);
  const items = [{ id: 'reset-trigger-icon', name: '问号', data: '' },
    ...(s.showBuiltinIcon && readingLogo ? [{ id: 'preset-trigger-logo', name: '内置头像', data: readingLogo }] : []),
    ...s.triggerIcons.map((data, i) => ({ id: `uploaded-trigger-icon-${i}`, name: `上传图标 ${i + 1}`, data }))];
  for (const item of items) {
    const wrap = document.createElement('div'); wrap.className = 'icon-option';
    const button = document.createElement('button'); button.type = 'button'; button.id = item.id; button.className = 'icon-preset';
    button.title = item.name; button.setAttribute('aria-label', `选择${item.name}`); button.setAttribute('aria-pressed', String(s.triggerIcon === item.data));
    if (item.data) { const img = document.createElement('img'); img.src = item.data; img.alt = ''; button.append(img); }
    else { const mark = document.createElement('span'); mark.className = 'preset-question'; mark.innerHTML = questionMark; button.append(mark); }
    button.onclick = () => { iconRequest++; s.triggerIcon = item.data; changed(); renderTriggerPreview(); $('icon-upload-status').textContent = '已选择图标，保存修改后生效。'; document.getElementById(item.id)?.focus(); };
    wrap.append(button);
    if (item.data) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-icon'; remove.textContent = '×'; remove.title = `删除${item.name}`; remove.setAttribute('aria-label', remove.title);
      remove.onclick = () => {
        iconRequest++;
        if (item.id === 'preset-trigger-logo') s.showBuiltinIcon = false;
        s.triggerIcons = s.triggerIcons.filter(icon => icon !== item.data);
        const selected = s.triggerIcon === item.data; if (selected) s.triggerIcon = '';
        changed(); renderTriggerPreview(); $('reset-trigger-icon').focus();
        $('icon-upload-status').textContent = selected ? '图标已删除，已切回问号；保存修改后生效。' : '图标已删除，保存修改后生效。';
      };
      wrap.append(remove);
    }
    library.append(wrap);
  }
}
function renderTriggerPreview() {
  val('trigger-size', String(s.triggerSize)); $('trigger-size-value').textContent = `${s.triggerSize} px`;
  document.documentElement.style.setProperty('--trigger-size', `${s.triggerSize}px`);
  val('trigger-corner', s.triggerCorner);
  $('trigger-preview').dataset.corner = s.triggerCorner;
  renderIconLibrary();
  for (const target of document.querySelectorAll<HTMLElement>('.trigger-preview-button,.sample-trigger')) {
    target.replaceChildren(); target.classList.toggle('custom-icon', !!s.triggerIcon);
    if (s.triggerIcon) { const img = document.createElement('img'); img.src = s.triggerIcon; img.alt = ''; target.append(img); }
    else target.innerHTML = questionMark;
  }
  const sample = document.querySelector<HTMLElement>('.reading-sample');
  if (sample) sample.dataset.corner = s.triggerCorner;
}
function renderLanguagePolicy() {
  const follow = followSystemLabel(s.uiLanguage);
  const option = $<HTMLSelectElement>('language').querySelector<HTMLOptionElement>('option[value=system]');
  if (option) option.textContent = follow;
  $('explanation-language-policy').textContent = s.language === 'system' ? follow : s.language;
  $('translation-language-policy').textContent = s.translation.target === 'system' ? follow : languageName(s.translation.target);
  $('learning-language-policy').textContent = s.translation.learningLanguage === 'auto' ? '跟随原文' : s.translation.learningLanguage === 'system' ? follow : languageName(s.translation.learningLanguage);
  $<HTMLButtonElement>('follow-system-outputs').disabled = s.language === 'system' && s.translation.target === 'system';
}
function renderAppearance() {
  for (const key of Object.keys(APPEARANCE_DEFAULTS) as (keyof ReadingAppearance)[]) {
    val(`appearance-${key}`, String(appearanceToSlider(key, s.appearance[key])));
    $(`appearance-${key}`).setAttribute('aria-valuetext', `${s.appearance[key]} px`); val(`appearance-${key}-number`, String(s.appearance[key]));
  }
  $('appearance-sample').style.fontSize = `${s.appearance.fontSize}px`;
  $('appearance-summary').textContent = `正文 ${s.appearance.fontSize} px · 宽 ${s.appearance.cardWidth} px · 高度最多 ${s.appearance.cardMaxHeight} px`;
  document.querySelectorAll<HTMLElement>('.preview-card p').forEach(p => { p.style.fontSize = `${s.appearance.fontSize}px`; });
  const card = $('appearance-preview'), viewport = $('preview-viewport');
  const width = s.appearance.cardWidth, height = s.appearance.cardMaxHeight;
  const available = viewport.parentElement!.clientWidth;
  const scale = Math.min(1, (available || width) / width, Math.max(160, innerHeight - 340) / height);
  card.style.width = `${width}px`; card.style.height = `${height}px`; card.style.transform = `scale(${scale})`;
  viewport.style.height = `${height * scale}px`;
  $('preview-dimensions').textContent = `${width} × ${height} px · 预览比例 ${Math.round(scale * 100)}%`;

}
function renderGeneral() {
  document.querySelectorAll<HTMLInputElement>('input[name=trigger]').forEach(el => el.checked = el.value === s.trigger);
  document.querySelector<HTMLElement>('.delay-field')!.hidden = s.trigger !== 'auto';
  val('delay', String(s.autoDelay)); $('delay-value').textContent = `${s.autoDelay / 1000} 秒`;
  $<HTMLInputElement>('context').checked = s.context;
  $<HTMLInputElement>('close-after-drag').checked = s.closeAfterDrag;
  $('default-mode').replaceChildren(...s.modes.map(m => { const o = option(localizedModeField(m, 'name', s.uiLanguage), m.id); o.dataset.i18nSkip = ''; return o; }));
  $<HTMLInputElement>('pdf-auto-open').checked = s.pdfAutoOpen;
  renderAppearance(); val('target-characters', String(s.targetCharacters)); $('target-characters-field').hidden = s.length !== 'custom';
  val('default-mode', s.defaultMode); val('length', s.length); val('language', s.language); val('theme', s.theme); val('ui-language', s.uiLanguage);
  val('disabled-sites', s.disabledSites.join('\n')); applyTheme(); renderTriggerPreview(); renderLanguagePolicy();
}
function item(name: string, description: string, selected: boolean, badge: string, onClick: () => void, localize = false) {
  const b = document.createElement('button'); b.className = `list-item${selected ? ' selected' : ''}`;
  b.setAttribute('aria-pressed', String(selected));
  const title = document.createElement('strong'); const nameText = document.createElement('span'); nameText.textContent = name; if (!localize) nameText.dataset.i18nSkip = ''; title.append(nameText);
  if (badge) { const em = document.createElement('em'); em.textContent = badge; title.append(em); }
  const sub = document.createElement('small'); sub.textContent = description; if (!localize) sub.dataset.i18nSkip = '';
  b.append(title, sub); b.onclick = onClick; return b;
}
function addPreset(id: string) {
  const preset = PROVIDERS.find(p => p.id === id)!;
  const existing = s.profiles.find(p => p.provider === id && p.baseUrl === preset.baseUrl);
  if (existing) { selectedProfile = existing.id; renderProfiles(); return; }
  if (s.profiles.length >= 20) return notify('最多保存 20 套配置。');
  const p: Profile = { ...preset, id: crypto.randomUUID(), provider: preset.id, apiKey: '' };
  s.profiles.push(p); selectedProfile = p.id; changed(); renderProfiles();
}
function renderPresets() {
  const items = PROVIDERS.filter(p => p.model).map(p => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'provider-preset'; b.dataset.preset = p.id;
    const title = document.createElement('strong'); title.textContent = p.name;
    const detail = document.createElement('small'); detail.textContent = p.model;
    b.append(title, detail); b.onclick = () => { addPreset(p.id); $('api-key').focus(); }; return b;
  });
  for (const [id, name, detail] of [['jev', 'Jev · TypeSafe', '语义检索 · jev-latest'], ['openai-decisions', 'OpenAI · Decisions API', '待接入 · 暂不可用']]) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'provider-preset'; b.dataset.preset = id;
    const title = document.createElement('strong'); title.textContent = name; const sub = document.createElement('small'); sub.textContent = detail; b.append(title, sub);
    if (id === 'jev') b.onclick = () => { location.hash = 'search'; $('jev-key').focus(); };
    else { b.disabled = true; b.title = '这个新接口暂未接入，当前可选 Jev 进行语义检索。'; }
    items.push(b);
  }
  $('provider-presets').replaceChildren(...items);
}
function renderProfileList() {
  $('profile-list').replaceChildren(...s.profiles.map(p => item(p.name, p.model || '等待配置模型', p.id === selectedProfile, p.id === s.activeProfile ? '使用中' : '', () => { selectedProfile = p.id; renderProfiles(); })));
}
function renderProfiles() {
  renderProfileList(); const p = profile();
  val('profile-name', p.name); val('provider', p.provider); val('api-key', p.apiKey); val('model', p.model); val('base-url', p.baseUrl); val('protocol', p.protocol);
  $<HTMLInputElement>('api-key').type = 'password'; $('show-key').textContent = '显示';
  $('activate-profile').textContent = p.id === s.activeProfile ? '✓ 当前使用' : '设为当前使用';
  $<HTMLButtonElement>('activate-profile').disabled = p.id === s.activeProfile;
  $<HTMLButtonElement>('delete-profile').disabled = s.profiles.length <= 1;
  $('test-status').textContent = '';
  $<HTMLInputElement>('stream-usage').checked = p.streamUsage !== false;
}

function renderModeList() {
  $('mode-list').replaceChildren(...s.modes.map(m => item(localizedModeField(m, 'name', s.uiLanguage), localizedModeField(m, 'description', s.uiLanguage) || uiText('自定义解释方式', s.uiLanguage), m.id === selectedMode, m.id === s.defaultMode ? '默认' : '', () => { selectedMode = m.id; renderModes(); })));
}
function promptSource(builtin: boolean) { return builtin ? `内置提示词 · ${promptLocale(s) === 'en' ? 'English' : '简体中文'}` : '自定义提示词 · 保留原文'; }
function renderModes() {
  renderModeList(); const m = mode(); val('mode-name', localizedModeField(m, 'name', s.uiLanguage)); val('mode-description', localizedModeField(m, 'description', s.uiLanguage)); val('mode-prompt', resolveModePrompt(m, promptLocale(s)));
  $('mode-prompt-source').textContent = promptSource(isBuiltinModePrompt(m));
  $('restore-mode').hidden = !m.builtin; $('delete-mode').hidden = !!m.builtin;
  $('default-this-mode').textContent = m.id === s.defaultMode ? '✓ 默认模式' : '设为默认'; $<HTMLButtonElement>('default-this-mode').disabled = m.id === s.defaultMode;
}
function route() {
  const name = ['general', 'models', 'prompts', 'search', 'languages', 'usage', 'about'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'general';
  if (name === 'usage') void renderUsage();
  document.querySelectorAll<HTMLElement>('.page').forEach(page => page.hidden = page.id !== `page-${name}`);
  document.querySelectorAll<HTMLElement>('.nav-item').forEach(nav => nav.classList.toggle('active', nav.dataset.page === name));
}
async function main() {
  s = await rpc<Settings>('getSettings'); selectedProfile = s.activeProfile; selectedMode = s.defaultMode;
  $('provider').replaceChildren(...PROVIDERS.map(p => option(p.name, p.id)));
  for (const key of Object.keys(APPEARANCE_DEFAULTS) as (keyof ReadingAppearance)[]) {
    for (const suffix of ['', '-number']) $( `appearance-${key}${suffix}`).oninput = () => {
      const input = $<HTMLInputElement>(`appearance-${key}${suffix}`);
      if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) return;
      s.appearance[key] = suffix ? input.valueAsNumber : appearanceFromSlider(key, input.valueAsNumber); changed(); renderAppearance();
    };
  }
  for (const key of Object.keys(APPEARANCE_DEFAULTS) as (keyof ReadingAppearance)[]) {
    const [min, max] = APPEARANCE_LIMITS[key];
    const number = $<HTMLInputElement>(`appearance-${key}-number`);
    number.min = String(min); number.max = String(max);
    $(`appearance-${key}`).onkeydown = event => {
      const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
      if (!(event.key in steps) && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      s.appearance[key] = event.key === 'Home' ? min : event.key === 'End' ? max : Math.max(min, Math.min(max, s.appearance[key] + steps[event.key]));
      changed(); renderAppearance();
    };
  }
  $('reset-appearance').onclick = () => { s.appearance = { ...APPEARANCE_DEFAULTS }; changed(); renderAppearance(); };
  $('target-characters').oninput = () => { const value = $<HTMLInputElement>('target-characters').valueAsNumber; if (Number.isFinite(value)) { s.targetCharacters = value; changed(); } };
  $('pdf-auto-open').onchange = () => { s.pdfAutoOpen = $<HTMLInputElement>('pdf-auto-open').checked; changed(); };
  $('pdf-file-access').onclick = () => void rpc('openFilePermissions');
  const updateFileAccess = () => { void rpc<{ fileAccess: boolean }>('pdfIntegrationStatus').then(result => { $('pdf-file-access-status').textContent = result.fileAccess ? '本地文件访问已开启' : '本地 PDF 需开启“允许访问文件网址”'; }).catch(error => { $('pdf-file-access-status').textContent = (error as Error).message; }); };
  updateFileAccess(); window.addEventListener('focus', updateFileAccess);
  initUsage();
  renderGeneral(); renderProfiles(); renderModes(); route();
  new ResizeObserver(() => renderAppearance()).observe($('preview-viewport').parentElement!);
  window.addEventListener('resize', renderAppearance);
  renderPresets();
  let selectedPrompt: PromptKey = 'explanation';
  $('function-prompt').replaceChildren(...PROMPT_FIELDS.map(f => option(f.name, f.key)));
  const renderPromptEditor = () => {
    const field = PROMPT_FIELDS.find(f => f.key === selectedPrompt)!;
    val('function-prompt-text', resolvePrompts(s.prompts, promptLocale(s))[selectedPrompt]);
    $('function-prompt-source').textContent = promptSource(isBuiltinPrompt(selectedPrompt, s.prompts[selectedPrompt]));
    val('prompt-language', s.promptLanguage);
    $('prompt-language-summary').textContent = `当前内置提示词版本：${promptLocale(s) === 'en' ? 'English' : '简体中文'}`;
    $<HTMLTextAreaElement>('function-prompt-text').maxLength = selectedPrompt.startsWith('follow') ? 1000 : 16000;
    $('function-prompt-help').textContent = field.help;
    $('function-prompt-variables').textContent = field.variables.length ? `可用变量：${field.variables.map(v => '{{' + v + '}}').join(' · ')}。保存时保留这些变量，使用时自动填入当前选项。` : '可以直接使用自然语言描述你的要求，无需填写变量。';
  };
  $('function-prompt').onchange = () => { selectedPrompt = inputValue('function-prompt') as PromptKey; renderPromptEditor(); };
  $('function-prompt-text').oninput = () => { s.prompts[selectedPrompt] = inputValue('function-prompt-text'); $('function-prompt-source').textContent = promptSource(isBuiltinPrompt(selectedPrompt, s.prompts[selectedPrompt])); changed(); };
  $('restore-function-prompt').onclick = () => { s.prompts[selectedPrompt] = DEFAULT_PROMPTS[selectedPrompt]; changed(); renderPromptEditor(); };
  renderPromptEditor();
  $('prompt-language').onchange = () => { s.promptLanguage = inputValue('prompt-language') as Settings['promptLanguage']; renderPromptEditor(); renderModes(); changed(); };
  renderEnabledActions();
  $('default-action').onchange = () => { s.defaultAction = inputValue('default-action') as Settings['defaultAction']; changed(); };
  const languageControls = new LanguageControls($('language-preferences'), s.translation, () => { s.translation = { ...languageControls.value, level: s.translation.level, learningLanguage: s.translation.learningLanguage }; renderLanguagePolicy(); changed(); });
  languageControls.show('translate');
  const learningControls = new LanguageControls($('learning-preferences'), s.translation, () => { s.translation.level = learningControls.value.level; s.translation.learningLanguage = learningControls.value.learningLanguage; renderLanguagePolicy(); changed(); });
  learningControls.show('learn');
  languageControls.setUiLanguage(s.uiLanguage); learningControls.setUiLanguage(s.uiLanguage);
  $('ui-language').onchange = () => { s.uiLanguage = inputValue('ui-language') as Settings['uiLanguage']; ui.setLanguage(s.uiLanguage); languageControls.setUiLanguage(s.uiLanguage); learningControls.setUiLanguage(s.uiLanguage); renderGeneral(); renderPromptEditor(); renderModes(); void renderUsage(); changed(); };
  $('follow-system-outputs').onclick = () => { s.language = 'system'; s.translation.target = 'system'; val('language', 'system'); languageControls.set(s.translation); renderLanguagePolicy(); changed(); };
  $('close-after-drag').onchange = () => { s.closeAfterDrag = $<HTMLInputElement>('close-after-drag').checked; changed(); };
  $('trigger-size').oninput = () => { s.triggerSize = Number(inputValue('trigger-size')); changed(); renderTriggerPreview(); };
  $('reset-trigger-size').onclick = () => { s.triggerSize = DEFAULT_TRIGGER_SIZE; changed(); renderTriggerPreview(); };
  for (const [id, key] of [['jev-key', 'apiKey'], ['jev-base', 'baseUrl'], ['jev-model', 'model'], ['search-granularity', 'granularity']] as const) {
    val(id, s.jev[key]);
    $(id).oninput = () => { (s.jev as any)[key] = inputValue(id); changed(); $('jev-status').textContent = ''; };
  }
  $('show-jev-key').onclick = () => { const input = $<HTMLInputElement>('jev-key'); input.type = input.type === 'password' ? 'text' : 'password'; $('show-jev-key').textContent = input.type === 'password' ? '显示' : '隐藏'; };
  $('test-jev').onclick = async () => {
    const button = $<HTMLButtonElement>('test-jev'); button.disabled = true;
    const snapshot = JSON.stringify(s.jev); $('jev-status').textContent = '正在测试搜索连接…'; $('jev-status').classList.remove('error');
    try { const result = await rpc<{ ms: number }>('testJev', { jev: structuredClone(s.jev) }); if (snapshot === JSON.stringify(s.jev)) $('jev-status').textContent = `连接成功 · ${(result.ms / 1000).toFixed(1)} 秒`; }
    catch (error) { if (snapshot === JSON.stringify(s.jev)) { $('jev-status').textContent = (error as Error).message; $('jev-status').classList.add('error'); } }
    finally { button.disabled = false; }
  };
  $('trigger-corner').onchange = () => { s.triggerCorner = inputValue('trigger-corner') as Settings['triggerCorner']; changed(); renderTriggerPreview(); };
  $('reset-trigger-size').textContent = `恢复 ${DEFAULT_TRIGGER_SIZE} px`;
  $('upload-trigger-icon').onclick = () => $<HTMLInputElement>('trigger-icon-file').click();
  $('trigger-icon-file').onchange = async () => {
    const file = $<HTMLInputElement>('trigger-icon-file').files?.[0]; if (!file) return;
    const request = ++iconRequest; $('icon-upload-status').textContent = '正在处理图标…';
    try {
      const icon = await prepareTriggerIcon(file); if (request !== iconRequest) return;
      if (!icon) { $('icon-upload-status').textContent = '已取消裁剪，保留原图标。'; return; }
      if (icon !== readingLogo && !s.triggerIcons.includes(icon)) {
        if (s.triggerIcons.length >= 20) throw new Error('最多保存 20 张上传图标，请先删除不需要的图标。');
        s.triggerIcons.push(icon);
      }
      if (icon === readingLogo) s.showBuiltinIcon = true;
      s.triggerIcon = icon; changed(); renderTriggerPreview(); $('icon-upload-status').textContent = '图标已准备好，点击右上角“保存修改”后生效。';
    } catch (error) { if (request === iconRequest) $('icon-upload-status').textContent = (error as Error).message; }
    finally { if (request === iconRequest) $<HTMLInputElement>('trigger-icon-file').value = ''; }
  };
  document.querySelectorAll<HTMLElement>('.nav-item').forEach(nav => nav.onclick = () => { location.hash = nav.dataset.page!; });
  window.addEventListener('hashchange', route);
  document.querySelectorAll<HTMLInputElement>('input[name=trigger]').forEach(el => el.onchange = () => { if (el.checked) { s.trigger = el.value as Settings['trigger']; changed(); renderGeneral(); } });
  $('delay').oninput = () => { s.autoDelay = Number(inputValue('delay')); $('delay-value').textContent = `${s.autoDelay / 1000} 秒`; changed(); };
  $('context').onchange = () => { s.context = $<HTMLInputElement>('context').checked; changed(); };
  for (const [id, key] of [['default-mode','defaultMode'],['length','length'],['language','language'],['theme','theme']] as const) {
    $(id).onchange = () => { (s as any)[key] = inputValue(id); changed(); applyTheme(); renderLanguagePolicy(); if (key === 'defaultMode') renderModes(); if (key === 'length') $('target-characters-field').hidden = s.length !== 'custom'; };
  }
  $('disabled-sites').oninput = () => { s.disabledSites = inputValue('disabled-sites').split('\n').map(x => x.trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase()).filter(Boolean); changed(); };
  $('shortcuts').onclick = () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  for (const [id, key] of [['profile-name','name'],['api-key','apiKey'],['model','model'],['base-url','baseUrl'],['protocol','protocol']] as const) {
    $(id).addEventListener('input', () => { (profile() as any)[key] = inputValue(id); changed(); if (key === 'name' || key === 'model') renderProfileList(); $('test-status').textContent = ''; });
  }
  $('stream-usage').onchange = () => { profile().streamUsage = $<HTMLInputElement>('stream-usage').checked; changed(); };
  $('provider').onchange = () => {
    const preset = PROVIDERS.find(p => p.id === inputValue('provider'))!; const p = profile();
    Object.assign(p, { provider: preset.id, name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, model: preset.model, apiKey: '' });
    changed(); renderProfiles();
  };
  $('show-key').onclick = () => { const input = $<HTMLInputElement>('api-key'); input.type = input.type === 'password' ? 'text' : 'password'; $('show-key').textContent = input.type === 'password' ? '显示' : '隐藏'; };
  $('activate-profile').onclick = () => { s.activeProfile = selectedProfile; changed(); renderProfiles(); };
  $('add-profile').onclick = () => {
    if (s.profiles.length >= 20) return notify('最多保存 20 套配置。');
    const p: Profile = { ...defaults().profiles[0], id: crypto.randomUUID(), name: '新模型配置', apiKey: '' }; s.profiles.push(p); selectedProfile = p.id; changed(); renderProfiles(); $('profile-name').focus();
  };
  $('delete-profile').onclick = () => {
    if (s.profiles.length <= 1 || !confirm(s.uiLanguage === 'en' ? `Delete “${profile().name}” and its local key? Applies after saving.` : `删除“${profile().name}”及其本地密钥？保存后生效。`)) return;
    s.profiles = s.profiles.filter(p => p.id !== selectedProfile); if (s.activeProfile === selectedProfile) s.activeProfile = s.profiles[0].id;
    selectedProfile = s.activeProfile; changed(); renderProfiles();
  };
  $('test-profile').onclick = async () => {
    const button = $<HTMLButtonElement>('test-profile'); button.disabled = true; $('test-status').classList.remove('error'); $('test-status').textContent = '正在连接…';
    const currentId = selectedProfile, snapshot = JSON.stringify(profile());
    try { const result = await rpc<{ ms: number }>('testProfile', { profile: structuredClone(profile()) }); if (currentId === selectedProfile && snapshot === JSON.stringify(profile())) $('test-status').textContent = `连接成功 · ${(result.ms / 1000).toFixed(1)} 秒`; }
    catch (error) { if (currentId === selectedProfile) { $('test-status').textContent = (error as Error).message; $('test-status').classList.add('error'); } }
    finally { button.disabled = false; }
  };
  for (const [id, key] of [['mode-name','name'],['mode-description','description'],['mode-prompt','prompt']] as const) {
    $(id).oninput = () => { mode()[key] = inputValue(id); $('mode-prompt-source').textContent = promptSource(isBuiltinModePrompt(mode())); changed(); if (key !== 'prompt') { renderModeList(); renderGeneral(); } };
  }
  const addMode = (source?: Mode) => {
    if (s.modes.length >= 30) return notify('最多保存 30 个模式。');
    const m: Mode = source ? { ...source, prompt: resolveModePrompt(source, promptLocale(s)), id: crypto.randomUUID(), name: s.uiLanguage === 'en' ? `${localizedModeField(source, 'name', s.uiLanguage)} · Copy` : `${localizedModeField(source, 'name', s.uiLanguage)} · 副本`, builtin: false } : { id: crypto.randomUUID(), name: s.uiLanguage === 'en' ? 'My explanation mode' : '我的解释模式', description: '', prompt: promptLocale(s) === 'en' ? 'Explain the selected text in plain, concise language. Use the context and provide an easy-to-understand example.' : '请用通俗、简洁的语言解释选中文字，结合语境，给出一个容易理解的例子。', builtin: false };
    s.modes.push(m); selectedMode = m.id; changed(); renderModes(); renderGeneral(); $('mode-name').focus();
  };
  $('add-mode').onclick = () => addMode(); $('duplicate-mode').onclick = () => addMode(mode());
  $('default-this-mode').onclick = () => { s.defaultMode = selectedMode; changed(); renderModes(); renderGeneral(); };
  $('restore-mode').onclick = () => { const original = MODES.find(m => m.id === selectedMode); if (original && confirm(uiText('恢复这个模式的原始提示词？', s.uiLanguage))) { mode().prompt = original.prompt; changed(); renderModes(); } };
  $('delete-mode').onclick = () => {
    if (mode().builtin || !confirm(s.uiLanguage === 'en' ? `Delete “${mode().name}”? Applies after saving.` : `删除“${mode().name}”？保存后生效。`)) return;
    s.modes = s.modes.filter(m => m.id !== selectedMode); if (s.defaultMode === selectedMode) s.defaultMode = s.modes[0].id;
    selectedMode = s.defaultMode; changed(); renderModes(); renderGeneral();
  };
  $('save').onclick = async () => {
    for (const input of document.querySelectorAll<HTMLInputElement>('.appearance-control input[type=number], #target-characters')) { if (input.id === 'target-characters' && s.length !== 'custom') continue; if (!input.value || !input.reportValidity()) { notify('请填写范围内的有效数值。'); return; } }
    const rev = revision, snapshot = structuredClone(s); $<HTMLButtonElement>('save').disabled = true; $('save').textContent = '保存中…';
    try {
      const result = await rpc<Settings>('saveSettings', { value: snapshot });
      if (revision === rev) { s = result; dirty = false; $('save-status').textContent = '已保存到此设备'; $('save').textContent = '已保存'; renderGeneral(); } else { changed(); }
    } catch (error) { notify((error as Error).message); $('save').textContent = '保存修改'; $<HTMLButtonElement>('save').disabled = false; }
  };
  $('clear-cache').onclick = async () => { await rpc('clearCache'); $('cache-status').textContent = ' 已清除'; };
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty) $('save').click(); } });
}
main().catch(error => notify(`无法加载设置：${(error as Error).message}`));
