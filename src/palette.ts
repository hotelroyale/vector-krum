// Palette selection (PaletteFinder): edge-weighted color histogram, weighted k-means,
// and model selection with score = log10(cost + 1) + (K - 2) * cost_per_color.
import { Image, Color, dist2 } from './image.js';

export interface PaletteOptions {
  costPerColor: number;
  edgeWeightScale: number;
  edgeWeightFloor: number;
}

export interface ScoredPalette {
  colors: Color[];
  cost: number;
  score: number;
}

/** Pixels on strong edges (usually anti-aliasing blends) get a small weight (EdgeImage). */
export function edgeWeights(img: Image, scale: number, floor: number): Float32Array {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let g = 0;
      if (x > 0) g = Math.max(g, dist2(data, p * 4, data, (p - 1) * 4));
      if (x < w - 1) g = Math.max(g, dist2(data, p * 4, data, (p + 1) * 4));
      if (y > 0) g = Math.max(g, dist2(data, p * 4, data, (p - w) * 4));
      if (y < h - 1) g = Math.max(g, dist2(data, p * 4, data, (p + w) * 4));
      out[p] = Math.max(floor, Math.exp(-scale * g));
    }
  return out;
}

interface Histogram {
  colors: Float64Array; // weighted mean color per occupied bin
  weights: Float64Array;
  count: number;
}

function buildHistogram(img: Image, weights: Float32Array): Histogram {
  const bins = new Map<number, number>();
  const sums: number[] = [];
  const d = img.data;
  for (let p = 0; p < weights.length; p++) {
    const o = p * 4;
    const key =
      (Math.min(15, (d[o] * 16) | 0) << 12) |
      (Math.min(15, (d[o + 1] * 16) | 0) << 8) |
      (Math.min(15, (d[o + 2] * 16) | 0) << 4) |
      Math.min(15, (d[o + 3] * 16) | 0);
    let b = bins.get(key);
    if (b === undefined) {
      b = bins.size;
      bins.set(key, b);
      sums.push(0, 0, 0, 0, 0);
    }
    const wt = weights[p];
    sums[b * 5] += d[o] * wt;
    sums[b * 5 + 1] += d[o + 1] * wt;
    sums[b * 5 + 2] += d[o + 2] * wt;
    sums[b * 5 + 3] += d[o + 3] * wt;
    sums[b * 5 + 4] += wt;
  }
  const n = bins.size;
  const colors = new Float64Array(n * 4);
  const ws = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    const wt = sums[b * 5 + 4];
    ws[b] = wt;
    for (let c = 0; c < 4; c++) colors[b * 4 + c] = sums[b * 5 + c] / wt;
  }
  return { colors, weights: ws, count: n };
}

function kMeans(hist: Histogram, k: number, maxIter = 50): Float64Array {
  const { colors, weights, count } = hist;
  k = Math.min(k, count);
  const centers = new Float64Array(k * 4);
  // Deterministic k-means++ style seeding: heaviest bin, then maximise weight * distance².
  let best = 0;
  for (let b = 1; b < count; b++) if (weights[b] > weights[best]) best = b;
  centers.set(colors.subarray(best * 4, best * 4 + 4), 0);
  const dmin = new Float64Array(count).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let arg = 0;
    let max = -1;
    for (let b = 0; b < count; b++) {
      dmin[b] = Math.min(dmin[b], dist2(colors, b * 4, centers, (c - 1) * 4));
      const v = dmin[b] * Math.sqrt(weights[b]);
      if (v > max) {
        max = v;
        arg = b;
      }
    }
    centers.set(colors.subarray(arg * 4, arg * 4 + 4), c * 4);
  }
  const assign = new Int32Array(count);
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (let b = 0; b < count; b++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = dist2(colors, b * 4, centers, c * 4);
        if (dd < bd) {
          bd = dd;
          bi = c;
        }
      }
      if (assign[b] !== bi || it === 0) changed = true;
      assign[b] = bi;
    }
    const acc = new Float64Array(k * 5);
    for (let b = 0; b < count; b++) {
      const c = assign[b];
      for (let ch = 0; ch < 4; ch++) acc[c * 5 + ch] += colors[b * 4 + ch] * weights[b];
      acc[c * 5 + 4] += weights[b];
    }
    for (let c = 0; c < k; c++)
      if (acc[c * 5 + 4] > 0) for (let ch = 0; ch < 4; ch++) centers[c * 4 + ch] = acc[c * 5 + ch] / acc[c * 5 + 4];
    if (!changed) break;
  }
  return centers;
}

