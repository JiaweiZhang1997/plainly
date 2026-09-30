import { initialCrop, moveCrop, resizeCrop, type CropBox, type CropCorner } from './icon-crop.ts';

// Images are decoded and cropped locally; only the small confirmed PNG is saved.
export async function prepareTriggerIcon(file: File): Promise<string | undefined> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(file.type)) throw new Error('请选择 PNG、JPG、WebP、GIF、SVG 或 ICO 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB，请选择更小的图片。');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch { throw new Error('无法读取这张图片，请换一张有效图片。'); }
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片没有有效尺寸，请换一张图片。');
    if (img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error('图片尺寸过大，请缩小到 4000 万像素以内。');
    return await cropImage(img);
  } finally { URL.revokeObjectURL(url); }
}

function cropImage(img: HTMLImageElement): Promise<string | undefined> {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const dialog = get<HTMLDialogElement>('icon-crop-dialog');
  const canvas = get<HTMLCanvasElement>('icon-crop-canvas'), preview = get<HTMLCanvasElement>('icon-crop-preview');
  const selection = get<HTMLDivElement>('icon-crop-selection'), stage = canvas.parentElement!;
  const ctx = canvas.getContext('2d'), previewCtx = preview.getContext('2d');
  if (!ctx || !previewCtx) throw new Error('当前浏览器无法处理图片。');
  const width = img.naturalWidth, height = img.naturalHeight;
  let box = initialCrop(width, height);
  let drag: { id: number; x: number; y: number; box: CropBox; corner?: CropCorner } | undefined;
  const events = new AbortController(), options = { signal: events.signal };
  const scale = Math.min(1, 1000 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  stage.style.aspectRatio = `${width} / ${height}`; stage.style.maxWidth = `${320 * width / height}px`;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  function render() {
    selection.style.left = `${box.x / width * 100}%`; selection.style.top = `${box.y / height * 100}%`;
    selection.style.width = `${box.size / width * 100}%`; selection.style.height = `${box.size / height * 100}%`;
    previewCtx!.clearRect(0, 0, 64, 64); previewCtx!.imageSmoothingEnabled = true; previewCtx!.imageSmoothingQuality = 'high';
    previewCtx!.drawImage(img, box.x, box.y, box.size, box.size, 0, 0, 64, 64);
  }
  function endDrag() {
    const previous = drag; drag = undefined;
    if (previous && selection.hasPointerCapture(previous.id)) selection.releasePointerCapture(previous.id);
  }
  render(); dialog.returnValue = ''; dialog.showModal();
  return new Promise((resolve, reject) => {
    let output: string | undefined;
    dialog.addEventListener('close', () => { endDrag(); events.abort(); resolve(output); }, { ...options, once: true });
    get('icon-crop-cancel').addEventListener('click', () => dialog.close(), options);
    get('icon-crop-apply').addEventListener('click', () => {
      try { output = preview.toDataURL('image/png'); dialog.close(); }
      catch { reject(new Error('无法保存裁剪结果，请换一张图片。')); dialog.close(); }
    }, options);
    get('icon-crop-reset').addEventListener('click', () => { box = initialCrop(width, height); render(); }, options);
    selection.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      const corner = (e.target as HTMLElement).closest<HTMLElement>('[data-crop-corner]')?.dataset.cropCorner as CropCorner | undefined;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, box: { ...box }, corner };
      selection.setPointerCapture(e.pointerId);
    }, options);
    selection.addEventListener('pointermove', e => {
      if (!drag || drag.id !== e.pointerId) return;
      const ratio = width / canvas.getBoundingClientRect().width;
      const dx = (e.clientX - drag.x) * ratio, dy = (e.clientY - drag.y) * ratio;
      box = drag.corner ? resizeCrop(width, height, drag.box, drag.corner, dx, dy) : moveCrop(width, height, drag.box, dx, dy);
      render();
    }, options);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) selection.addEventListener(name, endDrag, options);
    selection.addEventListener('keydown', e => {
      const step = (e.shiftKey ? 20 : 2) * width / canvas.getBoundingClientRect().width;
      const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (!delta[e.key]) return;
      e.preventDefault();
      const corner = (e.target as HTMLElement).dataset.cropCorner as CropCorner | undefined;
      box = corner ? resizeCrop(width, height, box, corner, ...delta[e.key]) : moveCrop(width, height, box, ...delta[e.key]); render();
    }, options);
    window.addEventListener('resize', endDrag, options);
    window.addEventListener('pagehide', () => dialog.close(), { ...options, once: true });
    get('icon-crop-apply').focus();
  });
}
