// Pixel-level segmentation (PixelSegmenter): greedy region merging with Ward's
// criterion against a geometrically rising threshold λ, plus boundary pixel swaps.
import { Image, Color, dist2 } from './image.js';

export interface Segmentation {
  width: number;
  height: number;
  /** Segment id per pixel, 0..count-1. */
  labels: Int32Array;
  count: number;
  colors: Color[];
}

export interface SegmenterOptions {
  maxIterations: number;
  lambdaInitial: number;
  lambdaFinal: number;
  riseFraction: number;
  minNumPixels: number;
  sizePenaltyWeight: number;
  sizePenaltyPower: number;
}

/** Running per-segment statistics with union-find redirects. */
class SegmentStats {
  parent: Int32Array;
  n: Int32Array;
  sum: Float64Array;

  constructor(img: Image) {
    const np = img.width * img.height;
    this.parent = new Int32Array(np);
    this.n = new Int32Array(np).fill(1);
    this.sum = new Float64Array(np * 4);
    for (let p = 0; p < np; p++) {
      this.parent[p] = p;
      for (let c = 0; c < 4; c++) this.sum[p * 4 + c] = img.data[p * 4 + c];
    }
  }

  find(a: number): number {
    const parent = this.parent;
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  }

  /** Increase in total squared error if a and b were merged (Ward), minus the optional size bonus. */
  mergeMetric(a: number, b: number, sizeWeight: number, sizePower: number): number {
    const { n, sum } = this;
    const na = n[a];
    const nb = n[b];
    let sa = 0;
    let sb = 0;
    let sab = 0;
    for (let c = 0; c < 4; c++) {
      const x = sum[a * 4 + c];
      const y = sum[b * 4 + c];
      sa += x * x;
      sb += y * y;
      sab += (x + y) * (x + y);
    }
    let m = sa / na + sb / nb - sab / (na + nb);
    if (sizeWeight > 0)
      m -= sizeWeight * (na ** -sizePower + nb ** -sizePower - (na + nb) ** -sizePower);
    return m;
  }

  merge(a: number, b: number): number {
    if (this.n[a] < this.n[b]) [a, b] = [b, a];
    this.parent[b] = a;
    this.n[a] += this.n[b];
    for (let c = 0; c < 4; c++) this.sum[a * 4 + c] += this.sum[b * 4 + c];
    return a;
  }

  /** Squared distance from pixel color to segment mean. */
  distToMean(img: Image, p: number, s: number): number {
    const inv = 1 / this.n[s];
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const v = img.data[p * 4 + c] - this.sum[s * 4 + c] * inv;
      d += v * v;
    }
    return d;
  }

  move(img: Image, p: number, from: number, to: number): void {
    this.n[from]--;
    this.n[to]++;
    for (let c = 0; c < 4; c++) {
      const v = img.data[p * 4 + c];
      this.sum[from * 4 + c] -= v;
      this.sum[to * 4 + c] += v;
    }
  }
}

