// Contour smoothing (ContourSmoother + GenerativeModel + Optimizer): node positions are
// optimised with nonlinear conjugate gradient against
//   E = Σ_nodes strength · [ sqrt(2 − 2cosθ + 0.001) + lengthPenalty · (|d₂| − |d₁|)² ]   (angular prior)
//     + measurement
// where measurement 0 tethers nodes to their pixel-lattice positions and measurement 1 is
// the generative model 0.5 · Σ_pixels ‖render(nodes) − image‖².
import { BoundaryGraph, NODE_CORNER, NODE_FIX_X, NODE_FIX_Y, NODE_JUNCTION, regionLoops } from './boundary.js';
import { Image, Color } from './image.js';
import { Accumulator, Band, chainWeights, renderPolygons } from './raster.js';
import { PhaseSettings } from './presets.js';

export interface SmoothOptions {
  phases: PhaseSettings[];
  punctureFlatnessThresh: number;
  punctureCornerThresh: number;
  maxStepSize: number;
}

const ANGLE_EPS = 0.001;
/** Generative-model pixels are evaluated within this distance of the initial boundary. */
export const BAND_RADIUS = 4;
/** Nodes may move at most this far from their lattice position (keeps lines inside the band). */
export const MAX_DISPLACEMENT = BAND_RADIUS - 1;

/** Consecutive node triples (a, b, c) along every chain; b is the node the prior acts on. */
export function chainTriples(g: BoundaryGraph): Int32Array {
  const t: number[] = [];
  for (const c of g.chains) {
    const n = c.nodes;
    if (c.closed) {
      const k = n.length - 1;
      for (let i = 0; i < k; i++) t.push(n[(i - 1 + k) % k], n[i], n[(i + 1) % k]);
    } else for (let i = 1; i + 1 < n.length; i++) t.push(n[i - 1], n[i], n[i + 1]);
  }
  return Int32Array.from(t);
}

export interface EnergyTerms {
  prior: number;
  measurement: number;
}

export class ContourEnergy {
  readonly triples: Int32Array;
  private readonly acc: Accumulator;
  private readonly rendered: Float64Array;
  private readonly weights: Float64Array[];
  private readonly band: Band;
  phase!: PhaseSettings;

  constructor(readonly g: BoundaryGraph, readonly img: Image, readonly colors: Color[]) {
    this.triples = chainTriples(g);
    this.acc = new Accumulator(g.width, g.height);
    this.rendered = new Float64Array(g.width * g.height * 4);
    this.weights = chainWeights(g, colors);
    this.band = new Band(g.width, g.height, g.x0, g.y0, BAND_RADIUS);
  }

  /** Evaluates the energy at (x, y); if gx/gy are given, writes the gradient into them. */
  eval(x: Float64Array, y: Float64Array, gx?: Float64Array, gy?: Float64Array): EnergyTerms {
    if (gx && gy) {
      gx.fill(0);
      gy.fill(0);
    }
    const prior = this.prior(x, y, gx, gy);
    const measurement = this.phase.measurement === 0 ? this.tether(x, y, gx, gy) : this.generative(x, y, gx, gy);
    return { prior, measurement };
  }

  private prior(x: Float64Array, y: Float64Array, gx?: Float64Array, gy?: Float64Array): number {
    const { triples } = this;
    const flags = this.g.flags;
    const s = this.phase.priorStrength;
    const lw = this.phase.lengthPenalty;
    let e = 0;
    for (let i = 0; i < triples.length; i += 3) {
      const a = triples[i];
      const b = triples[i + 1];
      const c = triples[i + 2];
      if (flags[b] & NODE_CORNER) continue;
      const d1x = x[b] - x[a];
      const d1y = y[b] - y[a];
      const d2x = x[c] - x[b];
      const d2y = y[c] - y[b];
      const l1 = Math.hypot(d1x, d1y);
      const l2 = Math.hypot(d2x, d2y);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const ux = d1x / l1;
      const uy = d1y / l1;
      const vx = d2x / l2;
      const vy = d2y / l2;
      const cos = ux * vx + uy * vy;
      const f = Math.sqrt(Math.max(0, 2 - 2 * cos) + ANGLE_EPS);
      const dl = l2 - l1;
      e += s * (f + lw * dl * dl);
      if (!gx || !gy) continue;
      // d(cos)/da = −(v − cos·u)/l1, d(cos)/dc = (u − cos·v)/l2, d(cos)/db = −(da + dc)
      const kf = -s / f; // d f / d cos = −1/f
      const gax = kf * (-(vx - cos * ux) / l1);
      const gay = kf * (-(vy - cos * uy) / l1);
      const gcx = kf * ((ux - cos * vx) / l2);
      const gcy = kf * ((uy - cos * vy) / l2);
      // Length term: d l1/da = −u, d l1/db = u, d l2/db = −v, d l2/dc = v
      const kl = 2 * s * lw * dl;
      gx[a] += gax + kl * ux;
      gy[a] += gay + kl * uy;
      gx[c] += gcx + kl * vx;
      gy[c] += gcy + kl * vy;
      gx[b] += -gax - gcx + kl * (-vx - ux);
      gy[b] += -gay - gcy + kl * (-vy - uy);
    }
    return e;
  }

