import { ExplainCard } from './card.ts';
import { rpc } from './client.ts';
import { selectionBox, type PublicSettings } from './core.ts';

// One live controller per extension and document, including across isolated-world reloads.
const FLAG = '__plainly_content_v2__';
const version = chrome.runtime.getManifest().version;
const previous = (globalThis as any)[FLAG];
if (previous?.version !== version || !previous?.alive?.()) { previous?.dispose?.(); void start(); }
async function start() {
  const extensionId = chrome.runtime.id, token = crypto.randomUUID();
  const ownerAttribute = `data-plainly-session-${extensionId}`;
  const documentRoot = document.documentElement, events = new AbortController();
  let card: ExplainCard | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, range: Range | undefined, frame = 0;
  let pointerDown = false;
  let nodes: MutationObserver | undefined;
  let messageListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | undefined;
  const handle = { version, alive, dispose };
  function alive() {
    try { return !events.signal.aborted && chrome.runtime.id === extensionId && documentRoot.getAttribute(ownerAttribute) === token; }
    catch { return false; }
  }
  function dispose() {
    if (events.signal.aborted) return;
    events.abort(); clearTimeout(timer); cancelAnimationFrame(frame); nodes?.disconnect(); card?.destroy();
    try { if (messageListener) chrome.runtime.onMessage.removeListener(messageListener); } catch {}
    if (documentRoot.getAttribute(ownerAttribute) === token) documentRoot.removeAttribute(ownerAttribute);
    if ((globalThis as any)[FLAG] === handle) delete (globalThis as any)[FLAG];
  }
  function current() { if (alive()) return true; dispose(); return false; }
  (globalThis as any)[FLAG] = handle;
  documentRoot.setAttribute(ownerAttribute, token);
  document.addEventListener('plainly-controller-changed', () => { current(); }, { signal: events.signal });
  document.dispatchEvent(new Event('plainly-controller-changed'));
  let prefs: PublicSettings;
  try { prefs = await rpc<PublicSettings>('publicSettings'); } catch { dispose(); return; }
  if (!current()) return;
  const reader = new ExplainCard(prefs); card = reader;
  reader.host.dataset.plainlyOwner = extensionId;
  // Legacy content scripts had no disposal hook. Remove their leftover UI, even if
  // a delayed listener from an invalidated world mounts it again. Never touch a
  // tagged reader belonging to a different installed extension.
  function clearStaleReaders() {
    if (!current()) return;
    for (const host of documentRoot.querySelectorAll<HTMLElement>(':scope > plainly-reader')) {
      if (host === reader.host) continue;
      if (host.dataset.plainlyOwner === extensionId || (!host.dataset.plainlyOwner && host.shadowRoot?.querySelector('.trigger') && host.shadowRoot.querySelector('.card'))) host.remove();
    }
  }
  clearStaleReaders();
  nodes = new MutationObserver(clearStaleReaders); nodes.observe(documentRoot, { childList: true });
  document.addEventListener('visibilitychange', () => { current(); }, { signal: events.signal });
  const inCard = (event: Event) => event.composedPath().some(node => node === reader.host || node instanceof Element && (node.tagName === 'PLAINLY-SEARCH' || node.hasAttribute('data-plainly-ui')));
  const disabled = () => prefs.disabledSites.includes(location.hostname.toLowerCase());
  function capture(fallback?: string) {
    if (!current()) return false;
    const selected = window.getSelection();
    const focus = document.activeElement;
    if (focus?.matches('input,textarea,[contenteditable=true]') || (focus as HTMLElement)?.isContentEditable) return false;
    const text = selected?.toString().trim() || fallback?.trim();
    if (!text || text.length > 4000) return false;
    if (selected?.rangeCount && selected.toString().trim()) {
      const nextRange = selected.getRangeAt(0).cloneRange();
      if (reader.root.contains(nextRange.commonAncestorContainer)) return false;
      const parent = nextRange.startContainer.nodeType === Node.ELEMENT_NODE ? nextRange.startContainer as Element : nextRange.startContainer.parentElement;
      if (parent?.closest('input,textarea,[contenteditable=true]')) return false;
      range = nextRange;
      const block = parent?.closest('p,li,blockquote,pre,td,dd,dt,h1,h2,h3,h4,div');
      let context = '';
      if (prefs.context && block) {
        const all = block.textContent || '';
        const offset = Math.max(0, all.indexOf(text));
        const start = Math.max(0, offset - Math.max(0, (1800 - text.length) / 2));
        context = all.slice(start, start + 1800).trim();
      }
      const rect = selectionBox([...range.getClientRects()]) || range.getBoundingClientRect();
      reader.setSelection(text, context, rect);
    } else {
      range = undefined; reader.setSelection(text, '', { left: window.innerWidth / 2 - 170, right: window.innerWidth / 2, top: 80, bottom: 90 });
    }
    return true;
  }
  function schedule() {
    if (!current()) return;
    clearTimeout(timer);
    if (disabled() || prefs.trigger === 'manual') return;
    timer = setTimeout(() => {
      if (pointerDown || !capture()) { reader.hideTrigger(); return; }
      // A retained card only switches content after an explicit click, even in auto mode.
      if (prefs.trigger === 'auto' && !reader.keepOnOutside) reader.open(); else reader.showTrigger();
    }, prefs.trigger === 'auto' ? prefs.autoDelay : 25);
  }
  document.addEventListener('pointerdown', event => {
    if (!current()) return;
    if (inCard(event)) return;
    pointerDown = true; clearTimeout(timer);
    reader.hideTrigger();
    if (!reader.keepOnOutside) reader.close();
  }, { capture: true, signal: events.signal });
  document.addEventListener('pointerup', event => { pointerDown = false; if (event.button === 0 && !inCard(event)) schedule(); }, { capture: true, signal: events.signal });
  document.addEventListener('pointercancel', () => { pointerDown = false; clearTimeout(timer); }, { capture: true, signal: events.signal });
  document.addEventListener('keyup', event => {
    if (!current()) return;
    if (event.key === 'Escape') { clearTimeout(timer); reader.close(); return; }
    if (!inCard(event) && (event.key === 'Shift' || event.key.startsWith('Arrow'))) schedule();
  }, { capture: true, signal: events.signal });
  // selectionchange may arrive after pointerup: don't erase the just-scheduled trigger.
  document.addEventListener('selectionchange', () => { if (current() && !window.getSelection()?.toString().trim()) { clearTimeout(timer); reader.hideTrigger(); } }, { signal: events.signal });
  const reposition = () => {
    if (!current()) return;
    clearTimeout(timer);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!current()) return;
      if (!reader.showing && !reader.triggerVisible) return;
      if (range && (reader.triggerVisible || !reader.positionLocked)) {
        if (!range.startContainer.isConnected) { if (reader.positionLocked) reader.hideTrigger(); else reader.close(); return; }
        const rect = selectionBox([...range.getClientRects()]) || range.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
          if (reader.positionLocked) { reader.hideTrigger(); reader.reposition(); } else reader.close();
        } else reader.moveAnchor(rect);
      } else reader.reposition();
    });
  };
  window.addEventListener('scroll', event => { if (!event.composedPath().includes(reader.host)) reposition(); }, { capture: true, passive: true, signal: events.signal });
  window.addEventListener('resize', reposition, { passive: true, signal: events.signal });
  window.addEventListener('plainly-document-change', () => { clearTimeout(timer); range = undefined; reader.close(); }, { signal: events.signal });
  messageListener = (msg, _sender, reply) => {
    if (!current()) return;
    if (msg.type === 'settingsChanged') {
      prefs = msg.value; clearTimeout(timer); reader.close(); reader.updateSettings(prefs); reply(true);
    }
    if (msg.type === 'explainSelection') { clearTimeout(timer); if (capture(msg.text)) reader.open(); reply(true); }
  };
  chrome.runtime.onMessage.addListener(messageListener);
}
