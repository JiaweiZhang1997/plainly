import { resolveLanguageSettings, type LanguageSettings } from './language.ts';

async function getJSON(url: URL, signal: AbortSignal) {
  const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new Error('词典暂未收录这个词，请试试词语原形，或切换“同语学习”使用 LLM。');
    if (response.status === 429) throw new Error('免费服务当前限流或额度已用完，请稍后重试，或手动切换 LLM。');
    throw new Error(`免费语言服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
  }
  try { return await response.json(); } catch { throw new Error('免费语言服务返回了无法识别的内容，请重试。'); }
}
export async function translateFree(text: string, language: LanguageSettings, signal: AbortSignal, uiLanguage: 'zh-CN' | 'en' = 'zh-CN'): Promise<string> {
  language = resolveLanguageSettings(language, uiLanguage);
  if (language.source === 'auto') throw new Error('MyMemory 需要明确的原文语言，请先选择原文语言。');
  if (language.source === language.target) throw new Error('两种语言相同；如需原语言改写，请切换“同语学习”。');
  if (new TextEncoder().encode(text).length > 500) throw new Error('MyMemory 单次最多 500 字节（中文约 160 字），请缩短选区，或手动切换 LLM。');
  const url = new URL('https://api.mymemory.translated.net/get');
  url.search = new URLSearchParams({ q: text, langpair: `${language.source}|${language.target}` }).toString();
  const data = await getJSON(url, signal);
  if (data.quotaFinished || Number(data.responseStatus) === 429) throw new Error('MyMemory 免费额度已用完，请稍后重试，或手动切换 LLM。');
  if (Number(data.responseStatus) !== 200 || typeof data.responseData?.translatedText !== 'string' || !data.responseData.translatedText.trim()) throw new Error('MyMemory 未能返回译文，请核对语言方向或稍后重试。');
  return decodeEntities(data.responseData.translatedText).slice(0, 16000);
}
// The public API may HTML-escape its text. Decode as text; never create HTML nodes.
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, code: string) => {
    const map: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    if (code[0] !== '#') return map[code.toLowerCase()] || raw;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : raw;
  });
}
export async function lookupDictionary(text: string, signal: AbortSignal, uiLanguage: 'zh-CN' | 'en' = 'zh-CN'): Promise<string> {
  const word = text.trim();
  if (!/^[A-Za-z]+(?:[-'][A-Za-z]+)*$/.test(word) || word.length > 80) throw new Error('免费英英词典支持单个英文单词；句子、短语或其他语言请使用“同语学习”。');
  const data = await getJSON(new URL(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`), signal);
  if (!Array.isArray(data) || !data.length) throw new Error('词典未返回有效词条，请试试词语原形。');
  const lines: string[] = [];
  let definitions = 0;
  const value = (v: unknown, max = 1000) => typeof v === 'string' ? v.slice(0, max) : '';
  for (const entry of data.slice(0, 2)) {
    lines.push(`${value(entry.word, 100) || word} ${value(entry.phonetic, 100)}`.trim());
    for (const meaning of (Array.isArray(entry.meanings) ? entry.meanings : []).slice(0, 3)) {
      for (const definition of (Array.isArray(meaning.definitions) ? meaning.definitions : []).slice(0, 2)) {
        if (!value(definition.definition)) continue;
        definitions++;
        lines.push(`${value(meaning.partOfSpeech, 60)} · ${value(definition.definition)}`);
        if (value(definition.example)) lines.push(`Example: ${value(definition.example)}`);
      }
    }
    if (value(entry.license?.name, 100)) lines.push(`License: ${value(entry.license.name, 100)} ${safeSource(entry.license.url)}`);
    const sources = (Array.isArray(entry.sourceUrls) ? entry.sourceUrls : []).slice(0, 2).map(safeSource).filter(Boolean);
    if (sources.length) lines.push(`Source: ${sources.join(' · ')}`);
  }
  if (!definitions) throw new Error('词典没有提供释义，请换一个词重试。');
  lines.push(uiLanguage === 'en' ? 'Source: Free Dictionary API' : '来源：Free Dictionary API'); return lines.join('\n\n').slice(0, 12000);
}
function safeSource(value: unknown) { try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href.slice(0, 400) : ''; } catch { return ''; } }
