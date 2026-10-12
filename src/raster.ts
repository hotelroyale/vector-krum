// Exact area-coverage rasterization of the vector image.
// Each boundary segment is accumulated once with weight (c_Q - c_P); a prefix sum along
// each row then yields, per pixel, Σ_regions coverage_r · color_r. This is the
// signed-area accumulation technique used by font-rs/stb_truetype.
import { BoundaryGraph } from './boundary.js';
import { Color } from './image.js';

export class Accumulator {
  readonly stride: number;
  readonly acc: Float64Array;

  constructor(readonly width: number, readonly height: number) {
    this.stride = width + 2;
    this.acc = new Float64Array(this.stride * height * 4);
  }

  clear(): void {
    this.acc.fill(0);
  }

  /** Accumulates the line (x0,y0)→(x1,y1); pixels to its right (for downward lines) get +w. */
  line(x0: number, y0: number, x1: number, y1: number, w: ArrayLike<number>): void {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) {
      dir = -1;
      [x0, x1] = [x1, x0];
      [y0, y1] = [y1, y0];
    }
    const { acc, stride, height } = this;
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    if (y0 < 0) x -= y0 * dxdy;
    const yStart = Math.max(0, Math.floor(y0));
    const yEnd = Math.min(height, Math.ceil(y1));
    const add = (idx: number, v: number) => {
      const o = idx * 4;
      acc[o] += v * w[0];
      acc[o + 1] += v * w[1];
      acc[o + 2] += v * w[2];
      acc[o + 3] += v * w[3];
    };
    for (let y = yStart; y < yEnd; y++) {
      const ls = y * stride;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = Math.min(x, xnext);
      const xb = Math.max(x, xnext);
      const x0floor = Math.floor(xa);
      const x0i = x0floor;
      const x1ceil = Math.ceil(xb);
      const x1i = x1ceil;
      if (x1i <= x0i + 1) {
        const xmf = 0.5 * (x + xnext) - x0floor;
        add(ls + x0i, d - d * xmf);
        add(ls + x0i + 1, d * xmf);
      } else {
        const s = 1 / (xb - xa);
        const x0f = xa - x0floor;
        const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
        const x1f = xb - x1ceil + 1;
        const am = 0.5 * s * x1f * x1f;
        add(ls + x0i, d * a0);
        if (x1i === x0i + 2) add(ls + x0i + 1, d * (1 - a0 - am));
        else {
          const a1 = s * (1.5 - x0f);
          add(ls + x0i + 1, d * (a1 - a0));
          for (let xi = x0i + 2; xi < x1i - 1; xi++) add(ls + xi, d * s);
          const a2 = a1 + (x1i - x0i - 3) * s;
          add(ls + x1i - 1, d * (1 - a2 - am));
        }
        add(ls + x1i, d * am);
      }
      x = xnext;
    }
  }

  /** Clears only the band cells (all others are never written while nodes stay in the band). */
  clearBand(band: Band): void {
    const { acc, stride } = this;
    for (let y = 0; y < this.height; y++)
      for (let k = band.rowStart[y]; k < band.rowStart[y + 1]; k++) {
        const o = (y * stride + band.xs[k]) * 4;
        acc[o] = acc[o + 1] = acc[o + 2] = acc[o + 3] = 0;
      }
  }

  /**
   * Prefix-sums each row over band cells only, writing `out` for band pixels. Valid when all
   * accumulated lines lie inside the band, since then every other cell of `acc` is zero.
   */
  resolveBand(out: Float64Array, band: Band): void {
    const { acc, stride, width } = this;
    for (let y = 0; y < this.height; y++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let k = band.rowStart[y]; k < band.rowStart[y + 1]; k++) {
        const x = band.xs[k];
        const o = (y * stride + x) * 4;
        r += acc[o];
        g += acc[o + 1];
        b += acc[o + 2];
        a += acc[o + 3];
        if (x >= width) continue;
        const q = (y * width + x) * 4;
        out[q] = r;
        out[q + 1] = g;
        out[q + 2] = b;
        out[q + 3] = a;
      }
    }
  }

  /** Prefix-sums each row into `out` (4 floats per pixel). */
  resolve(out: Float64Array): void {
    const { acc, stride, width, height } = this;
    for (let y = 0; y < height; y++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let x = 0; x < width; x++) {
        const o = (y * stride + x) * 4;
        r += acc[o];
        g += acc[o + 1];
        b += acc[o + 2];
        a += acc[o + 3];
        const q = (y * width + x) * 4;
        out[q] = r;
        out[q + 1] = g;
        out[q + 2] = b;
        out[q + 3] = a;
      }
    }
  }
}

/**
 * Pixels that can be affected by boundary motion: everything within `radius` of an initial
 * node position, plus column 0 (where the left image border's contribution enters each row).
 * Stored per row as sorted x lists so the prefix sum can skip untouched pixels.
 */
export class Band {
  readonly rowStart: Int32Array;
  readonly xs: Int32Array;

  constructor(readonly width: number, readonly height: number, nodeX: ArrayLike<number>, nodeY: ArrayLike<number>, readonly radius: number) {
    const mask = new Uint8Array((width + 1) * height);
    for (let y = 0; y < height; y++) mask[y * (width + 1)] = 1;
    for (let i = 0; i < nodeX.length; i++) {
      const x0 = Math.max(0, Math.floor(nodeX[i]) - radius);
      const x1 = Math.min(width, Math.floor(nodeX[i]) + radius);
      const y0 = Math.max(0, Math.floor(nodeY[i]) - radius);
      const y1 = Math.min(height - 1, Math.floor(nodeY[i]) + radius);
      for (let y = y0; y <= y1; y++) mask.fill(1, y * (width + 1) + x0, y * (width + 1) + x1 + 1);
    }
    const rowStart = new Int32Array(height + 1);
    const xs: number[] = [];
    for (let y = 0; y < height; y++) {
      rowStart[y] = xs.length;
      for (let x = 0; x <= width; x++) if (mask[y * (width + 1) + x]) xs.push(x);
    }
    rowStart[height] = xs.length;
    this.rowStart = rowStart;
    this.xs = Int32Array.from(xs);
  }

  get size(): number {
    return this.xs.length;
  }
}

/** Color jump across a chain: c_Q − c_P (outside the image counts as transparent black). */
export function chainWeights(g: BoundaryGraph, colors: Color[]): Float64Array[] {
  const zero: Color = [0, 0, 0, 0];
  return g.chains.map((c) => {
    const cp = c.pLabel >= 0 ? colors[c.pLabel] : zero;
    const cq = c.qLabel >= 0 ? colors[c.qLabel] : zero;
    return Float64Array.from([cq[0] - cp[0], cq[1] - cp[1], cq[2] - cp[2], cq[3] - cp[3]]);
  });
}

/** Renders the polygonal vector image (node positions x, y) into `out`. */
export function renderPolygons(
  g: BoundaryGraph,
  weights: Float64Array[],
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  acc: Accumulator,
  out: Float64Array,
  band?: Band,
): void {
  if (band) acc.clearBand(band);
  else acc.clear();
  g.chains.forEach((c, i) => {
    const w = weights[i];
    for (let k = 0; k + 1 < c.nodes.length; k++) {
      const a = c.nodes[k];
      const b = c.nodes[k + 1];
      acc.line(x[a], y[a], x[b], y[b], w);
    }
  });
  if (band) acc.resolveBand(out, band);
  else acc.resolve(out);
}