  private tether(x: Float64Array, y: Float64Array, gx?: Float64Array, gy?: Float64Array): number {
    const { x0, y0 } = this.g;
    let e = 0;
    for (let i = 0; i < x.length; i++) {
      const dx = x[i] - x0[i];
      const dy = y[i] - y0[i];
      e += dx * dx + dy * dy;
      if (gx && gy) {
        gx[i] += 2 * dx;
        gy[i] += 2 * dy;
      }
    }
    return e;
  }

  /**
   * Renders the current polygons and returns the residual image render − input. Only band
   * pixels are valid; pixels outside the band cannot change, so they only add a constant.
   */
  residual(x: Float64Array, y: Float64Array): Float64Array {
    renderPolygons(this.g, this.weights, x, y, this.acc, this.rendered, this.band);
    const r = this.rendered;
    const d = this.img.data;
    const { rowStart, xs } = this.band;
    const W = this.g.width;
    for (let row = 0; row < this.g.height; row++)
      for (let k = rowStart[row]; k < rowStart[row + 1]; k++) {
        if (xs[k] >= W) continue;
        const o = (row * W + xs[k]) * 4;
        r[o] -= d[o];
        r[o + 1] -= d[o + 1];
        r[o + 2] -= d[o + 2];
        r[o + 3] -= d[o + 3];
      }
    return r;
  }

  private generative(x: Float64Array, y: Float64Array, gx?: Float64Array, gy?: Float64Array): number {
    const r = this.residual(x, y);
    const { rowStart, xs } = this.band;
    const { width: W, height: H } = this.g;
    let e = 0;
    for (let row = 0; row < H; row++)
      for (let k = rowStart[row]; k < rowStart[row + 1]; k++) {
        if (xs[k] >= W) continue;
        const o = (row * W + xs[k]) * 4;
        e += r[o] * r[o] + r[o + 1] * r[o + 1] + r[o + 2] * r[o + 2] + r[o + 3] * r[o + 3];
      }
    e *= 0.5;
    if (!gx || !gy) return e;
    // Shape derivative: moving a boundary point by δ toward the P side grows region Q, so
    // dE/dδ = r(pixel) · (c_Q − c_P) per unit length. Integrate along each segment.
    const sample = (px: number, py: number, w: Float64Array): number => {
      const ix = Math.min(W - 1, Math.max(0, Math.floor(px)));
      const iy = Math.min(H - 1, Math.max(0, Math.floor(py)));
      const o = (iy * W + ix) * 4;
      return r[o] * w[0] + r[o + 1] * w[1] + r[o + 2] * w[2] + r[o + 3] * w[3];
    };
    this.g.chains.forEach((c, ci) => {
      const w = this.weights[ci];
      for (let k = 0; k + 1 < c.nodes.length; k++) {
        const a = c.nodes[k];
        const b = c.nodes[k + 1];
        const dx = x[b] - x[a];
        const dy = y[b] - y[a];
        const len = Math.hypot(dx, dy);
        if (len < 1e-12) continue;
        const nx = -dy / len; // unit normal toward the P side
        const ny = dx / len;
        const m = Math.max(2, Math.ceil(len * 4));
        const ds = len / m;
        let fa = 0;
        let fb = 0;
        for (let j = 0; j < m; j++) {
          const t = (j + 0.5) / m;
          const px = x[a] + t * dx;
          const py = y[a] + t * dy;
          // Average both sides: on pixel edges the derivative is one-sided.
          const f = 0.5 * (sample(px + 0.01 * nx, py + 0.01 * ny, w) + sample(px - 0.01 * nx, py - 0.01 * ny, w));
          fa += f * (1 - t) * ds;
          fb += f * t * ds;
        }
        gx[a] += fa * nx;
        gy[a] += fa * ny;
        gx[b] += fb * nx;
        gy[b] += fb * ny;
      }
    });
    return e;
  }
}

export interface PhaseLog {
  phase: number;
  iterations: number;
  energy: number;
  corners: number;
}

/**
 * Sub-pixel initialisation. For each chain node,
 * the 2x2 pixels around it are unmixed into the chain's two region colors; where a pixel's
 * measured share of region P differs from its label, the node is pulled toward (or pushed
 * away from) that pixel's center: Δ = 0.5 · Σ (α_measured − α_label) · (center − node),
 * clamped to ±1/3 px. This starts blended corners sharp instead of notched.
 */
