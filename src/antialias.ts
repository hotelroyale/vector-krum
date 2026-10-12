// Anti-aliasing model (SubPixelSegmentation / WeightsFinder): a pixel near a boundary is
// explained as a blend of its own segment's color and a neighbouring segment's color.
// Thin "beach" segments made of such blends are dissolved into the shapes they separate.
import { Image, Color } from './image.js';
import { Segmentation, relabelComponents, segmentSizes } from './segmentation.js';

export interface AntiAliasOptions {
  lambdaF: number;
  selfWeightEps: number;
  selfWeightPenaltyLow: number;
  selfWeightPenaltyHigh: number;
}

/**
 * Cost of explaining pixel color `p` as (1 - t) * own + t * other, with t = the projection of
 * p onto the segment own→other (regularised toward 0.5 for nearly equal colors), clamped to
 * [0, 1]. Own weight w = 1 - t is penalised: low * (1 - w) + high * max(0, eps - w).
 */
export function mixCost(px: ArrayLike<number>, po: number, own: Color, other: Color | null, o: AntiAliasOptions): number {
  let t = 0;
  if (other) {
    let dd = 0;
    let dp = 0;
    for (let c = 0; c < 4; c++) {
      const d = other[c] - own[c];
      dd += d * d;
      dp += (px[po + c] - own[c]) * d;
    }
    if (dd > 0) {
      t = dp / dd;
      t += (1 - 2 * t) * (0.01 / (dd + 0.02));
      t = Math.min(1, Math.max(0, t));
    }
  }
  let r = 0;
  for (let c = 0; c < 4; c++) {
    const pred = own[c] + t * ((other ? other[c] : own[c]) - own[c]);
    const d = px[po + c] - pred;
    r += d * d;
  }
  const wSelf = 1 - t;
  let pen = 0;
  if (wSelf < 1) pen += (1 - wSelf) * o.selfWeightPenaltyLow;
  if (wSelf < o.selfWeightEps) pen += (o.selfWeightEps - wSelf) * o.selfWeightPenaltyHigh;
  return r + pen;
}

/** Segments present in the 5x5 neighbourhood of pixel p (the "24-connected" neighbourhood). */
function nearbySegments(seg: Segmentation, p: number, exclude: number, out: Set<number>): void {
  out.clear();
  const { width: w, height: h, labels } = seg;
  const x0 = p % w;
  const y0 = (p / w) | 0;
  for (let dy = -2; dy <= 2; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const x = x0 + dx;
      if (x < 0 || x >= w) continue;
      const l = labels[y * w + x];
      if (l !== exclude) out.add(l);
    }
  }
}

/** Best mixture cost for pixel p belonging to `own`, mixing with any segment in `partners`. */
function bestOwnCost(img: Image, p: number, own: Color, partners: Iterable<number>, colors: Color[], o: AntiAliasOptions): number {
  let best = mixCost(img.data, p * 4, own, null, o);
  for (const s of partners) best = Math.min(best, mixCost(img.data, p * 4, own, colors[s], o));
  return best;
}

/** Fraction of a segment's pixels that have all 8 neighbours inside the segment. */
function interiorFractions(seg: Segmentation, sizes: Int32Array): Float64Array {
  const { width: w, height: h, labels } = seg;
  const interior = new Float64Array(seg.count);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const l = labels[p];
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (labels[p + dy * w + dx] !== l) {
            ok = false;
            break;
          }
      if (ok) interior[l]++;
    }
  for (let s = 0; s < seg.count; s++) interior[s] /= sizes[s];
  return interior;
}

/**
 * Dissolves segments that are better explained as anti-aliasing blends of their neighbours.
 * Each pixel of a dissolved segment goes to the
 * neighbouring segment that explains it best, so the boundary ends up in the middle of the blend.
 */
export function dissolveBeaches(img: Image, seg: Segmentation, colors: Color[], o: AntiAliasOptions, maxPasses = 4): Segmentation {
  const { width: w, height: h } = seg;
  let labels = seg.labels;
  let count = seg.count;
  const near = new Set<number>();
  for (let pass = 0; pass < maxPasses; pass++) {
    const cur: Segmentation = { width: w, height: h, labels, count, colors };
    const sizes = segmentSizes(cur);
    const interior = interiorFractions(cur, sizes);
    const pixelsOf: number[][] = Array.from({ length: count }, () => []);
    for (let p = 0; p < labels.length; p++) pixelsOf[labels[p]].push(p);
    const order = [...pixelsOf.keys()].filter((s) => interior[s] < 0.25).sort((a, b) => sizes[a] - sizes[b]);
    const candidate = new Uint8Array(count);
    for (const s of order) candidate[s] = 1;
    const dissolved = new Uint8Array(count);
    const received = new Uint8Array(count);
    let changes = 0;
    for (const s of order) {
      if (received[s]) continue; // its pixel set changed this pass; reconsider next pass
      const pix = pixelsOf[s];
      let before = 0;
      let after = 0;
      const target = new Int32Array(pix.length);
      for (let i = 0; i < pix.length; i++) {
        const p = pix[i];
        nearbySegments(cur, p, s, near);
        for (const d of near) if (dissolved[d]) near.delete(d);
        before += bestOwnCost(img, p, colors[s], near, colors, o);
        if (near.size === 0) {
          after = Infinity;
          break;
        }
        // Reassign to the segment that explains the pixel best. Prefer solid (non-beach)
        // segments: otherwise fringe pixels just merge with each other into fringe clusters.
        let targets: Iterable<number> = near;
        const solid = [...near].filter((b) => !candidate[b]);
        if (solid.length > 0) targets = solid;
        let bestCost = Infinity;
        let bestSeg = -1;
        for (const b of targets) {
          const partners = [...near].filter((x) => x !== b);
          const c = bestOwnCost(img, p, colors[b], partners, colors, o);
          if (c < bestCost) {
            bestCost = c;
            bestSeg = b;
          }
        }
        after += bestCost;
        target[i] = bestSeg;
      }
      if ((after - before) / pix.length < o.lambdaF * 0.1) {
        for (let i = 0; i < pix.length; i++) {
          labels[pix[i]] = target[i];
          received[target[i]] = 1;
        }
        dissolved[s] = 1;
        changes++;
      }
    }
    if (changes === 0) break;
    const rel = relabelComponents(w, h, labels);
    // Carry colors over to the new numbering.
    const newColors: Color[] = new Array(rel.count);
    for (let p = 0; p < labels.length; p++) newColors[rel.labels[p]] = colors[labels[p]];
    labels = rel.labels;
    count = rel.count;
    colors = newColors;
  }
  return { width: w, height: h, labels, count, colors };
}
