import { Image, Color, createImage } from '../src/image.js';

export type Shape =
  | { kind: 'circle'; cx: number; cy: number; r: number; color: Color }
  | { kind: 'polygon'; points: [number, number][]; color: Color };

function inside(s: Shape, x: number, y: number): boolean {
  if (s.kind === 'circle') return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  let c = false;
  const p = s.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if (p[i][1] > y !== p[j][1] > y && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  return c;
}

/** Paints shapes in order over a background; `samples` > 1 gives anti-aliased edges. */
export function paint(w: number, h: number, bg: Color, shapes: Shape[], samples = 1): Image {
  const img = createImage(w, h);
  const n = samples * samples;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          let col = bg;
          for (const s of shapes) if (inside(s, px, py)) col = s.color;
          for (let c = 0; c < 4; c++) acc[c] += col[c];
        }
      for (let c = 0; c < 4; c++) img.data[(y * w + x) * 4 + c] = acc[c] / n;
    }
  return img;
}

export function star(cx: number, cy: number, r1: number, r2: number, n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2;
    const r = i % 2 ? r2 : r1;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

export const WHITE: Color = [1, 1, 1, 1];
export const RED: Color = [0.85, 0.1, 0.1, 1];
export const BLUE: Color = [0.1, 0.2, 0.8, 1];
export const YELLOW: Color = [0.95, 0.8, 0.1, 1];

export function logoScene(samples: number): Image {
  return paint(96, 80, WHITE, [
    { kind: 'circle', cx: 32, cy: 40, r: 24, color: RED },
    { kind: 'polygon', points: star(64, 38, 26, 11, 5), color: BLUE },
    { kind: 'polygon', points: [[10, 70], [86, 66], [88, 76], [12, 78]], color: YELLOW },
  ], samples);
}

/** Mean absolute per-channel difference. */
export function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
