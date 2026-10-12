// Usage: compare.ts input.png output.svg out.png  — side by side (original | vector render) at 2x, prints mean abs diff
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
const [inp, svg, out] = process.argv.slice(2);
const a = PNG.sync.read(readFileSync(inp));
const r = new Resvg(readFileSync(svg, 'utf8'), { fitTo: { mode: 'width', value: a.width } }).render();
const px = r.pixels; // getter copies on every access
// Compare premultiplied values: RGB under alpha 0 is arbitrary and must not count.
const pm = (d: Uint8Array | Buffer, i: number) => (i % 4 === 3 ? d[i] : (d[i] * d[i - (i % 4) + 3]) / 255);
let d = 0; for (let i = 0; i < a.data.length; i++) d += Math.abs(pm(a.data, i) - pm(px, i));
console.log('mean abs diff (0-255, premultiplied):', (d / a.data.length).toFixed(2));
const S = 2, W = a.width, H = a.height, o = new PNG({ width: W * 2 * S + 8, height: H * S });
for (let y = 0; y < H * S; y++) for (let x = 0; x < o.width; x++) {
  const q = (y * o.width + x) * 4; let src: Uint8Array | Buffer | null = null, sx = 0;
  if (x < W * S) { src = a.data; sx = (x / S) | 0; } else if (x >= W * S + 8) { src = px; sx = ((x - W * S - 8) / S) | 0; }
  const checker = ((x >> 4) + (y >> 4)) % 2 ? 230 : 255;
  if (!src) { o.data.set([128, 128, 128, 255], q); continue; }
  const p = (((y / S) | 0) * W + sx) * 4, al = src[p + 3] / 255;
  for (let c = 0; c < 3; c++) o.data[q + c] = src[p + c] * al + checker * (1 - al);
  o.data[q + 3] = 255;
}
writeFileSync(out, PNG.sync.write(o));
