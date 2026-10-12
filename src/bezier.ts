// Bézier fitting (BezierFitter): each chain is split at junctions and corners, then cut
// into fragments that are greedily merged while the increase in squared fitting error
// stays below a threshold that is annealed geometrically from stat_thresh_initial to
// stat_thresh_final; fragment boundaries are also shifted ("swapped") when that helps.
import { BoundaryGraph, NODE_CORNER } from './boundary.js';

export type Point = [number, number];

/** Cubic segment; `line` segments are drawn as straight lines. */
export interface Segment {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  line: boolean;
}

export interface FitResult {
  segment: Segment;
  error: number;
}

function bez(s: Segment, t: number): Point {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return [
    b0 * s.p0[0] + b1 * s.p1[0] + b2 * s.p2[0] + b3 * s.p3[0],
    b0 * s.p0[1] + b1 * s.p1[1] + b2 * s.p2[1] + b3 * s.p3[1],
  ];
}

function lineSegment(p0: Point, p3: Point): Segment {
  return {
    p0,
    p1: [p0[0] + (p3[0] - p0[0]) / 3, p0[1] + (p3[1] - p0[1]) / 3],
    p2: [p0[0] + (2 * (p3[0] - p0[0])) / 3, p0[1] + (2 * (p3[1] - p0[1])) / 3],
    p3,
    line: true,
  };
}

function chordParams(pts: Point[]): number[] {
  const t = [0];
  for (let i = 1; i < pts.length; i++) t.push(t[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = t[t.length - 1] || 1;
  return t.map((v) => v / L);
}

function sqError(s: Segment, pts: Point[], t: number[]): number {
  let e = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = bez(s, t[i]);
    e += (p[0] - pts[i][0]) ** 2 + (p[1] - pts[i][1]) ** 2;
  }
  return e;
}

/** Least-squares cubic through fixed end points. */
export function fitCubic(pts: Point[]): FitResult {
  const n = pts.length;
  const p0 = pts[0];
  const p3 = pts[n - 1];
  if (n <= 2) return { segment: lineSegment(p0, p3), error: 0 };
  let t = chordParams(pts);
  if (n === 3) {
    // Quadratic through the middle point, elevated to a cubic.
    const tm = Math.min(0.9, Math.max(0.1, t[1]));
    const u = 1 - tm;
    const q: Point = [
      (pts[1][0] - u * u * p0[0] - tm * tm * p3[0]) / (2 * tm * u),
      (pts[1][1] - u * u * p0[1] - tm * tm * p3[1]) / (2 * tm * u),
    ];
    const seg: Segment = {
      p0,
      p1: [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
      p2: [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])],
      p3,
      line: false,
    };
    return { segment: seg, error: sqError(seg, pts, t) };
  }
  let best: FitResult = { segment: lineSegment(p0, p3), error: sqError(lineSegment(p0, p3), pts, t) };
  for (let round = 0; round < 12; round++) {
    const seg = solveControlPoints(pts, t);
    if (!seg) break;
    const err = sqError(seg, pts, t);
    const improved = err < best.error * 0.999;
    if (err < best.error) best = { segment: seg, error: err };
    if (round > 0 && !improved) break;
    t = reparameterize(seg, pts, t);
  }
  return best;
}

