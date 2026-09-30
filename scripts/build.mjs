import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const store = process.argv.includes('--store');
const out = store ? 'store-dist' : 'dist';
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/icons`, { recursive: true });
await cp('LICENSE', `${out}/LICENSE`);
await cp('public', out, { recursive: true, filter: source => !store || !source.endsWith('/reading-logo.png') });
const questionMark = (await readFile('public/question-mark.svg', 'utf8')).trim();
for (const file of ['options.html', 'popup.html', 'pdf.html']) {
  const html = await readFile(`public/${file}`, 'utf8');
  await writeFile(`${out}/${file}`, html.replaceAll('<!--question-mark-->', questionMark));
}
const panelHtml = (await readFile(`${out}/popup.html`, 'utf8')).replace('class="popup"', 'class="popup sidepanel"').replace('<!--sidepanel-instructions-->', '<p class="popup-intro">选中文字，右键选择“在侧栏解释 / 翻译”。</p>');
await writeFile(`${out}/sidepanel.html`, panelHtml);
const common = { bundle: true, target: 'chrome120', minify: true, sourcemap: false, legalComments: 'eof', plugins: [{ name: 'optional-local-icon', setup(b) {
  b.onResolve({ filter: /reading-logo\.png$/ }, () => ({ path: 'reading-logo', namespace: 'local-icon' }));
  b.onLoad({ filter: /.*/, namespace: 'local-icon' }, async () => {
    const path = 'public/icons/reading-logo.png';
    const data = !store && existsSync(path) ? 'data:image/png;base64,' + (await readFile(path)).toString('base64') : '';
    return { contents: 'export default ' + JSON.stringify(data) + ';', loader: 'js' };
  });
} }], loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl' } };
await build({ ...common, entryPoints: ['src/background.ts','src/options.ts','src/popup.ts'], outdir: out, format: 'esm' });
await build({ ...common, entryPoints: ['src/content.ts'], outfile: `${out}/content.js`, format: 'iife' });
await build({ ...common, entryPoints: ['src/search-entry.ts'], outfile: `${out}/search.js`, format: 'iife' });
await build({ ...common, entryPoints: ['src/pdf.ts'], outfile: `${out}/pdf.js`, format: 'esm' });
await cp('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', `${out}/pdf.worker.mjs`);
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(`node_modules/pdfjs-dist/${folder}`, `${out}/pdf-assets/${folder}`, { recursive: true });
await cp('node_modules/pdfjs-dist/LICENSE', `${out}/pdf-assets/LICENSE`);
// Render the same question-mark geometry into antialiased toolbar PNGs, without a runtime dependency.
const coordinates = questionMark.match(/ d="([^"]+)"/)[1].match(/[-+]?\d*\.?\d+/g).map(Number);
const stroke = Number(questionMark.match(/stroke-width="([^"]+)"/)[1]);
const circle = questionMark.match(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/).slice(1).map(Number);
const angle = -Number(questionMark.match(/rotate\(([-\d.]+)/)[1]) * Math.PI / 180;
const curve = []; let [sx, sy] = coordinates;
for (let i = 2; i < coordinates.length; i += 6) {
  const [ax, ay, bx, by, ex, ey] = coordinates.slice(i, i + 6);
  for (let n = 0; n <= 64; n++) { const t = n / 64, u = 1 - t; curve.push([u*u*u*sx + 3*u*u*t*ax + 3*u*t*t*bx + t*t*t*ex, u*u*u*sy + 3*u*u*t*ay + 3*u*t*t*by + t*t*t*ey]); }
  sx = ex; sy = ey;
}
function onMark(x, y) {
  const px = Math.cos(angle)*(x-12) - Math.sin(angle)*(y-12) + 12;
  const py = Math.sin(angle)*(x-12) + Math.cos(angle)*(y-12) + 12;
  if ((px-circle[0])**2 + (py-circle[1])**2 <= circle[2]**2) return true;
  if (px < 5 || px > 18 || py < 2 || py > 17) return false;
  return curve.some(([cx, cy]) => (px-cx)**2 + (py-cy)**2 <= (stroke/2)**2);
}
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([n, t, data, c]); }
for (const size of [16,32,48,128]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    let count = 0, light = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const padding = size === 128 ? 16 : 0, art = size - padding * 2;
      const px = (x+(sx+.5)/4-padding)*24/art, py = (y+(sy+.5)/4-padding)*24/art;
      const dx = Math.max(6.8-px,0,px-17.2), dy = Math.max(6.8-py,0,py-17.2);
      if (dx*dx + dy*dy > 36) continue;
      count++; if (onMark(px, py)) light++;
    }
    const blend = count ? light/count : 0;
    pixels.set([Math.round(30+(246-30)*blend), Math.round(38+(248-38)*blend), Math.round(38+(246-38)*blend), Math.round(count/16*255)], i);
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  await writeFile(`${out}/icons/${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
console.log(`Built Plainly → ${out}/`);
