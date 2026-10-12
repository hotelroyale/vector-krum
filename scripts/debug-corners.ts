// Prints corner-detection scores for each chain of an image (diagnostics for punctureCorners).
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { fromRgba8 } from '../src/image.js';
import { vectorize } from '../src/index.js';
const png = PNG.sync.read(readFileSync(process.argv[2]));
const r = vectorize(fromRgba8(png.width, png.height, png.data), {});
const g = r.graph;
for (const [ci, c] of g.chains.entries()) {
  const n = c.nodes, k = c.closed ? n.length - 1 : n.length;
  const at = (i: number) => n[((i % k) + k) % k];
  const rows: string[] = [];
  const turn = (a: number, b: number, d: number) => {
    let t = Math.atan2(g.y[d] - g.y[b], g.x[d] - g.x[b]) - Math.atan2(g.y[b] - g.y[a], g.x[b] - g.x[a]);
    while (t > Math.PI) t -= 2 * Math.PI; while (t < -Math.PI) t += 2 * Math.PI;
    return Math.abs(t);
  };
  for (let i = 0; i < k; i++) {
    const s3 = turn(at(i - 3), at(i), at(i + 3)), s6 = turn(at(i - 6), at(i), at(i + 6));
    if (s3 > 0.9) rows.push(`${i}:${s3.toFixed(2)}/${s6.toFixed(2)}${g.flags[at(i)] & 8 ? '*' : ''}`);
  }
  if (rows.length) console.log(`chain ${ci} (${k} nodes${c.closed ? ', closed' : ''}):`, rows.join(' '));
}
