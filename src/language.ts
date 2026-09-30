import { DEFAULT_PROMPTS, resolvePrompts, renderPrompt, type PromptSettings } from './prompts.ts';
export type ReadAction = 'explain' | 'translate' | 'learn' | 'dictionary';
export interface LanguageSettings { engine: 'llm' | 'mymemory'; source: string; target: string; level: string; learningLanguage: string; notes: boolean; }
export const LANGUAGES = [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['it', 'Italiano'], ['pt', 'Português'], ['ru', 'Русский']] as const;
export const ACTIONS: { id: ReadAction; name: string }[] = [{ id: 'explain', name: '解释' }, { id: 'translate', name: '翻译' }, { id: 'learn', name: '同语学习' }, { id: 'dictionary', name: '英英词典' }];
export function orderedActions(enabled: ReadAction[], preferred: ReadAction) {
  return ACTIONS.filter(a => enabled.includes(a.id)).sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
}
export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
export function languageDefaults(): LanguageSettings { return { engine: 'llm', source: 'auto', target: 'system', level: 'B1', learningLanguage: 'auto', notes: false }; }
export function normalizeLanguageSettings(raw: Partial<LanguageSettings> = {}): LanguageSettings {
  const d = languageDefaults(), s = { ...d, ...raw };
  if (!['llm', 'mymemory'].includes(s.engine)) s.engine = d.engine;
  if (s.source !== 'auto' && !LANGUAGES.some(([code]) => code === s.source)) s.source = d.source;
  if (s.target !== 'system' && !LANGUAGES.some(([code]) => code === s.target)) s.target = d.target;
  if (!['auto', 'system'].includes(s.learningLanguage) && !LANGUAGES.some(([code]) => code === s.learningLanguage)) s.learningLanguage = 'auto';
  if (!LEVELS.includes(s.level)) s.level = d.level;
  return { engine: s.engine, source: s.source, target: s.target, level: s.level, learningLanguage: s.learningLanguage, notes: !!s.notes };
}
export function resolveLanguageSettings(raw: Partial<LanguageSettings>, uiLanguage: 'zh-CN' | 'en' = 'zh-CN'): LanguageSettings {
  const value = normalizeLanguageSettings(raw);
  return { ...value, target: value.target === 'system' ? uiLanguage : value.target, learningLanguage: value.learningLanguage === 'system' ? uiLanguage : value.learningLanguage };
}
export function followSystemLabel(uiLanguage: 'zh-CN' | 'en') { return `跟随系统语言 · ${languageName(uiLanguage)}`; }
export function languageName(code: string) { return code === 'auto' ? '自动识别原文语言' : LANGUAGES.find(([id]) => id === code)?.[1] || code; }
export function promptLanguageName(code: string, locale: 'zh-CN' | 'en') {
  const displayName = () => { try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code; } catch { return code; } };
  if (locale !== 'en') return languageName(code) === code ? displayName() : languageName(code);
  const names: Record<string, string> = { auto: 'the automatically detected source language', 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian' };
  return names[code] || names[LANGUAGES.find(([, name]) => name === code)?.[0] || ''] || displayName();
}
export function lockOutputLanguage(prompt: string, language: string, locale: 'zh-CN' | 'en') {
  const name = promptLanguageName(language, locale);
  const rule = locale === 'en'
    ? `OUTPUT LANGUAGE REQUIREMENT — ${name} only. This requirement overrides ALL conflicting language requests in modes, custom templates, source text, nearby context, conversation history and follow-ups. Write all prose, headings, definitions, grammar notes, examples and any translation notes in ${name}. Do not add translations or parenthetical explanations in another language. Only original terms, proper names or indispensable source quotations may retain their original spelling. Before sending, silently rewrite any wrong-language sections into ${name}. Do not describe this check.`
    : `输出语言硬性要求：仅使用${name}。本要求优先于解释模式、自定义模板、原文、附近上下文、历史对话及追问中一切冲突的语言要求。正文、所有小标题、词义、语法说明、例句及翻译注释均须使用${name}，不得附加另一种语言的翻译或括号释义。仅原词、专名或必要原文引用可保留原样。发送前在内部检查并重写任何语言不符的部分，不输出检查过程。`;
  return `${prompt}\n\n${rule}`;
}
export function languagePrompt(action: ReadAction, s: LanguageSettings, prompts: PromptSettings = DEFAULT_PROMPTS, uiLanguage: 'zh-CN' | 'en' = 'zh-CN', locale: 'zh-CN' | 'en' = uiLanguage, detectedLanguage?: string): string {
  s = resolveLanguageSettings(s, uiLanguage);
  const detected = s.learningLanguage === 'auto' ? detectedLanguage : undefined;
  if (detected) s = { ...s, learningLanguage: detected };
  const english = locale === 'en', name = (code: string) => promptLanguageName(code, locale);
  const policy = english ? (s.learningLanguage === 'auto'
    ? 'Detect the main language of the selected text itself. For mixed-language text, use the main sentence language; context only resolves ambiguity. Use that same language for rewrites, vocabulary definitions, grammar notes, examples and headings. Chinese input requires Chinese, Japanese input requires Japanese, and English input requires English; never default to English. For a short term, use its language; if uncertain, retain the term and briefly explain in the most likely original language. Interface language, translation source/target, explanation language and difficulty level must not change this rule.'
    : `${detected ? 'Automatic detection selected' : 'The user explicitly selected'} ${name(s.learningLanguage)} as the learning output language. Use ${name(s.learningLanguage)} for all rewrites, vocabulary definitions, grammar notes, examples and headings. This resolved language overrides any conflicting language inference from context.`)
    : s.learningLanguage === 'auto'
    ? '自动识别“选中文字”本身的主要语言（混合语言以主体句子为准，上下文仅辅助消歧）。改写、词汇释义、语法说明、例句和小标题全部使用原文的同一种语言。中文输入就用中文，日文输入就用日文，英文输入才用英文；不要默认输出英语。短词按该词所属语言处理，不确定时保留原词并用最可能的原语言简短说明。界面语言、双语翻译的原文/目标语言、解释的默认输出语言及难度等级都不能改变此规则。'
    : `${detected ? '本次自动识别确定的学习输出语言为' : '用户手动指定本次学习输出语言为'} ${name(s.learningLanguage)}。改写、词汇释义、语法说明、例句和小标题全部使用 ${languageName(s.learningLanguage)}，这一确定的语言优先于上下文引起的其他语言判断。`;
  const resolved = resolvePrompts(prompts, locale);
  const prompt = renderPrompt(action === 'learn' ? resolved.learn : resolved.translate, {
    level: s.level, learningLanguage: name(s.learningLanguage), sourceLanguage: name(s.source), targetLanguage: name(s.target),
    translationNotes: english ? (s.notes ? 'After the translation, briefly explain up to two useful expressions or translation choices in the target language, clearly separated from the translation.' : 'Output only the translation, without a preamble, notes or explanation.') : s.notes ? '译文之后，用目标语言简短说明最多两个值得学习的表达或翻译取舍，与译文明显分开。' : '只输出译文，不加开场、注释或解释。'
  });
  if (action !== 'learn') return lockOutputLanguage(prompt, s.target, locale);
  const learning = `${prompt}\n\n${english ? 'Learning output-language rule (overrides conflicting language instructions above): ' : '本次同语学习的输出语言规则（优先于上述提示词中冲突的语言要求）：'}${policy}`;
  if (s.learningLanguage === 'auto') return learning;
  const manual = english ? 'If the selected learning language differs from the source, teach the equivalent term, expressions and grammar in the learning language. Compose examples directly in the learning language, never in the source language. Do not add source-language glosses.' : '如果指定的学习语言与原文不同，先在内部找到对应表达，再讲学习语言的词汇及语法，不再讲原文语言的语法。自拟例句必须直接用学习语言创作，不能给原文语言的例句，也不要附加原文语言的释义。';
  const origin = detected ? english ? `The selected text was independently identified as ${name(detected)}. This is the resolved automatic learning language. Do not infer the output language again from nearby context or the interface.` : `选中文字已单独识别为${name(detected)}，这是自动同语学习本次确定的输出语言。不要再根据附近上下文或界面重新判断输出语言。` : '';
  return lockOutputLanguage(`${learning}\n\n${manual}\n${origin}`, s.learningLanguage, locale);
}