export function pixelSegment(img: Image, opts: SegmenterOptions): Segmentation {
  const { width: w, height: h } = img;
  const stats = new SegmentStats(img);
  // Pixel -> segment (may point at a redirected id; always resolve with find()).
  const label = new Int32Array(w * h);
  for (let p = 0; p < label.length; p++) label[p] = p;

  const rampIters = Math.max(1, Math.round(opts.maxIterations * opts.riseFraction));
  const factor = Math.exp(Math.log(opts.lambdaFinal / opts.lambdaInitial) / rampIters);
  let lambda = opts.lambdaInitial;

  const consider = (p: number, q: number, atFinal: boolean): void => {
    const a = stats.find(label[p]);
    const b = stats.find(label[q]);
    if (a === b) return;
    const m = stats.mergeMetric(a, b, opts.sizePenaltyWeight, opts.sizePenaltyPower);
    const tooSmall = atFinal && (stats.n[a] < opts.minNumPixels || stats.n[b] < opts.minNumPixels);
    if (m < lambda || tooSmall) {
      const r = stats.merge(a, b);
      label[p] = r;
      label[q] = r;
      return;
    }
    // Swap a boundary pixel into the neighbouring segment if its mean fits better.
    if (stats.n[a] > 1 && stats.distToMean(img, p, b) + 1e-9 < stats.distToMean(img, p, a)) {
      stats.move(img, p, a, b);
      label[p] = b;
    } else if (stats.n[b] > 1 && stats.distToMean(img, q, a) + 1e-9 < stats.distToMean(img, q, b)) {
      stats.move(img, q, b, a);
      label[q] = a;
    }
  };

  for (let it = 0; it < opts.maxIterations; it++) {
    const atFinal = lambda >= opts.lambdaFinal;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (x + 1 < w) consider(p, p + 1, atFinal);
        if (y + 1 < h) consider(p, p + w, atFinal);
      }
    lambda = Math.min(opts.lambdaFinal, lambda * factor);
  }

  for (let p = 0; p < label.length; p++) label[p] = stats.find(label[p]);
  let seg = relabelComponents(w, h, label);
  seg = mergeSmallSegments(img, seg, opts.minNumPixels);
  return seg;
}

/** Splits labels into 4-connected components and renumbers them 0..count-1. */
export function relabelComponents(w: number, h: number, labels: Int32Array): Segmentation {
  const out = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  let count = 0;
  for (let s = 0; s < out.length; s++) {
    if (out[s] !== -1) continue;
    const l = labels[s];
    out[s] = count;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb)
        if (q >= 0 && q < out.length && out[q] === -1 && labels[q] === l) {
          out[q] = count;
          stack.push(q);
        }
    }
    count++;
  }
  return { width: w, height: h, labels: out, count, colors: [] };
}

/** Merges every segment smaller than minPixels into the neighbour that increases the error least. */
export function mergeSmallSegments(img: Image, seg: Segmentation, minPixels: number): Segmentation {
  const { width: w, height: h } = seg;
  if (minPixels > 1) {
    const stats = new SegmentStats(img);
    // Re-seed stats with the current labels: one root per segment.
    const root = new Int32Array(seg.count).fill(-1);
    for (let p = 0; p < seg.labels.length; p++) {
      const l = seg.labels[p];
      if (root[l] === -1) root[l] = p;
      else stats.merge(stats.find(root[l]), stats.find(p));
    }
    const label = new Int32Array(seg.labels.length);
    for (let p = 0; p < label.length; p++) label[p] = stats.find(p);

    let changed = true;
    while (changed) {
      changed = false;
      // Smallest segments first.
      const best = new Map<number, { to: number; m: number }>();
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          const a = stats.find(label[p]);
          for (const q of [x + 1 < w ? p + 1 : -1, y + 1 < h ? p + w : -1]) {
            if (q < 0) continue;
            const b = stats.find(label[q]);
            if (a === b) continue;
            const m = stats.mergeMetric(a, b, 0, 1);
            for (const [s, t] of [[a, b], [b, a]])
              if (stats.n[s] < minPixels) {
                const cur = best.get(s);
                if (!cur || m < cur.m) best.set(s, { to: t, m });
              }
          }
        }
      const order = [...best.keys()].sort((s, t) => stats.n[s] - stats.n[t]);
      for (const s of order) {
        const a = stats.find(s);
        const b = stats.find(best.get(s)!.to);
        if (a !== b && stats.n[a] < minPixels) {
          stats.merge(a, b);
          changed = true;
        }
      }
    }
    for (let p = 0; p < label.length; p++) label[p] = stats.find(label[p]);
    seg = relabelComponents(w, h, label);
  }
  seg.colors = segmentMeans(img, seg);
  return seg;
}

