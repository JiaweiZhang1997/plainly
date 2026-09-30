export interface CropBox { x: number; y: number; size: number; }
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';
export function initialCrop(width: number, height: number): CropBox {
  const size = Math.min(width, height) * .8;
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}
export function moveCrop(width: number, height: number, box: CropBox, dx: number, dy: number): CropBox {
  return { ...box, x: Math.max(0, Math.min(width - box.size, box.x + dx)), y: Math.max(0, Math.min(height - box.size, box.y + dy)) };
}
export function resizeCrop(width: number, height: number, box: CropBox, corner: CropCorner, dx: number, dy: number): CropBox {
  const sx = corner.endsWith('e') ? 1 : -1, sy = corner.startsWith('s') ? 1 : -1;
  const ax = sx > 0 ? box.x : box.x + box.size, ay = sy > 0 ? box.y : box.y + box.size;
  const max = Math.min(sx > 0 ? width - ax : ax, sy > 0 ? height - ay : ay);
  const min = Math.min(Math.min(width, height) * .05, max);
  const size = Math.max(min, Math.min(max, box.size + (sx * dx + sy * dy) / 2));
  return { x: sx > 0 ? ax : ax - size, y: sy > 0 ? ay : ay - size, size };
}
