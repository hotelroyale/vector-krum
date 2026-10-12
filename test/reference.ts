// Shape comparison between two SVGs (ours vs. the reference) for the reference tests.
// Both are rendered at the reference size and every pixel is snapped to the nearest reference
// fill color, so edges are exact label boundaries instead of anti-aliasing thresholds.
import { Resvg } from '@resvg/resvg-js';

export type Rgb = [number, number, number];

export interface Labels {
  width: number;
  height: number;
  /** Index into the palette per pixel. */
  labels: Uint16Array;
}

export interface SvgStats {
  paths: number;
  colors: number;
  /** Curve and line segments over all paths. */
  segments: number;
}

export function svgSize(svg: string): { width: number; height: number } {
  const m = svg.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/);
  if (!m) throw new Error('svg without viewBox');
  return { width: Math.round(Number(m[1])), height: Math.round(Number(m[2])) };
}

export function svgStats(svg: string): SvgStats {
  const fills = new Set<string>();
  for (const m of svg.matchAll(/<path[^>]*?fill="(#[0-9a-fA-F]{6})/g)) fills.add(m[1].toLowerCase());
  let segments = 0;
  for (const m of svg.matchAll(/<path(?![^>]*fill="none")[^>]*\sd="([^"]*)"/g)) segments += (m[1].match(/[CLQSTHVAclqsthva]/g) ?? []).length;
  // Filled shapes only (not stroke-only paths).
  return { paths: (svg.match(/<path(?![^>]*fill="none")/g) ?? []).length, colors: fills.size, segments };
}

/** Distinct fill colors of an SVG. */
export function svgPalette(svg: string): Rgb[] {
  const out = new Map<string, Rgb>();
  for (const m of svg.matchAll(/fill="#([0-9a-fA-F]{6})"/g)) {
    const h = m[1].toLowerCase();
    out.set(h, [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb);
  }
  return [...out.values()];
}

/**
 * Renders `svg` at width × height on white without anti-aliasing (so no blend colors appear)
 * and snaps every pixel to the nearest palette color.
 */
export function renderLabels(svg: string, width: number, height: number, palette: Rgb[]): Labels {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'white', shapeRendering: 0 }).render();
  if (png.width !== width || png.height !== height) throw new Error(`rendered ${png.width}x${png.height}, expected ${width}x${height}`);
  const px = png.pixels;
  const labels = new Uint16Array(width * height);
  for (let p = 0; p < labels.length; p++) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const c = palette[k];
      const d = (px[p * 4] - c[0]) ** 2 + (px[p * 4 + 1] - c[1]) ** 2 + (px[p * 4 + 2] - c[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    labels[p] = best;
  }
  return { width, height, labels };
}

/** Pixels whose right or lower neighbour has another label. */
export function edgeMap(l: Labels): Uint8Array {
  const { width: w, height: h, labels } = l;
  const e = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if ((x + 1 < w && labels[p + 1] !== labels[p]) || (y + 1 < h && labels[p + w] !== labels[p])) e[p] = 1;
    }
  return e;
}

/** Distance (in pixels, chessboard metric) to the nearest set pixel, capped at `cap`. */
function distanceTo(e: Uint8Array, w: number, h: number, cap: number): Uint8Array {
  const d = new Uint8Array(w * h).fill(cap);
  for (let p = 0; p < e.length; p++) if (e[p]) d[p] = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let v = d[p];
      if (x > 0) v = Math.min(v, d[p - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[p - w] + 1);
        if (x > 0) v = Math.min(v, d[p - w - 1] + 1);
        if (x + 1 < w) v = Math.min(v, d[p - w + 1] + 1);
      }
      d[p] = Math.min(v, cap);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let v = d[p];
      if (x + 1 < w) v = Math.min(v, d[p + 1] + 1);
      if (y + 1 < h) {
        v = Math.min(v, d[p + w] + 1);
        if (x + 1 < w) v = Math.min(v, d[p + w + 1] + 1);
        if (x > 0) v = Math.min(v, d[p + w - 1] + 1);
      }
      d[p] = Math.min(v, cap);
    }
  return d;
}

export interface EdgeAgreement {
  /** Fraction of our edge pixels within `tolerance` px of a reference edge. */
  precision: number;
  /** Fraction of reference edge pixels within `tolerance` px of one of ours. */
  recall: number;
  /** Mean distance from our edge pixels to the reference edges (capped at 10 px). */
  meanDistance: number;
  /** Our edge length / reference edge length; jagged or split outlines make it > 1. */
  lengthRatio: number;
}

export function edgeAgreement(ours: Labels, ref: Labels, tolerance = 1): EdgeAgreement {
  const { width: w, height: h } = ref;
  const eo = edgeMap(ours);
  const er = edgeMap(ref);
  const dToRef = distanceTo(er, w, h, 10);
  const dToOurs = distanceTo(eo, w, h, 10);
  let no = 0;
  let nr = 0;
  let hitO = 0;
  let hitR = 0;
  let sum = 0;
  for (let p = 0; p < eo.length; p++) {
    if (eo[p]) {
      no++;
      sum += dToRef[p];
      if (dToRef[p] <= tolerance) hitO++;
    }
    if (er[p]) {
      nr++;
      if (dToOurs[p] <= tolerance) hitR++;
    }
  }
  return { precision: hitO / no, recall: hitR / nr, meanDistance: sum / no, lengthRatio: no / nr };
}

/**
 * Area where the snapped colors differ, divided by the reference outline length: the average
 * offset between the two outlines, in render pixels. Unlike a plain pixel fraction it does not
 * depend on how much of the image is flat background.
 */
export function outlineOffset(ours: Labels, ref: Labels): number {
  let n = 0;
  for (let p = 0; p < ref.labels.length; p++) if (ours.labels[p] !== ref.labels[p]) n++;
  let len = 0;
  for (const e of edgeMap(ref)) len += e;
  return n / len;
}

export interface Components {
  /** Connected same-color regions (4-connected). */
  count: number;
  /** Regions smaller than `speckSize` pixels: fragments, specks and split-off stroke pieces. */
  specks: number;
}

export function components(l: Labels, speckSize: number): Components {
  const { width: w, height: h, labels } = l;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let count = 0;
  let specks = 0;
  for (let s = 0; s < labels.length; s++) {
    if (seen[s]) continue;
    count++;
    let size = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, p >= w ? p - w : -1, p + w < w * h ? p + w : -1])
        if (q >= 0 && !seen[q] && labels[q] === labels[p]) {
          seen[q] = 1;
          stack.push(q);
        }
    }
    if (size < speckSize) specks++;
  }
  return { count, specks };
}

/** Pixel count per palette index. */
export function areas(l: Labels, n: number): number[] {
  const a = new Array(n).fill(0);
  for (let p = 0; p < l.labels.length; p++) a[l.labels[p]]++;
  return a;
}
