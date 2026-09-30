// Only top-level PDF navigations are redirected. API fetches, frames, POSTs,
// ordinary HTML pages and explicit attachment downloads keep their normal behavior.
export const PDF_RULE_IDS = [8101, 8102, 8103];
export function pdfRedirectRules(viewer: string): chrome.declarativeNetRequest.Rule[] {
  const action: chrome.declarativeNetRequest.RuleAction = { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { regexSubstitution: `${viewer}?source=\\0` } };
  const online = {
    resourceTypes: ['main_frame'] as chrome.declarativeNetRequest.ResourceType[], requestMethods: ['get'] as chrome.declarativeNetRequest.RequestMethod[],
    excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }]
  };
  return [
    { id: 8101, priority: 1, action, condition: { ...online, regexFilter: '^https?://.*$', responseHeaders: [{ header: 'content-type', values: ['application/pdf', 'application/pdf;*', 'application/x-pdf', 'application/x-pdf;*'] }] } },
    { id: 8102, priority: 1, action, condition: { ...online, regexFilter: '^https?://[^?#]+\\.pdf([?][^#]*)?(#.*)?$', responseHeaders: [{ header: 'content-type', values: ['application/octet-stream', 'application/octet-stream;*'] }] } },
    { id: 8103, priority: 1, action, condition: { resourceTypes: ['main_frame'] as chrome.declarativeNetRequest.ResourceType[], regexFilter: '^file://[^?#]+\\.pdf([?][^#]*)?(#.*)?$' } }
  ];
}
export function nativePdfRule(tabId: number, source: string): chrome.declarativeNetRequest.Rule {
  const url = new URL(source); url.hash = '';
  return { id: 100000 + tabId, priority: 100, action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType }, condition: { tabIds: [tabId], isUrlFilterCaseSensitive: true, resourceTypes: ['main_frame'] as chrome.declarativeNetRequest.ResourceType[], regexFilter: '^' + url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(#.*)?$' } };
}
export function pdfPageNumber(hash: string): number {
  return Math.max(1, Math.min(100000, Number(new URLSearchParams(hash.replace(/^#/, '')).get('page')) || 1));
}
// DNR substitution is raw, not URI-encoded. Never decode the original signed URL.
export function redirectedPdfSource(search: string): string | undefined {
  return search.startsWith('?source=') ? search.slice('?source='.length) : undefined;
}
