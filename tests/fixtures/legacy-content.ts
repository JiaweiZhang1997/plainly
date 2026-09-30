// Reproduce the pre-fix lifecycle: anonymous page listeners survive a new
// controller, can re-mount their reader, and have no extension-owner tag.
import { ExplainCard } from '../../src/card.ts';
import { rpc } from '../../src/client.ts';
import type { PublicSettings } from '../../src/core.ts';
void (async () => {
  const card = new ExplainCard(await rpc<PublicSettings>('publicSettings'));
  document.addEventListener('pointerup', () => {
    setTimeout(() => {
      const selection = getSelection();
      if (!selection?.rangeCount || !selection.toString().trim()) return;
      const range = selection.getRangeAt(0);
      card.setSelection(selection.toString().trim(), '', range.getBoundingClientRect());
      card.showTrigger();
    }, 100);
  });
})();
