// Sub-pixel segmentation for anti-aliased images. Starting from the pixel segmentation, small segments are merged into neighbours when
// the anti-aliasing model explains them well, smallest first; thin "beach" pixels that a neighbour
// explains for free are handed over, and diagonal-only connections are repaired. Blended fringe
// pixels thereby stay with the shape they belong to (a 2 px stroke keeps its fringe and stays one
// connected shape), and the contour smoother later places the edge inside the fringe.
import { Image, Color } from './image.js';
import { Segmentation, relabelComponents } from './segmentation.js';
import { AntiAliasOptions, dissolveBeaches, mixCost } from './antialias.js';

export interface SubPixelOptions extends AntiAliasOptions {
  /** Merge threshold on the cost increase. */
  lambdaF: number;
  /** Per-pixel threshold for handing beach pixels to a neighbour. */
  beachLambdaF?: number;
  /** Rounds per merge phase (default 20). */
  maxIterations?: number;
  /** Split long anti-aliasing fringes into their neighbours (default true). */
  splitShadows?: boolean;
}

const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];

class SubPixelSegmenter {
  readonly w: number;
  readonly h: number;
  readonly data: Float32Array;
  id: Int32Array;
  count = 0;
  alive!: Uint8Array;
  size!: Int32Array;
  /** Per segment: sum of all pixel colors (4 per segment). */
  sum!: Float64Array;
  /** Interior pixels (all 8 neighbours in the segment): count, color sums and squared sums. */
  inN!: Int32Array;
  inSum!: Float64Array;
  inSq!: Float64Array;
  colors!: Color[];
  /** Own boundary pixels plus the adjacent pixels of other segments. */
  sets!: Set<number>[];
  pixels!: number[][];
  /** Cached anti-aliasing cost of each boundary pixel. */
  cost: Float64Array;
  private nb = new Int32Array(8);

  constructor(
    img: Image,
    labels: Int32Array,
    readonly o: SubPixelOptions,
  ) {
    this.w = img.width;
    this.h = img.height;
    this.data = img.data;
    this.id = Int32Array.from(labels);
    this.cost = new Float64Array(this.w * this.h);
    this.rebuild();
  }

