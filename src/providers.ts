import { mergeUsage, parseUsage, type UsageObserver } from './usage.ts';
import { validateEndpoint, isLoopback, type Profile, type Turn } from './core.ts';

export function buildRequest(profile: Profile, system: string, turns: Turn[], tokens = 2048) {
  const base = validateEndpoint(profile.baseUrl);
  if (!profile.model.trim()) throw new Error('还没有填写模型名称，请到设置中完成配置。');
  if (!profile.apiKey && !isLoopback(base)) throw new Error('还没有填写 API Key，请到设置中完成配置。');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url: string, body: unknown;
  if (profile.protocol === 'anthropic') {
    url = /\/messages$/.test(base) ? base : `${base}/messages`;
    headers['x-api-key'] = profile.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = { model: profile.model, max_tokens: tokens, stream: true, system, messages: turns };
  } else if (profile.protocol === 'gemini') {
    url = `${base}/models/${encodeURIComponent(profile.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`;
    headers['x-goog-api-key'] = profile.apiKey;
    body = { systemInstruction: { parts: [{ text: system }] }, contents: turns.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })), generationConfig: { maxOutputTokens: Math.max(tokens, 4096) } };
  } else {
    url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
    const host = new URL(base).hostname;
    const tokenField = host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
    // These always-thinking models default to max effort; short reading tasks use low.
    // Match official endpoints and exact models so custom providers retain their own defaults.
    const lightReasoning = (host === 'open.bigmodel.cn' && profile.model === 'glm-5.3')
      || (['api.moonshot.cn', 'api.moonshot.ai'].includes(host) && profile.model === 'kimi-k3');
    body = { model: profile.model, stream: true, ...(lightReasoning ? { reasoning_effort: 'low' } : {}), ...(profile.streamUsage !== false ? { stream_options: { include_usage: true } } : {}), messages: [{ role: 'system', content: system }, ...turns], [tokenField]: Math.max(tokens, 4096) };
  }
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' as RequestRedirect } };
}

// SSE events may split across UTF-8 characters, CRLF boundaries, and arbitrary TCP chunks.
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', lines: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (line === '') { if (lines.length) yield lines.join('\n'); lines = []; }
        else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) {
        if (buffer.startsWith('data:')) lines.push(buffer.slice(5).trimStart());
        if (lines.length) yield lines.join('\n');
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function parseEvent(protocol: Profile['protocol'], data: any): { text: string; done?: boolean; truncated?: boolean } {
  if (data.error || data.type === 'error') throw new Error('模型服务返回错误，请检查服务状态或重试。');
  if (protocol === 'anthropic') return { text: data.type === 'content_block_delta' && data.delta?.type === 'text_delta' ? data.delta.text || '' : '', done: data.type === 'message_stop', truncated: data.delta?.stop_reason === 'max_tokens' };
  if (protocol === 'gemini') {
    const c = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT'].includes(c?.finishReason)) throw new Error('模型未返回解释，可能触发了服务商的内容限制。');
    return { text: (c?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''), done: !!c?.finishReason, truncated: c?.finishReason === 'MAX_TOKENS' };
  }
  const c = data.choices?.[0];
  if (c?.finish_reason === 'content_filter') throw new Error('模型未返回解释，可能触发了服务商的内容限制。');
  return { text: typeof c?.delta?.content === 'string' ? c.delta.content : '', done: !!c?.finish_reason, truncated: c?.finish_reason === 'length' };
}
export function httpError(status: number): string {
  if ([401, 403].includes(status)) return '连接未获授权：请检查 API Key、模型权限和接口地址。';
  if (status === 429) return '请求过于频繁或额度不足，请稍后再试或检查账户余额。';
  if (status === 404) return '没有找到接口或模型，请核对 API 地址和模型名称。';
  if (status === 400 || status === 422) return '接口不接受当前请求，请检查模型名称、协议及模型是否支持文本对话。';
  return `模型服务暂时不可用（HTTP ${status}），请稍后重试。`;
}
export async function streamModel(profile: Profile, system: string, turns: Turn[], signal: AbortSignal, onText: (text: string) => void, tokens = 2048, onUsage?: UsageObserver) {
  const { url, init } = buildRequest(profile, system, turns, tokens);
  let usage: Record<string, unknown> = {}, finished = false, outputCap = false;
  const observe = (data: any) => { usage = mergeUsage(usage, profile.protocol === 'gemini' ? data.usageMetadata : data.message?.usage || data.usage); };
  try {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) { await res.body?.cancel(); throw new Error(httpError(res.status)); }
  if (!res.body) throw new Error('接口返回了空响应。');
  let output = '', truncated = false, complete = false;
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    // Some compatible local servers ignore stream=true and return regular JSON.
    const json = await res.json(); observe(json);
    if (json.error) throw new Error('模型服务返回错误，请检查配置。');
    output = profile.protocol === 'anthropic' ? (json.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('')
      : profile.protocol === 'gemini' ? (json.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('') : json.choices?.[0]?.message?.content || '';
    if (typeof output !== 'string') output = '';
    truncated = ['length', 'MAX_TOKENS', 'max_tokens'].includes(json.choices?.[0]?.finish_reason || json.candidates?.[0]?.finishReason || json.stop_reason);
    onText(output); complete = true;
  } else {
    for await (const raw of sseData(res.body)) {
      if (raw.trim() === '[DONE]') { complete = true; break; }
      let data; try { data = JSON.parse(raw); } catch { throw new Error('接口返回了无法读取的流式数据，请检查服务兼容性。'); }
      observe(data);
      const event = parseEvent(profile.protocol, data);
      truncated ||= !!event.truncated;
      if (event.text) { output += event.text; onText(event.text); }
      if (output.length > 32000) { truncated = true; complete = true; outputCap = true; break; }
      if (event.done) complete = true;
      // OpenAI sends usage after finish_reason; read through the final usage frame.
      if (profile.protocol === 'anthropic' && event.done) break;
    }
  }
  if (!complete) throw new Error('连接中断，解释尚未完成，请重试。');
  if (!output.trim()) throw new Error('模型没有返回正文，请尝试其他模型或稍后重试。');
  finished = true;
  return { output, truncated };
  } finally { await Promise.resolve(onUsage?.({ usage: parseUsage(profile.protocol, usage), complete: finished && !outputCap })).catch(() => {}); }
}
