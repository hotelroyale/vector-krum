// Usage: crop.ts out.png x y size scale img1.png [img2.png ...] — crops the same window from each image, side by side.
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
const [out, xs, ys, ss, sc, ...files] = process.argv.slice(2);
const [x0, y0, size, S] = [xs, ys, ss, sc].map(Number);
const imgs = files.map((f) => PNG.sync.read(readFileSync(f)));
const o = new PNG({ width: imgs.length * (size * S + 4), height: size * S });
imgs.forEach((im, k) => {
  for (let y = 0; y < size * S; y++) for (let x = 0; x < size * S; x++) {
    const sx = x0 + ((x / S) | 0), sy = y0 + ((y / S) | 0);
    const q = (y * o.width + k * (size * S + 4) + x) * 4, p = (sy * im.width + sx) * 4;
    const a = im.data[p + 3] / 255;
    for (let c = 0; c < 3; c++) o.data[q + c] = im.data[p + c] * a + 255 * (1 - a);
    o.data[q + 3] = 255;
  }
});
writeFileSync(out, PNG.sync.write(o));
