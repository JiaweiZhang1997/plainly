import type { ExplainInput } from './core.ts';
export async function rpc<T = any>(type: string, extra: object = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || '插件连接已更新，请刷新页面后重试。');
  return response.value;
}
export function explain(input: ExplainInput, onEvent: (event: any) => void): () => void {
  return requestPort('explain', input, onEvent);
}
export function requestPort(kind: 'explain' | 'search', input: unknown, onEvent: (event: any) => void): () => void {
  const id = crypto.randomUUID();
  let port: chrome.runtime.Port;
  try { port = chrome.runtime.connect({ name: `plainly-${kind}` }); }
  catch { onEvent({ type: 'error', error: '插件已更新，请刷新网页后重试。' }); return () => {}; }
  let finished = false;
  port.onMessage.addListener(event => {
    if (event.id !== id || finished) return;
    if (event.type === 'done' || event.type === 'error') finished = true;
    onEvent(event);
    if (finished) port.disconnect();
  });
  port.onDisconnect.addListener(() => { if (!finished) { finished = true; onEvent({ type: 'error', error: '连接已中断，请重试。若插件刚更新，请刷新网页。' }); } });
  port.postMessage({ type: kind, id, input });
  return () => { if (finished) return; finished = true; try { port.postMessage({ type: 'cancel' }); port.disconnect(); } catch {} };
}
