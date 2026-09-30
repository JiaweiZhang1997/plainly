import { PDF_RULE_IDS, pdfRedirectRules, nativePdfRule } from './pdf-routing.ts';
import { pdfSource } from './pdf-text.ts';
let queue: Promise<unknown> = Promise.resolve();
let applied: boolean | undefined;
export function syncPdfIntegration(enabled: boolean) {
  const run = queue.then(async () => {
    if (enabled === applied) return;
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: PDF_RULE_IDS, addRules: enabled ? pdfRedirectRules(chrome.runtime.getURL('pdf.html')) : [] });
    applied = enabled;
  });
  queue = run.catch(() => {}); return run;
}
export async function openNativePdf(tabId: number, value: string, page: number) {
  const url = pdfSource(value, true), rule = nativePdfRule(tabId, url);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id], addRules: [rule] });
  await chrome.storage.session.set({ [`pdfNative:${tabId}`]: url });
  try { await chrome.tabs.update(tabId, { url: `${url}#page=${Math.max(1, Math.floor(page) || 1)}` }); }
  catch (error) { await clearNativePdf(tabId); throw error; }
}
async function clearNativePdf(tabId: number) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [100000 + tabId] });
  await chrome.storage.session.remove(`pdfNative:${tabId}`);
}
chrome.tabs.onRemoved.addListener(tabId => { void clearNativePdf(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  void (async () => {
    const key = `pdfNative:${tabId}`, stored = (await chrome.storage.session.get(key))[key];
    if (!stored) return;
    const url = new URL(change.url!); url.hash = '';
    if (url.href !== stored) await clearNativePdf(tabId);
  })().catch(() => {});
});