export function initializeNodePositions(g: BoundaryGraph, img: Image, colors: Color[], labels: Int32Array): void {
  const { width: W, height: H } = g;
  const done = new Uint8Array(g.x.length);
  for (const c of g.chains) {
    if (c.pLabel < 0 || c.qLabel < 0) continue;
    const cp = colors[c.pLabel];
    const cq = colors[c.qLabel];
    let dd = 0;
    for (let k = 0; k < 4; k++) dd += (cp[k] - cq[k]) ** 2;
    if (dd < 1e-6) continue;
    for (const v of c.nodes) {
      if (done[v] || g.flags[v] & (NODE_JUNCTION | NODE_FIX_X | NODE_FIX_Y)) continue;
      done[v] = 1;
      const vx = g.x0[v];
      const vy = g.y0[v];
      let sx = 0;
      let sy = 0;
      for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const px = vx + ox;
        const py = vy + oy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const p = py * W + px;
        const l = labels[p];
        if (l !== c.pLabel && l !== c.qLabel) continue;
        let t = 0;
        for (let k = 0; k < 4; k++) t += (img.data[p * 4 + k] - cq[k]) * (cp[k] - cq[k]);
        const alpha = Math.min(1, Math.max(0, t / dd));
        const delta = alpha - (l === c.pLabel ? 1 : 0);
        sx += delta * (ox + 0.5);
        sy += delta * (oy + 0.5);
      }
      g.x[v] = vx + Math.min(1 / 3, Math.max(-1 / 3, 0.5 * sx));
      g.y[v] = vy + Math.min(1 / 3, Math.max(-1 / 3, 0.5 * sy));
    }
  }
}

export function smoothContours(g: BoundaryGraph, img: Image, colors: Color[], opts: SmoothOptions, labels?: Int32Array): PhaseLog[] {
  if (labels && opts.phases.some((p) => p.enabled && p.measurement === 1)) initializeNodePositions(g, img, colors, labels);
  const energy = new ContourEnergy(g, img, colors);
  const logs: PhaseLog[] = [];
  opts.phases.forEach((phase, i) => {
    if (!phase.enabled) return;
    energy.phase = phase;
    const { iterations, value } = minimizeCG(g, energy, phase, opts.maxStepSize);
    let corners = 0;
    if (phase.punctureCorners) corners = punctureCorners(g);
    logs.push({ phase: i, iterations, energy: value, corners });
  });
  return logs;
}

/** Polak–Ribière nonlinear CG with Armijo backtracking and a per-node step limit. */
function minimizeCG(g: BoundaryGraph, energy: ContourEnergy, phase: PhaseSettings, maxStep: number) {
  const n = g.x.length;
  const freeX = new Float64Array(n);
  const freeY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    freeX[i] = g.flags[i] & NODE_FIX_X ? 0 : 1;
    freeY[i] = g.flags[i] & NODE_FIX_Y ? 0 : 1;
  }
  const W = g.width;
  const H = g.height;
  const total = (t: EnergyTerms) => t.prior + t.measurement;
  const gx = new Float64Array(n);
  const gy = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const pgx = new Float64Array(n);
  const pgy = new Float64Array(n);

  const grad = () => {
    const e = total(energy.eval(g.x, g.y, gx, gy));
    for (let i = 0; i < n; i++) {
      gx[i] *= freeX[i];
      gy[i] *= freeY[i];
    }
    return e;
  };
  let e = grad();
  for (let i = 0; i < n; i++) {
    dx[i] = -gx[i];
    dy[i] = -gy[i];
  }
  let alphaPrev = Infinity;
  let it = 0;
  let stalls = 0;
  const restartEvery = 10;
  for (; it < phase.maxIter; it++) {
    let maxD = 0;
    let slope = 0;
    for (let i = 0; i < n; i++) {
      maxD = Math.max(maxD, Math.hypot(dx[i], dy[i]));
      slope += gx[i] * dx[i] + gy[i] * dy[i];
    }
    if (maxD < 1e-12) break;
    if (slope >= 0) {
      // Not a descent direction: restart with steepest descent.
      for (let i = 0; i < n; i++) {
        dx[i] = -gx[i];
        dy[i] = -gy[i];
      }
      slope = 0;
      maxD = 0;
      for (let i = 0; i < n; i++) {
        slope -= gx[i] * gx[i] + gy[i] * gy[i];
        maxD = Math.max(maxD, Math.hypot(dx[i], dy[i]));
      }
      if (maxD < 1e-12) break;
    }
    let alpha = Math.min(maxStep / maxD, alphaPrev * 2);
    let eNew = Infinity;
    for (let tries = 0; tries < 20; tries++) {
      for (let i = 0; i < n; i++) {
        const lx = g.x0[i];
        const ly = g.y0[i];
        tx[i] = Math.min(W, lx + MAX_DISPLACEMENT, Math.max(0, lx - MAX_DISPLACEMENT, g.x[i] + alpha * dx[i]));
        ty[i] = Math.min(H, ly + MAX_DISPLACEMENT, Math.max(0, ly - MAX_DISPLACEMENT, g.y[i] + alpha * dy[i]));
      }
      eNew = total(energy.eval(tx, ty));
      if (eNew <= e + 1e-4 * alpha * slope) break;
      alpha *= 0.5;
    }
    if (!(eNew < e)) break; // no progress possible along this direction
    alphaPrev = alpha;
    g.x.set(tx);
    g.y.set(ty);
    pgx.set(gx);
    pgy.set(gy);
    const ePrev = e;
    e = grad();
    // Polak–Ribière+ update
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += gx[i] * (gx[i] - pgx[i]) + gy[i] * (gy[i] - pgy[i]);
      den += pgx[i] * pgx[i] + pgy[i] * pgy[i];
    }
    const beta = (it + 1) % restartEvery === 0 || den === 0 ? 0 : Math.max(0, num / den);
    for (let i = 0; i < n; i++) {
      dx[i] = -gx[i] + beta * dx[i];
      dy[i] = -gy[i] + beta * dy[i];
    }
    if (it >= phase.minIter && ePrev - e < phase.relTol * Math.abs(e)) {
      if (++stalls >= 3) break;
    } else stalls = 0;
  }
  return { iterations: it, value: e };
}

