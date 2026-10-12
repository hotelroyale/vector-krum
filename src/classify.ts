// Image classification: a heuristic that picks one of the three image types.
import { Image, dist2 } from './image.js';
import { ImageType } from './presets.js';

export interface Classification {
  type: ImageType;
  /** Number of quantised colors covering 95% of the pixels. */
  dominantColors: number;
  /** Fraction of edge pixels whose color is not one of the dominant colors. */
  blendedEdgeFraction: number;
}

export function classifyImage(img: Image): Classification {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const counts = new Map<number, number>();
  const keyOf = (p: number) => {
    const o = p * 4;
    return ((data[o] * 31.99) << 15) | ((data[o + 1] * 31.99) << 10) | ((data[o + 2] * 31.99) << 5) | (data[o + 3] * 31.99);
  };
  for (let p = 0; p < n; p++) {
    const k = keyOf(p);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let covered = 0;
  const dominant = new Set<number>();
  for (const [k, c] of sorted) {
    if (covered >= 0.95 * n) break;
    dominant.add(k);
    covered += c;
  }
  // Edge pixels: differ noticeably from a 4-neighbour.
  let edges = 0;
  let blended = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const isEdge =
        (x + 1 < w && dist2(data, p * 4, data, (p + 1) * 4) > 0.01) ||
        (y + 1 < h && dist2(data, p * 4, data, (p + w) * 4) > 0.01);
      if (!isEdge) continue;
      edges++;
      if (!dominant.has(keyOf(p))) blended++;
    }
  const blendedEdgeFraction = edges ? blended / edges : 0;
  const dominantColors = dominant.size;
  let type: ImageType;
  if (dominantColors > 64) type = 'photo';
  else if (blendedEdgeFraction > 0.15) type = 'logo_aa';
  else type = 'logo';
  return { type, dominantColors, blendedEdgeFraction };
}