/** Solves the 2x2 normal equations for the inner control points given parameters t. */
function solveControlPoints(pts: Point[], t: number[]): Segment | null {
  const n = pts.length;
  const p0 = pts[0];
  const p3 = pts[n - 1];
  let a11 = 0,
    a12 = 0,
    a22 = 0,
    rx1 = 0,
    ry1 = 0,
    rx2 = 0,
    ry2 = 0;
  for (let i = 0; i < n; i++) {
    const u = 1 - t[i];
    const b0 = u * u * u;
    const b1 = 3 * u * u * t[i];
    const b2 = 3 * u * t[i] * t[i];
    const b3 = t[i] ** 3;
    const qx = pts[i][0] - b0 * p0[0] - b3 * p3[0];
    const qy = pts[i][1] - b0 * p0[1] - b3 * p3[1];
    a11 += b1 * b1;
    a12 += b1 * b2;
    a22 += b2 * b2;
    rx1 += b1 * qx;
    ry1 += b1 * qy;
    rx2 += b2 * qx;
    ry2 += b2 * qy;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return null;
  return {
    p0,
    p1: [(a22 * rx1 - a12 * rx2) / det, (a22 * ry1 - a12 * ry2) / det],
    p2: [(a11 * rx2 - a12 * rx1) / det, (a11 * ry2 - a12 * ry1) / det],
    p3,
    line: false,
  };
}

/** One Newton step per parameter toward the closest point on the curve. */
function reparameterize(seg: Segment, pts: Point[], t: number[]): number[] {
  const { p0, p1, p2, p3 } = seg;
  const n = pts.length;
  return t.map((ti, i) => {
    if (i === 0 || i === n - 1) return ti;
    const u = 1 - ti;
    const p = bez(seg, ti);
    const d1x = 3 * (u * u * (p1[0] - p0[0]) + 2 * u * ti * (p2[0] - p1[0]) + ti * ti * (p3[0] - p2[0]));
    const d1y = 3 * (u * u * (p1[1] - p0[1]) + 2 * u * ti * (p2[1] - p1[1]) + ti * ti * (p3[1] - p2[1]));
    const d2x = 6 * (u * (p2[0] - 2 * p1[0] + p0[0]) + ti * (p3[0] - 2 * p2[0] + p1[0]));
    const d2y = 6 * (u * (p2[1] - 2 * p1[1] + p0[1]) + ti * (p3[1] - 2 * p2[1] + p1[1]));
    const ex = p[0] - pts[i][0];
    const ey = p[1] - pts[i][1];
    const num = ex * d1x + ey * d1y;
    const den = d1x * d1x + d1y * d1y + ex * d2x + ey * d2y;
    if (Math.abs(den) < 1e-12) return ti;
    return Math.min(1, Math.max(0, ti - num / den));
  });
}

export interface BezierOptions {
  maxIterations: number;
  statThreshInitial: number;
  statThreshFinal: number;
}

/** Fits one corner-free run of points; returns its segments in order. */
export function fitRun(pts: Point[], opts: BezierOptions): Segment[] {
  if (pts.length <= 2) return [fitCubic(pts).segment];
  const cache = new Map<number, FitResult>();
  const fit = (i: number, j: number): FitResult => {
    const key = i * 1e6 + j;
    let r = cache.get(key);
    if (!r) {
      r = fitCubic(pts.slice(i, j + 1));
      cache.set(key, r);
    }
    return r;
  };
  // Fragment boundaries (indices into pts); start with every point as a boundary.
  let cuts = pts.map((_, i) => i);
  const passes = Math.max(1, opts.maxIterations);
  const factor = Math.exp(Math.log(opts.statThreshFinal / opts.statThreshInitial) / passes);
  let thresh = opts.statThreshInitial;
  for (let pass = 0; pass < passes + 10; pass++) {
    let changed = false;
    // Merge pass.
    const next = [cuts[0]];
    for (let k = 1; k < cuts.length - 1; k++) {
      const a = next[next.length - 1];
      const b = cuts[k];
      const c = cuts[k + 1];
      const metric = fit(a, c).error - fit(a, b).error - fit(b, c).error;
      if (metric < thresh) changed = true;
      else next.push(b);
    }
    next.push(cuts[cuts.length - 1]);
    cuts = next;
    // Swap pass: shift each interior boundary by one point if that lowers the total error.
    for (let k = 1; k < cuts.length - 1; k++) {
      const a = cuts[k - 1];
      const b = cuts[k];
      const c = cuts[k + 1];
      const cur = fit(a, b).error + fit(b, c).error;
      for (const nb of [b - 1, b + 1]) {
        if (nb <= a || nb >= c) continue;
        if (fit(a, nb).error + fit(nb, c).error < cur - 1e-9) {
          cuts[k] = nb;
          changed = true;
          break;
        }
      }
    }
    if (pass < passes) thresh = Math.min(opts.statThreshFinal, thresh * factor);
    else if (!changed) break;
  }
  const segs: Segment[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const r = fit(cuts[k], cuts[k + 1]);
    // Nearly straight fragments are emitted as lines.
    const s = r.segment;
    const straight = lineDeviation(s) < 0.05;
    segs.push(straight ? lineSegment(s.p0, s.p3) : s);
  }
  return segs;
}

function lineDeviation(s: Segment): number {
  const dx = s.p3[0] - s.p0[0];
  const dy = s.p3[1] - s.p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const dist = (p: Point) => Math.abs((p[0] - s.p0[0]) * dy - (p[1] - s.p0[1]) * dx) / len;
  return Math.max(dist(s.p1), dist(s.p2));
}

/** Fits all chains; segments are oriented in each chain's node order. */
export function fitChains(g: BoundaryGraph, opts: BezierOptions): Segment[][] {
  return g.chains.map((c) => {
    let nodes = c.nodes;
    if (c.closed) {
      // Start a closed loop at a corner if it has one.
      const k = nodes.length - 1;
      const ci = nodes.slice(0, k).findIndex((n) => g.flags[n] & NODE_CORNER);
      if (ci > 0) nodes = [...nodes.slice(ci, k), ...nodes.slice(0, ci + 1)];
    }
    const pts: Point[] = nodes.map((n) => [g.x[n], g.y[n]]);
    const segs: Segment[] = [];
    let start = 0;
    for (let i = 1; i < nodes.length; i++) {
      const isBreak = i === nodes.length - 1 || g.flags[nodes[i]] & NODE_CORNER;
      if (!isBreak) continue;
      // A closed loop without corners is split in half so each run has distinct ends.
      if (c.closed && start === 0 && i === nodes.length - 1 && !(g.flags[nodes[0]] & NODE_CORNER) && i >= 4) {
        const mid = i >> 1;
        segs.push(...fitRun(pts.slice(0, mid + 1), opts), ...fitRun(pts.slice(mid, i + 1), opts));
      } else segs.push(...fitRun(pts.slice(start, i + 1), opts));
      start = i;
    }
    // If a closed chain was rotated, the caller still sees it as one loop.
    return segs;
  });
}

export function reverseSegments(segs: Segment[]): Segment[] {
  return segs
    .slice()
    .reverse()
    .map((s) => ({ p0: s.p3, p1: s.p2, p2: s.p1, p3: s.p0, line: s.line }));
}

export function flattenSegments(segs: Segment[], stepsPerSegment = 8): Point[] {
  const out: Point[] = [segs[0].p0];
  for (const s of segs) {
    const steps = s.line ? 1 : stepsPerSegment;
    for (let i = 1; i <= steps; i++) out.push(bez(s, i / steps));
  }
  return out;
}