  /** Renumbers segments and recomputes boundary sets, interior statistics, colors and pixel costs. */
  rebuild(): void {
    const { w, h, id, data } = this;
    const remap = new Map<number, number>();
    for (let p = 0; p < id.length; p++) {
      let r = remap.get(id[p]);
      if (r === undefined) remap.set(id[p], (r = remap.size));
      id[p] = r;
    }
    const n = (this.count = remap.size);
    this.alive = new Uint8Array(n).fill(1);
    this.size = new Int32Array(n);
    this.sum = new Float64Array(4 * n);
    this.inN = new Int32Array(n);
    this.inSum = new Float64Array(4 * n);
    this.inSq = new Float64Array(4 * n);
    this.sets = Array.from({ length: n }, () => new Set<number>());
    this.pixels = Array.from({ length: n }, () => []);
    const interior: number[][] = Array.from({ length: n }, () => []);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const s = id[p];
        this.size[s]++;
        this.pixels[s].push(p);
        for (let c = 0; c < 4; c++) this.sum[s * 4 + c] += data[p * 4 + c];
        let boundary = false;
        for (let k = 0; k < 8; k++) {
          const xx = x + DX8[k];
          const yy = y + DY8[k];
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (id[q] !== s) {
            this.sets[s].add(q);
            boundary = true;
          }
        }
        if (boundary) this.sets[s].add(p);
        else {
          this.addInterior(s, p);
          interior[s].push(p);
        }
      }
    this.colors = new Array(n);
    const vals: number[] = [];
    for (let s = 0; s < n; s++) {
      const col: Color = [0, 0, 0, 0];
      if (this.inN[s] < 3) for (let c = 0; c < 4; c++) col[c] = this.sum[s * 4 + c] / this.size[s];
      else
        for (let c = 0; c < 4; c++) {
          vals.length = 0;
          for (const p of interior[s]) vals.push(data[p * 4 + c]);
          vals.sort((a, b) => a - b);
          col[c] = vals[vals.length >> 1];
        }
      this.colors[s] = col;
    }
    for (let s = 0; s < n; s++) for (const p of this.sets[s]) if (id[p] === s) this.cost[p] = this.pixelCost(p, -1, -1);
  }

  private addInterior(s: number, p: number): void {
    this.inN[s]++;
    for (let c = 0; c < 4; c++) {
      const v = this.data[p * 4 + c];
      this.inSum[s * 4 + c] += v;
      this.inSq[s * 4 + c] += v * v;
    }
  }

  /**
   * Anti-aliasing cost of pixel p, with segment `from`
   * read as `to`: the pixel's color as a blend of its own segment's color and a neighbouring
   * segment's color, with the self-weight penalties.
   */
  pixelCost(p: number, from: number, to: number): number {
    const { w, h, id, nb } = this;
    const x = p % w;
    const y = (p / w) | 0;
    const map = (s: number) => (s === from ? to : s);
    const own = map(id[p]);
    let m = 0;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX8[k];
      const yy = y + DY8[k];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const s = map(id[yy * w + xx]);
      if (s === own) continue;
      let dup = false;
      for (let i = 0; i < m; i++) if (nb[i] === s) dup = true;
      if (!dup) nb[m++] = s;
    }
    const ownColor = this.colors[own];
    if (m === 0) return mixCost(this.data, p * 4, ownColor, null, this.o);
    let best = Infinity;
    for (let i = 0; i < m; i++) best = Math.min(best, mixCost(this.data, p * 4, ownColor, this.colors[nb[i]], this.o));
    return best;
  }

  /** Squared error of segment s's interior pixels against the color of segment t. */
  interiorCost(s: number, t: number): number {
    const n = this.inN[s];
    if (n === 0) return 0;
    const col = this.colors[t];
    let r = 0;
    for (let c = 0; c < 4; c++) {
      const mean = this.inSum[s * 4 + c] / n;
      r += Math.max(0, this.inSq[s * 4 + c] - mean * mean * n) + n * (mean - col[c]) ** 2;
    }
    return r;
  }

  segmentCost(s: number): number {
    let r = this.interiorCost(s, s);
    for (const p of this.sets[s]) r += this.cost[p];
    return r;
  }

  /** Cost increase of merging s into t. */
  mergeMetric(s: number, t: number): number {
    let d = this.interiorCost(s, t) - this.segmentCost(s);
    if (d <= this.o.lambdaF) for (const p of this.sets[s]) d += this.pixelCost(p, s, t);
    return d;
  }

  /** Merges segment s into t; t keeps its color until the next rebuild. */
  merge(t: number, s: number): void {
    const { id } = this;
    for (const p of this.pixels[s]) {
      id[p] = t;
      this.pixels[t].push(p);
    }
    this.pixels[s] = [];
    this.size[t] += this.size[s];
    this.inN[t] += this.inN[s];
    for (let c = 0; c < 4; c++) {
      this.sum[t * 4 + c] += this.sum[s * 4 + c];
      this.inSum[t * 4 + c] += this.inSum[s * 4 + c];
      this.inSq[t * 4 + c] += this.inSq[s * 4 + c];
    }
    const set = this.sets[s];
    for (const p of set) this.cost[p] = this.pixelCost(p, -1, -1);
    const into = this.sets[t];
    for (const p of set) {
      if (into.has(p)) continue;
      if (id[p] === t && this.isInterior(p, t)) this.addInterior(t, p);
      else into.add(p);
    }
    this.sets[s] = new Set();
    this.alive[s] = 0;
  }

  isInterior(p: number, s: number): boolean {
    const { w, h, id } = this;
    const x = p % w;
    const y = (p / w) | 0;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX8[k];
      const yy = y + DY8[k];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      if (id[yy * w + xx] !== s) return false;
    }
    return true;
  }

  /**
   * One pass over all segments: each segment with at most
   * `maxOwn` pixels merges into the neighbour (at most `maxNeighbour` pixels) with the lowest
   * merge metric below lambda_f. Returns the number of merges.
   */
  mergeLoop(maxNeighbour: number, maxOwn: number): number {
    let merges = 0;
    const seen = new Set<number>();
    for (let s = 0; s < this.count; s++) {
      if (!this.alive[s] || this.size[s] > maxOwn) continue;
      seen.clear();
      let best = -1;
      let bestMetric = this.o.lambdaF;
      for (const p of this.sets[s]) {
        const u = this.id[p];
        if (u === s || seen.has(u)) continue;
        seen.add(u);
        if (this.size[u] > maxNeighbour) continue;
        const m = this.mergeMetric(s, u);
        if (m < bestMetric) {
          bestMetric = m;
          best = u;
        }
      }
      if (best >= 0) {
        this.merge(best, s);
        merges++;
      }
    }
    return merges;
  }

  /**
   * Beaches: in thin segments without interior pixels (on
   * average at most 1.2 of the two axis directions continue inside the segment), pixels go to
   * the neighbour that explains them best when that costs (almost) nothing.
   */
  splitAndMergeBeaches(): void {
    const { w, h, id } = this;
    const thresh = this.o.beachLambdaF ?? 1e-5;
    for (let s = 0; s < this.count; s++) {
      if (!this.alive[s] || this.inN[s] > 0) continue;
      const list = this.pixels[s].slice();
      let axes = 0;
      for (const p of list) {
        const x = p % w;
        const y = (p / w) | 0;
        const horiz = (x > 0 && id[p - 1] === s) || (x + 1 < w && id[p + 1] === s);
        const vert = (y > 0 && id[p - w] === s) || (y + 1 < h && id[p + w] === s);
        axes += +horiz + +vert;
      }
      if (axes / list.length > 1.2) continue;
      for (let changed = true; changed && list.length; ) {
        changed = false;
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i];
          const before = this.cost[p];
          const { seg, cost } = this.bestOtherSegment(p);
          if (seg >= 0 && cost - before < thresh) {
            id[p] = seg;
            this.cost[p] = cost;
            list.splice(i, 1);
            changed = true;
          }
        }
      }
    }
  }

  /** The neighbouring segment that explains pixel p best if p left its own segment. */
  private bestOtherSegment(p: number): { seg: number; cost: number } {
    const { w, h, id } = this;
    const x = p % w;
    const y = (p / w) | 0;
    const own = id[p];
    let seg = -1;
    let cost = Infinity;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX8[k];
      const yy = y + DY8[k];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const t = id[yy * w + xx];
      if (t === own || t === seg) continue;
      const c = this.pixelCost(p, own, t);
      if (c < cost) {
        cost = c;
        seg = t;
      }
    }
    return { seg, cost };
  }

  /**
   * Diagonal extrusions: wherever a segment touches itself only
   * diagonally in a 2×2 block, one of the two other pixels joins it, so that it is 4-connected.
   * In a checkerboard the diagonal along which the image is smoother wins; of the two candidate
   * pixels the one closer in color to the extruded segment's pixels is taken, unless taking it
   * would cut its own segment's corner.
   */
  performDiagonalExtrusions(): void {
    const { w, h, id, data } = this;
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : id[y * w + x]);
    const curvature = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) => {
      if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h || x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) return 0;
      const a = (y0 * w + x0) * 4;
      const b = (y1 * w + x1) * 4;
      const c = (y2 * w + x2) * 4;
      let r = 0;
      for (let k = 0; k < 4; k++) r += (data[a + k] - 2 * data[b + k] + data[c + k]) ** 2;
      return r;
    };
    // Taking pixel (x, y) away from its segment would leave that segment touching itself only
    // diagonally around the corner in direction (dx, dy).
    const cutsCorner = (x: number, y: number, dx: number, dy: number) => {
      const s = at(x, y);
      return s === at(x + dx, y) && s === at(x, y + dy) && s !== at(x + dx, y + dy);
    };
    const dist = (p: number, q: number) => {
      let r = 0;
      for (let k = 0; k < 4; k++) r += (data[p * 4 + k] - data[q * 4 + k]) ** 2;
      return r;
    };
    for (let y = 0; y + 1 < h; y++)
      for (let x = 0; x + 1 < w; x++) {
        const a = at(x, y);
        const b = at(x + 1, y);
        const c = at(x, y + 1);
        const d = at(x + 1, y + 1);
        if (d === b || a === b || a === c || d === c || (b !== c && a !== d)) continue;
        // Which diagonal to connect: a–d (main) or b–c (anti).
        let main = a === d;
        if (a === d && b === c) {
          const along = (dx: number, dy: number) =>
            curvature(x - dx, y - dy, x, y, x + dx, y + dy) +
            curvature(x + 1 - dx, y - dy, x + 1, y, x + 1 + dx, y + dy) +
            curvature(x - dx, y + 1 - dy, x, y + 1, x + dx, y + 1 + dy) +
            curvature(x + 1 - dx, y + 1 - dy, x + 1, y + 1, x + 1 + dx, y + 1 + dy);
          const sMain = along(1, 1);
          const sAnti = along(1, -1);
          if (sMain === sAnti) continue;
          main = sMain < sAnti;
        }
        // Candidates: for a–d the pixels b (x+1, y) and c (x, y+1); for b–c the pixels a and d.
        const seg = main ? a : b;
        const [p1x, p1y, d1x, d1y, p2x, p2y] = main ? [x + 1, y, 1, -1, x, y + 1] : [x, y, -1, -1, x + 1, y + 1];
        const bad1 = cutsCorner(p1x, p1y, d1x, d1y);
        const bad2 = cutsCorner(p2x, p2y, -d1x, -d1y);
        if (bad1 && bad2) continue;
        const p1 = p1y * w + p1x;
        const p2 = p2y * w + p2x;
        let target = bad1 ? p2 : p1;
        if (!bad1 && !bad2) {
          const [q1, q2] = main ? [y * w + x, (y + 1) * w + x + 1] : [y * w + x + 1, (y + 1) * w + x];
          target = dist(q1, p1) + dist(q2, p1) <= dist(q1, p2) + dist(q2, p2) ? p1 : p2;
        }
        id[target] = seg;
      }
  }

  /**
   * Color clustering: a segment without real interior (fewer than 3 interior
   * pixels) takes the color of one of the 100 largest segments if that lowers its cost by more
   * than `margin`. Large segments always keep their own colors.
   */
  clusterColors(margin: number): void {
    const big = [...this.inN.keys()]
      .filter((s) => this.alive[s] && this.inN[s] > 2)
      .sort((a, b) => this.inN[b] - this.inN[a] || b - a)
      .slice(0, 100);
    if (big.length === 0) return;
    for (let s = 0; s < this.count; s++) {
      if (!this.alive[s] || this.inN[s] >= 3) continue;
      let limit = this.segmentCost(s) - margin;
      let best = s;
      for (const b of big) {
        const ic = this.interiorCost(s, b);
        if (ic >= limit) continue;
        let bc = 0;
        for (const p of this.sets[s]) {
          bc += this.pixelCost(p, s, b);
          if (ic + bc >= limit) break;
        }
        if (ic + bc < limit) {
          limit = ic + bc;
          best = b;
        }
      }
      if (best !== s) this.colors[s] = [...this.colors[best]] as Color;
    }
  }

  /** Palette snapping: every segment takes the nearest palette color. */
  snapColorsToPalette(palette: Color[]): void {
    for (let s = 0; s < this.count; s++) {
      let best = palette[0];
      let bd = Infinity;
      for (const c of palette) {
        let d = 0;
        for (let k = 0; k < 4; k++) d += (this.colors[s][k] - c[k]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      this.colors[s] = [...best] as Color;
    }
  }

  /** All merge phases, beaches and diagonal extrusions. */
  execute(): void {
    const N = this.o.maxIterations ?? 20;
    const INF = Number.MAX_SAFE_INTEGER;
    // Grow small segments bottom-up: segments of size ≤ k merge with neighbours of size ≤ k.
    for (let i = 0, m = this.mergeLoop(1, 1); m > 0 && i < N; i++) m = this.mergeLoop(i + 2, i + 2);
    this.rebuild();
    for (let i = 0, m = this.mergeLoop(INF, 1); m > 0 && i < N; i++) m = this.mergeLoop(INF, i + 2);
    for (let i = 0; i < N && this.mergeLoop(INF, INF) > 0; i++);
    this.splitAndMergeBeaches();
    this.performDiagonalExtrusions();
    this.rebuild();
    for (let i = 0; i < N && this.mergeLoop(INF, 4) > 0; i++);
    this.rebuild();
  }
}

export interface SubPixelColorOptions {
  /** Color clustering margin; undefined = no clustering. */
  clusterMargin?: number;
  /** Fixed palette that all segment colors snap to. */
  palette?: Color[];
}

/**
 * Sub-pixel segmentation of an anti-aliased image, starting from a pixel segmentation, followed
 * by color clustering and palette snapping. Returns 4-connected segments
 * with their colors.
 */
export function subPixelSegment(img: Image, seg: Segmentation, o: SubPixelOptions, color: SubPixelColorOptions = {}): Segmentation {
  let sp = new SubPixelSegmenter(img, seg.labels, o);
  sp.execute();
  if (o.splitShadows ?? true) {
    // Long fringe segments (where the merge threshold, a total over the segment, is exceeded although
    // every pixel is a cheap blend of its neighbours) are split pixel by pixel.
    const flat = relabelComponents(img.width, img.height, sp.id);
    const flatColors: Color[] = new Array(flat.count);
    for (let p = 0; p < sp.id.length; p++) flatColors[flat.labels[p]] = sp.colors[sp.id[p]];
    const split = dissolveBeaches(img, { ...flat, colors: flatColors }, flatColors, o);
    sp = new SubPixelSegmenter(img, split.labels, o);
    for (let i = 0; i < (o.maxIterations ?? 20) && sp.mergeLoop(Number.MAX_SAFE_INTEGER, 4) > 0; i++);
    sp.rebuild();
  }
  if (color.clusterMargin !== undefined) sp.clusterColors(color.clusterMargin);
  if (color.palette) sp.snapColorsToPalette(color.palette);
  const rel = relabelComponents(img.width, img.height, sp.id);
  const colors: Color[] = new Array(rel.count);
  for (let p = 0; p < sp.id.length; p++) colors[rel.labels[p]] = sp.colors[sp.id[p]];
  return { ...rel, colors };
}