/**
 * The most common color of each k-means cluster (its heaviest histogram bin). When a palette has
 * fewer colors than the image, a cluster spans several distinct colors and its mean is a blend
 * that appears nowhere in the image (blue + purple → grey-violet); the dominant color is a color
 * the image actually uses.
 */
function dominantColors(hist: Histogram, centers: Float64Array): Float64Array {
  const k = centers.length / 4;
  const out = Float64Array.from(centers);
  const heaviest = new Float64Array(k).fill(-1);
  for (let b = 0; b < hist.count; b++) {
    let bi = 0;
    let bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dd = dist2(hist.colors, b * 4, centers, c * 4);
      if (dd < bd) {
        bd = dd;
        bi = c;
      }
    }
    if (hist.weights[b] > heaviest[bi]) {
      heaviest[bi] = hist.weights[b];
      out.set(hist.colors.subarray(b * 4, b * 4 + 4), bi * 4);
    }
  }
  return out;
}

function paletteCost(img: Image, weights: Float32Array, centers: Float64Array): number {
  const k = centers.length / 4;
  let cost = 0;
  for (let p = 0; p < weights.length; p++) {
    let bd = Infinity;
    for (let c = 0; c < k; c++) bd = Math.min(bd, dist2(img.data, p * 4, centers, c * 4));
    cost += bd * weights[p];
  }
  return cost;
}

function toColors(centers: Float64Array): Color[] {
  const out: Color[] = [];
  for (let i = 0; i < centers.length; i += 4)
    out.push([centers[i], centers[i + 1], centers[i + 2], centers[i + 3]].map((v) => Math.round(v * 255) / 255) as Color);
  return out;
}

export function findPalette(img: Image, k: number, opts: PaletteOptions, weights?: Float32Array): ScoredPalette {
  weights ??= edgeWeights(img, opts.edgeWeightScale, opts.edgeWeightFloor);
  const hist = buildHistogram(img, weights);
  const centers = kMeans(hist, k);
  // Model selection scores the k-means fit; the colors handed out are the
  // clusters' dominant colors.
  const cost = paletteCost(img, weights, centers);
  const colors = toColors(dominantColors(hist, centers));
  return { colors, cost, score: Math.log10(cost + 1) + (colors.length - 2) * opts.costPerColor };
}

/** Palettes for K = 2..maxColors (fewer if the image has fewer distinct colors). */
export function scanPalettes(img: Image, opts: PaletteOptions, maxColors = 24): ScoredPalette[] {
  const weights = edgeWeights(img, opts.edgeWeightScale, opts.edgeWeightFloor);
  const out: ScoredPalette[] = [];
  for (let k = 2; k <= maxColors; k++) {
    const cand = findPalette(img, k, opts, weights);
    out.push(cand);
    if (cand.colors.length < k) break; // fewer distinct histogram bins than k
  }
  return out;
}

/**
 * The palette with the lowest score over K = 2..maxColors (findOptimalNumColors). The score is
 * not unimodal: images with many small color areas improve sharply once K covers them all, so
 * every K is evaluated rather than stopping at the first local minimum.
 */
export function findOptimalPalette(img: Image, opts: PaletteOptions, maxColors = 24): ScoredPalette {
  return bestPalette(scanPalettes(img, opts, maxColors));
}

export function bestPalette(palettes: ScoredPalette[]): ScoredPalette {
  return palettes.reduce((b, p) => (p.score < b.score ? p : b));
}
