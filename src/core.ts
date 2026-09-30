import { EN_MODE_PROMPTS, EN_MODE_LABELS } from './prompt-locales.ts';
import { APPEARANCE_DEFAULTS, boundedInteger, normalizeAppearance, type ReadingAppearance } from './reading-preferences.ts';
import { DEFAULT_PROMPTS, normalizePrompts, renderPrompt, promptLocale, resolvePrompts, type PromptLanguage, type PromptSettings } from './prompts.ts';
import { ACTIONS, languageDefaults, normalizeLanguageSettings, languagePrompt, promptLanguageName, lockOutputLanguage, type ReadAction, type LanguageSettings } from './language.ts';
export const DEFAULT_TRIGGER_SIZE = 24;
export type Protocol = 'openai' | 'anthropic' | 'gemini';
export type TriggerCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type SearchGranularity = 'auto' | 'sentence' | 'paragraph';
export interface JevSettings { apiKey: string; baseUrl: string; model: string; granularity: SearchGranularity; }
export interface SelectionBox { left: number; right: number; top: number; bottom: number; }
export interface Profile { id: string; name: string; provider: string; protocol: Protocol; baseUrl: string; apiKey: string; model: string; streamUsage?: boolean; }
export interface Mode { id: string; name: string; description: string; prompt: string; builtin?: boolean; }
export interface Settings {
  version: 1; pdfPreferenceVersion?: 2; pdfAutoOpen: boolean; trigger: 'click' | 'auto' | 'manual'; autoDelay: number;
  triggerCorner: TriggerCorner; triggerIcon: string; triggerIcons: string[]; showBuiltinIcon: boolean; triggerSize: number; closeAfterDrag: boolean;
  context: boolean; length: 'short' | 'standard' | 'detailed' | 'custom'; targetCharacters: number; appearance: ReadingAppearance; language: string;
  uiLanguage: 'zh-CN' | 'en'; promptLanguage: PromptLanguage; theme: 'system' | 'light' | 'dark'; defaultMode: string; activeProfile: string;
  profiles: Profile[]; modes: Mode[]; disabledSites: string[];
  jev: JevSettings; prompts: PromptSettings;
  defaultAction: ReadAction; enabledActions: ReadAction[]; translation: LanguageSettings;
}
export type PublicSettings = Omit<Settings, 'profiles' | 'jev' | 'triggerIcons' | 'showBuiltinIcon'> & { configured: boolean; modelLabel: string; searchConfigured: boolean; searchGranularity: SearchGranularity };
export interface Turn { role: 'user' | 'assistant'; content: string; }
export interface ExplainInput { text: string; context: string; modeId: string; history?: Turn[]; question?: string; fresh?: boolean; action?: ReadAction; translation?: LanguageSettings; }

export const MODES: Mode[] = [
  { id: 'smart', name: '智能解释', description: '读懂语境，选择恰当的解释方式。', builtin: true,
    prompt: '你是一位善于把难懂内容讲明白的阅读助手。自动判断选中文字是专业术语、网络黑话、梗、缩写还是复杂句子。先用一句自然、通俗的话解释它在当前语境里的意思，再仅补充理解所必需的背景或例子。无需告诉用户你的分类过程。' },
  { id: 'slang', name: '网络黑话 / 梗', description: '看懂圈内含义、潜台词和语气。', builtin: true,
    prompt: '你是一位网络语言解释助手。根据语境解释黑话、梗、圈内用语、反讽与潜台词。先说这里到底是什么意思，必要时补充常见使用场景、语气和一个自然例句。只有确知时才说明出处；新梗或小圈子用法无法确认时明确说明，不编造来源，不把字面意思当成实际含义。' },
  { id: 'term', name: '专业术语', description: '保留准确性，把专业概念讲简单。', builtin: true,
    prompt: '你是一位跨学科的科普解释者。把专有名词或专业术语解释给没有相关背景的人：先用一句通俗定义，再说明它用来解决什么问题；有帮助时给一个生活类比或具体例子，并点明类比的边界。避免用更多生僻术语解释一个术语。' },
  { id: 'acronym', name: '缩写解析', description: '找出全称，结合上下文消除歧义。', builtin: true,
    prompt: '你专门解释英文缩写、拼音缩写、简称和圈内简写。先给出最符合语境的全称及通俗含义。若有明显歧义，列出最多三个可信候选并说明对应场景。上下文不足时坦诚说明，不凭空拼凑字母全称。' },
  { id: 'sentence', name: '句子讲解', description: '理清复杂表达，说明话外之意。', builtin: true,
    prompt: '你是一位擅长清晰表达的阅读助手。把选中句子或段落改写成容易理解的话，保留原意、否定、条件和不确定性。必要时解释省略的逻辑、隐含的意思或文化背景，不引入原文没有的结论。' }
];