/**
 * Marks sharp corners. Every region outline is walked with a
 * window of 7 nodes; at the five inner nodes the turn is measured as c = 2 − 2·cos(angle), and
 * a decision tree (isProbablyPuncturedNode) decides from the centre turn,
 * whether it is the window's maximum and the neighbouring turns. The prior is skipped at
 * corners, so they sharpen in later phases and break Bézier runs. Returns the number of corners.
 */
export function punctureCorners(g: BoundaryGraph): number {
  let count = 0;
  for (const loops of regionLoops(g))
    for (const loop of loops) {
      const nodes: number[] = [];
      for (const r of loop) {
        const n = g.chains[r.chain].nodes;
        const seq = r.reversed ? [...n].reverse() : n;
        for (let i = 0; i < seq.length - 1; i++) nodes.push(seq[i]);
      }
      const k = nodes.length;
      if (k <= 6) continue;
      const at = (i: number) => nodes[((i % k) + k) % k];
      const dir = (a: number, b: number): [number, number] => {
        const dx = g.x[b] - g.x[a];
        const dy = g.y[b] - g.y[a];
        const l = Math.hypot(dx, dy);
        return l > 0 ? [dx / l, dy / l] : [dx, dy];
      };
      const c = new Float64Array(5);
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < 5; j++) {
          const u = dir(at(i + j - 3), at(i + j - 2));
          const v = dir(at(i + j - 2), at(i + j - 1));
          c[j] = 2 - 2 * (u[0] * v[0] + u[1] * v[1]);
        }
        const node = at(i);
        if (g.flags[node] & (NODE_JUNCTION | NODE_CORNER)) continue;
        if (isProbablyPuncturedNode(c)) {
          g.flags[node] |= NODE_CORNER;
          count++;
        }
      }
    }
  return count;
}

/**
 * Corner classifier: a decision tree over the turns c0..c4 of a 7-node window (c2 at the node
 * itself).
 */
export function isProbablyPuncturedNode(c: ArrayLike<number>): boolean {
  const centre = c[2];
  const neighbours = c[0] + c[1] + c[3] + c[4];
  // The inner neighbour with the smaller turn and the outer one on the same side, and the outer
  // one on the other side.
  const [nearSide, inner, farSide] = c[1] <= c[3] ? [c[0], c[1], c[4]] : [c[4], c[3], c[0]];
  const nearSum = nearSide + inner + farSide;
  if (centre >= 0.611194) {
    if (!(centre >= Math.max(c[0], c[1], c[3], c[4]))) return centre >= 1.72002;
    if (Math.min(c[0], c[1], c[3], c[4]) >= 0.097537) return false;
    if (centre >= 1.42496) return true;
    if (nearSum < 0.122841) return true;
    if (neighbours < 0.445642) return true;
    return farSide <= 0.0046405;
  }
  if (centre < 0.282594) return false;
  if (neighbours >= 0.322933) return false;
  if (centre >= 0.483023) return true;
  if (neighbours < 0.0286571) return true;
  return nearSum <= 0.00209524;
}