export function segmentMeans(img: Image, seg: Segmentation): Color[] {
  const acc = new Float64Array(seg.count * 5);
  for (let p = 0; p < seg.labels.length; p++) {
    const l = seg.labels[p];
    for (let c = 0; c < 4; c++) acc[l * 5 + c] += img.data[p * 4 + c];
    acc[l * 5 + 4]++;
  }
  const out: Color[] = [];
  for (let s = 0; s < seg.count; s++) {
    const n = acc[s * 5 + 4] || 1;
    out.push([acc[s * 5] / n, acc[s * 5 + 1] / n, acc[s * 5 + 2] / n, acc[s * 5 + 3] / n]);
  }
  return out;
}

/**
 * Per-segment color from interior pixels only (all 8 neighbours in the same segment),
 * using the per-channel median. Falls back to the mean.
 */
export function segmentInteriorMedians(img: Image, seg: Segmentation): Color[] {
  const { width: w, height: h, labels } = seg;
  const buckets: number[][][] = Array.from({ length: seg.count }, () => [[], [], [], []]);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const l = labels[p];
      let interior = true;
      for (let dy = -1; dy <= 1 && interior; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (labels[p + dy * w + dx] !== l) {
            interior = false;
            break;
          }
      if (interior) for (let c = 0; c < 4; c++) buckets[l][c].push(img.data[p * 4 + c]);
    }
  const means = segmentMeans(img, seg);
  return buckets.map((b, s) => {
    if (b[0].length === 0) return means[s];
    return b.map((vals) => {
      vals.sort((u, v) => u - v);
      return vals[vals.length >> 1];
    }) as Color;
  });
}

/** Merges adjacent segments that have exactly the same color and renumbers. */
export function mergeEqualNeighbours(img: Image, seg: Segmentation): Segmentation {
  const key = (c: Color) => c.map((v) => Math.round(v * 1e6)).join(',');
  const keys = seg.colors.map(key);
  const parent = Int32Array.from({ length: seg.count }, (_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const { width: w, height: h, labels } = seg;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      for (const q of [x + 1 < w ? p + 1 : -1, y + 1 < h ? p + w : -1]) {
        if (q < 0) continue;
        const a = labels[p];
        const b = labels[q];
        if (a !== b && keys[a] === keys[b]) parent[find(a)] = find(b);
      }
    }
  const merged = new Int32Array(labels.length);
  for (let p = 0; p < labels.length; p++) merged[p] = find(labels[p]);
  const out = relabelComponents(w, h, merged);
  out.colors = new Array(out.count);
  for (let p = 0; p < labels.length; p++) out.colors[out.labels[p]] = seg.colors[labels[p]];
  return out;
}

/** Flexible-palette color clustering: similar colors are unified. */
export function clusterColors(seg: Segmentation, margin: number, sizes: Int32Array): Color[] {
  const order = [...seg.colors.keys()].sort((a, b) => sizes[b] - sizes[a]);
  const centers: { c: Float64Array; w: number }[] = [];
  const assign = new Int32Array(seg.count);
  const m2 = margin * margin;
  for (const s of order) {
    const col = seg.colors[s];
    let found = -1;
    for (let k = 0; k < centers.length; k++)
      if (dist2(col, 0, centers[k].c, 0) < m2) {
        found = k;
        break;
      }
    if (found === -1) {
      centers.push({ c: Float64Array.from(col), w: sizes[s] });
      found = centers.length - 1;
    } else {
      const ce = centers[found];
      const wt = sizes[s];
      for (let ch = 0; ch < 4; ch++) ce.c[ch] = (ce.c[ch] * ce.w + col[ch] * wt) / (ce.w + wt);
      ce.w += wt;
    }
    assign[s] = found;
  }
  return seg.colors.map((_, s) => Array.from(centers[assign[s]].c) as Color);
}

export function snapToPalette(seg: Segmentation, palette: Color[]): Color[] {
  return seg.colors.map((col) => {
    let best = palette[0];
    let bd = Infinity;
    for (const p of palette) {
      const d = dist2(col, 0, p, 0);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return [...best] as Color;
  });
}

export function segmentSizes(seg: Segmentation): Int32Array {
  const n = new Int32Array(seg.count);
  for (let p = 0; p < seg.labels.length; p++) n[seg.labels[p]]++;
  return n;
}
