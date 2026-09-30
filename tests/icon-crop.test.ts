import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialCrop, moveCrop, resizeCrop } from '../src/icon-crop.ts';

test('editable square stays inside portrait, landscape and tiny images while moving and resizing every corner', () => {
  for (const [width,height] of [[900,300],[300,900],[1,1],[4000,3000]]) {
    const initial = initialCrop(width,height);
    for (const dx of [-10000,0,10000]) for (const dy of [-10000,0,10000]) {
      const boxes = [moveCrop(width,height,initial,dx,dy), ...(['nw','ne','sw','se'] as const).map(c=>resizeCrop(width,height,initial,c,dx,dy))];
      for (const box of boxes) {
        assert.ok(box.size>0);assert.ok(box.x>=-1e-9&&box.y>=-1e-9);
        assert.ok(box.x+box.size<=width+1e-9&&box.y+box.size<=height+1e-9);
      }
    }
    for(const corner of ['nw','ne','sw','se'] as const) {
      const box = resizeCrop(width,height,initial,corner,-10,-10);
      assert.equal(corner.endsWith('e') ? box.x : box.x+box.size,corner.endsWith('e') ? initial.x : initial.x+initial.size);
      assert.equal(corner.startsWith('s') ? box.y : box.y+box.size,corner.startsWith('s') ? initial.y : initial.y+initial.size);
    }
  }
});