export function isBuiltinModePrompt(mode: Mode) {
  const original = MODES.find(m => m.id === mode.id);
  return !!original && [original.prompt, EN_MODE_PROMPTS[mode.id]].includes(mode.prompt.trim());
}
export function resolveModePrompt(mode: Mode, locale: 'zh-CN' | 'en') {
  return isBuiltinModePrompt(mode) ? (locale === 'en' ? EN_MODE_PROMPTS[mode.id] : MODES.find(m => m.id === mode.id)!.prompt) : mode.prompt;
}
export function localizedModeField(mode: Mode, field: 'name' | 'description', locale: 'zh-CN' | 'en') {
  const original = MODES.find(m => m.id === mode.id), english = EN_MODE_LABELS[mode.id]?.[field];
  if (!original || !english || ![original[field], english].includes(mode[field])) return mode[field];
  return locale === 'en' ? english : original[field];
}

export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { id: 'anthropic', name: 'Anthropic · Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5' },
  { id: 'gemini', name: 'Google · Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite' },
  { id: 'qwen', name: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', name: 'GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  { id: 'moonshot', name: 'Kimi · Moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  { id: 'custom', name: '自定义 / 本地模型', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' }
] as const;

export function defaults(): Settings {
  return { promptLanguage: 'system', closeAfterDrag: false, pdfPreferenceVersion: 2, pdfAutoOpen: false, appearance: { ...APPEARANCE_DEFAULTS }, targetCharacters: 300, prompts: { ...DEFAULT_PROMPTS }, version: 1, trigger: 'click', autoDelay: 600, triggerCorner: 'bottom-right', triggerIcon: '', triggerIcons: [], showBuiltinIcon: true, triggerSize: DEFAULT_TRIGGER_SIZE, defaultAction: 'explain', enabledActions: ['explain', 'translate', 'learn', 'dictionary'], translation: languageDefaults(), context: true, length: 'standard', language: 'system', uiLanguage: 'zh-CN', theme: 'system',
    defaultMode: 'smart', activeProfile: 'default', profiles: [{ ...PROVIDERS[0], id: 'default', provider: 'deepseek', apiKey: '' }],
    modes: MODES.map(m => ({ ...m })), disabledSites: [], jev: { apiKey: '', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', granularity: 'auto' } };
}
export function publicSettings(s: Settings): PublicSettings {
  const { profiles, jev, triggerIcons, showBuiltinIcon, ...rest } = s;
  const p = profiles.find(p => p.id === s.activeProfile);
  return { ...rest, prompts: resolvePrompts(s.prompts, promptLocale(s)), configured: !!p?.model && (!!p.apiKey || isLoopback(p.baseUrl)), modelLabel: p ? `${p.name} · ${p.model || '待设置模型'}` : '未配置模型', searchConfigured: !!jev.model && (!!jev.apiKey || isLoopback(jev.baseUrl)), searchGranularity: jev.granularity };
}
export function isLoopback(url: string) { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; } }
export function validateEndpoint(value: string): string {
  let u: URL; try { u = new URL(value.trim()); } catch { throw new Error('请填写有效的 API 地址。'); }
  if (u.username || u.password || u.search || u.hash) throw new Error('API 地址不能包含密码、查询参数或锚点。');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.href))) throw new Error('远程接口需要 HTTPS；本地模型可使用 localhost 的 HTTP 地址。');
  return u.href.replace(/\/+$/, '');
}
export function normalizeSettings(raw: Settings): Settings {
  const s = { ...defaults(), ...raw };
  s.pdfAutoOpen = raw.pdfPreferenceVersion === 2 && raw.pdfAutoOpen === true;
  s.pdfPreferenceVersion = 2;
  s.uiLanguage = raw.uiLanguage === 'en' ? 'en' : 'zh-CN';
  s.promptLanguage = raw.promptLanguage === 'en' || raw.promptLanguage === 'zh-CN' ? raw.promptLanguage : 'system';
  s.closeAfterDrag = raw.closeAfterDrag === true;
  s.prompts = normalizePrompts(raw.prompts);
  s.appearance = normalizeAppearance(raw.appearance);
  s.targetCharacters = boundedInteger(raw.targetCharacters, 300, 50, 5000);
  s.triggerSize = Math.round(Math.max(20, Math.min(56, Number(s.triggerSize) || DEFAULT_TRIGGER_SIZE)));
  s.translation = normalizeLanguageSettings(raw.translation);
  s.enabledActions = ACTIONS.map(a => a.id).filter(id => !Array.isArray(raw.enabledActions) || raw.enabledActions.includes(id));
  if (!s.enabledActions.length) throw new Error('请为问号按钮至少保留一项功能。');
  if (!s.enabledActions.includes(s.defaultAction)) s.defaultAction = s.enabledActions[0];
  s.jev = { ...defaults().jev, ...raw.jev };
  s.jev.apiKey = String(s.jev.apiKey || '').trim().slice(0, 2000);
  s.jev.baseUrl = validateEndpoint(s.jev.baseUrl);
  s.jev.model = String(s.jev.model || 'jev-latest').trim().slice(0, 120);
  if (!['auto', 'sentence', 'paragraph'].includes(s.jev.granularity)) s.jev.granularity = 'auto';
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(s.triggerCorner)) s.triggerCorner = 'bottom-right';
  // Only locally rasterized, bounded PNG data is accepted; never arbitrary URLs or SVG markup.
  if (typeof s.triggerIcon !== 'string' || s.triggerIcon.length > 65536 || (s.triggerIcon && !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(s.triggerIcon))) throw new Error('图标无效，请重新上传图片。');
  // Migrate the previously selected upload once; an empty saved library remains empty.
  const icons = raw.triggerIcons === undefined ? (s.triggerIcon ? [s.triggerIcon] : []) : raw.triggerIcons;
  if (!Array.isArray(icons) || icons.length > 20 || icons.some(icon => typeof icon !== 'string' || icon.length > 65536 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(icon))) throw new Error('图标库无效，最多保存 20 张上传图标。');
  s.triggerIcons = [...new Set(icons)];
  s.showBuiltinIcon = raw.showBuiltinIcon !== false;
  if (!['click', 'auto', 'manual'].includes(s.trigger) || !['system', 'light', 'dark'].includes(s.theme) || !['short', 'standard', 'detailed', 'custom'].includes(s.length)) throw new Error('设置格式无效。');
  s.autoDelay = Math.max(300, Math.min(2000, Number(s.autoDelay) || 600));
  s.language = String(s.language || 'system').slice(0, 80);
  s.context = !!s.context;
  if (!Array.isArray(s.profiles) || !s.profiles.length || s.profiles.length > 20) throw new Error('请保留 1–20 套模型配置。');
  s.profiles = s.profiles.map(p => {
    if (!['openai', 'anthropic', 'gemini'].includes(p.protocol)) throw new Error('不支持的接口协议。');
    return { id: String(p.id).slice(0, 80), name: String(p.name || '未命名').slice(0, 60), provider: String(p.provider), protocol: p.protocol,
      baseUrl: validateEndpoint(p.baseUrl), apiKey: String(p.apiKey || '').trim().slice(0, 2000), model: String(p.model || '').trim().slice(0, 200), streamUsage: p.streamUsage !== false };
  });
  if (!Array.isArray(s.modes) || !s.modes.length || s.modes.length > 30) throw new Error('请保留 1–30 个解释模式。');
  s.modes = s.modes.map(m => ({ id: String(m.id).slice(0, 80), name: String(m.name).trim().slice(0, 40), description: String(m.description || '').slice(0, 160), prompt: String(m.prompt).trim().slice(0, 16000), builtin: MODES.some(b => b.id === m.id) }));
  const acronym = MODES.find(m => m.id === 'acronym')!;
  for (const m of s.modes) if (m.id === acronym.id && m.prompt === acronym.prompt.replace('全称及通俗含义', '全称及通俗中文含义')) m.prompt = acronym.prompt;
  if (s.modes.some(m => !m.name || !m.prompt)) throw new Error('模式名称和系统提示词不能为空。');
  if (new Set(s.modes.map(m => m.id)).size !== s.modes.length || new Set(s.profiles.map(p => p.id)).size !== s.profiles.length) throw new Error('配置标识重复。');
  if (!s.profiles.some(p => p.id === s.activeProfile)) s.activeProfile = s.profiles[0].id;
  if (!s.modes.some(m => m.id === s.defaultMode)) s.defaultMode = s.modes[0].id;
  s.disabledSites = [...new Set((s.disabledSites || []).map(x => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 500);
  return s;
}
export function sanitizeInput(raw: ExplainInput): ExplainInput {
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('请先选择需要解释的文字。');
  if (raw.text.length > 4000) throw new Error('一次最多解释 4000 个字符，请缩小选区。');
  const history: Turn[] = (Array.isArray(raw.history) ? raw.history : []).slice(-6).filter(t => t && ['user', 'assistant'].includes(t.role) && typeof t.content === 'string').map(t => ({ role: t.role, content: t.content.slice(0, 8000) }));
  return { text: raw.text.trim(), context: String(raw.context || '').slice(0, 1800), modeId: String(raw.modeId || '').slice(0, 80), history,
    question: String(raw.question || '').slice(0, 1000), fresh: !!raw.fresh,
    action: ACTIONS.some(a => a.id === raw.action) ? raw.action : 'explain', translation: raw.translation ? normalizeLanguageSettings(raw.translation) : undefined };
}
export function makeMessages(s: Settings, input: ExplainInput, detectedLearningLanguage?: string): { system: string; turns: Turn[] } {
  const locale = promptLocale(s), english = locale === 'en';
  const data = JSON.stringify(english ? { selectedText: input.text, nearbyContext: s.context ? input.context : '' } : { 选中文字: input.text, 附近上下文: s.context ? input.context : '' });
  if (input.action === 'translate' || input.action === 'learn') {
    const translation = normalizeLanguageSettings({ ...s.translation, ...input.translation });
    const turns: Turn[] = [{ role: 'user', content: data }, ...(input.history || [])];
    if (input.question) turns.push({ role: 'user', content: input.question });
    return { system: languagePrompt(input.action, translation, s.prompts, s.uiLanguage, locale, detectedLearningLanguage), turns };
  }
  const mode = s.modes.find(m => m.id === input.modeId) || s.modes.find(m => m.id === s.defaultMode) || s.modes[0];
  const lengths = english ? { short: 'Keep it brief, usually about 40 words, covering only the core meaning.', standard: 'Usually use 60–120 words in two or three short paragraphs, as needed.', detailed: 'Use up to about 250 words, explaining step by step without repetition.' } : { short: '尽量控制在 80 字左右，只保留核心含义。', standard: '通常用 120–220 字，按需要用两到三段解释。', detailed: '可以展开到约 500 字，循序渐进，避免重复。' };
  const length = s.length === 'custom' ? english ? `Aim for approximately ${s.targetCharacters} characters including punctuation and spaces. Cover the key points within this length and keep sentences complete.` : `回答以约 ${s.targetCharacters} 个字符为目标，包含标点与空格；在这个篇幅内说明重点，保持句子完整。` : lengths[s.length];
  const outputLanguage = s.language === 'system' ? s.uiLanguage : s.language;
  const system = lockOutputLanguage(renderPrompt(resolvePrompts(s.prompts, locale).explanation, { language: promptLanguageName(outputLanguage, locale), length, modePrompt: resolveModePrompt(mode, locale) }), outputLanguage, locale);
  const turns: Turn[] = [{ role: 'user', content: english ? `Explain the selectedText in this quoted material:\n${data}` : `请解释以下引用材料中的“选中文字”：\n${data}` }, ...(input.history || [])];
  if (input.question) turns.push({ role: 'user', content: input.question });
  return { system, turns };
}
export function outputTokenBudget(s: Settings, action: ReadAction = 'explain') {
  if (action === 'translate') return 8192;
  if (action === 'explain' && s.length === 'custom') return Math.max(4096, s.targetCharacters * 2 + 1024);
  return s.length === 'detailed' ? 4096 : 2048;
}
export function place(anchor: { left: number; right: number; top: number; bottom: number }, width: number, height: number, vw: number, vh: number) {
  const gap = 9, pad = 12;
  const left = Math.max(pad, Math.min(anchor.left, vw - width - pad));
  let top = anchor.bottom + gap;
  if (top + height > vh - pad) top = anchor.top - height - gap;
  return { left, top: Math.max(pad, Math.min(top, vh - height - pad)) };
}

export function selectionBox(rects: SelectionBox[]): SelectionBox | undefined {
  const visible = rects.filter(r => r.right > r.left && r.bottom > r.top);
  if (!visible.length) return undefined;
  return { left: Math.min(...visible.map(r => r.left)), right: Math.max(...visible.map(r => r.right)), top: Math.min(...visible.map(r => r.top)), bottom: Math.max(...visible.map(r => r.bottom)) };
}

export function placeTrigger(anchor: SelectionBox, corner: TriggerCorner, width: number, height: number, vw: number, vh: number) {
  const gap = 2, pad = 6;
  const leftOf = anchor.left - width - gap, rightOf = anchor.right + gap;
  const above = anchor.top - height - gap, below = anchor.bottom + gap;
  const fitsX = (x: number) => x >= pad && x + width <= vw - pad;
  const fitsY = (y: number) => y >= pad && y + height <= vh - pad;
  let left = corner.endsWith('left') ? leftOf : rightOf;
  let top = corner.startsWith('top') ? above : below;
  // Prefer the chosen corner, flip only the constrained axis before clamping to the viewport.
  if (!fitsX(left)) { const other = corner.endsWith('left') ? rightOf : leftOf; if (fitsX(other)) left = other; }
  if (!fitsY(top)) { const other = corner.startsWith('top') ? below : above; if (fitsY(other)) top = other; }
  return { left: Math.max(pad, Math.min(left, vw - width - pad)), top: Math.max(pad, Math.min(top, vh - height - pad)) };
}
