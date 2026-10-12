// Boundary tracing (BoundaryTracer): segment boundaries are traced on the pixel-corner
// lattice and split at junctions into chains. Each chain is shared by the two regions it
// separates, so the final shapes abut exactly without gaps or overlaps.
import { Segmentation } from './segmentation.js';

export const NODE_JUNCTION = 1;
export const NODE_FIX_X = 2;
export const NODE_FIX_Y = 4;
export const NODE_CORNER = 8;

export interface Chain {
  /** Node indices along the chain. Closed chains repeat the first node at the end. */
  nodes: number[];
  /** Region on the perp(d) = (-dy, dx) side of the traversal direction; -1 = outside the image. */
  pLabel: number;
  qLabel: number;
  closed: boolean;
}

export interface BoundaryGraph {
  width: number;
  height: number;
  x: Float64Array;
  y: Float64Array;
  x0: Float64Array;
  y0: Float64Array;
  flags: Uint8Array;
  chains: Chain[];
  regionCount: number;
}

export function traceBoundaries(seg: Segmentation): BoundaryGraph {
  const { width: W, height: H, labels } = seg;
  const lab = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : labels[y * W + x]);
  const vid = (x: number, y: number) => y * (W + 1) + x;
  // Edge ids: horizontal edges (x,y)-(x+1,y) first, then vertical edges (x,y)-(x,y+1).
  const nH = W * (H + 1);
  const hEdge = (x: number, y: number) => y * W + x;
  const vEdge = (x: number, y: number) => nH + y * (W + 1) + x;
  const isH = (x: number, y: number) => x >= 0 && x < W && y >= 0 && y <= H && lab(x, y - 1) !== lab(x, y);
  const isV = (x: number, y: number) => x >= 0 && x <= W && y >= 0 && y < H && lab(x - 1, y) !== lab(x, y);

  /** Boundary edges incident to a vertex as [edgeId, otherX, otherY]. */
  const incident = (x: number, y: number): [number, number, number][] => {
    const out: [number, number, number][] = [];
    if (isH(x - 1, y)) out.push([hEdge(x - 1, y), x - 1, y]);
    if (isH(x, y)) out.push([hEdge(x, y), x + 1, y]);
    if (isV(x, y - 1)) out.push([vEdge(x, y - 1), x, y - 1]);
    if (isV(x, y)) out.push([vEdge(x, y), x, y + 1]);
    return out;
  };
  const isImageCorner = (x: number, y: number) => (x === 0 || x === W) && (y === 0 || y === H);

  const nodeOf = new Int32Array((W + 1) * (H + 1)).fill(-1);
  const xs: number[] = [];
  const ys: number[] = [];
  const flags: number[] = [];
  const node = (x: number, y: number): number => {
    const v = vid(x, y);
    if (nodeOf[v] === -1) {
      nodeOf[v] = xs.length;
      xs.push(x);
      ys.push(y);
      const deg = incident(x, y).length;
      let f = 0;
      if (deg !== 2 || isImageCorner(x, y)) f |= NODE_JUNCTION;
      if (x === 0 || x === W) f |= NODE_FIX_X;
      if (y === 0 || y === H) f |= NODE_FIX_Y;
      flags.push(f);
    }
    return nodeOf[v];
  };

  /** Region on the perp side when walking from (ax,ay) to (bx,by). */
  const sideLabels = (ax: number, ay: number, bx: number, by: number): [number, number] => {
    if (ay === by) {
      const x = Math.min(ax, bx);
      return bx > ax ? [lab(x, ay), lab(x, ay - 1)] : [lab(x, ay - 1), lab(x, ay)];
    }
    const y = Math.min(ay, by);
    return by > ay ? [lab(ax - 1, y), lab(ax, y)] : [lab(ax, y), lab(ax - 1, y)];
  };

  const visited = new Uint8Array(nH + (W + 1) * H);
  const chains: Chain[] = [];

  const walk = (sx: number, sy: number, first: [number, number, number]): Chain => {
    const nodes = [node(sx, sy)];
    const [pLabel, qLabel] = sideLabels(sx, sy, first[1], first[2]);
    let [e, x, y] = first;
    visited[e] = 1;
    for (;;) {
      nodes.push(node(x, y));
      if (flags[nodeOf[vid(x, y)]] & NODE_JUNCTION) break;
      const next = incident(x, y).find(([id]) => !visited[id]);
      if (!next) break; // closed loop returned to its start
      [e, x, y] = next;
      visited[e] = 1;
    }
    const closed = nodes.length > 2 && nodes[0] === nodes[nodes.length - 1] && !(flags[nodes[0]] & NODE_JUNCTION);
    return { nodes, pLabel, qLabel, closed };
  };

  // Chains that start and end at junctions.
  for (let y = 0; y <= H; y++)
    for (let x = 0; x <= W; x++) {
      const inc = incident(x, y);
      if (inc.length === 0 || !(inc.length !== 2 || isImageCorner(x, y))) continue;
      node(x, y);
      for (const e of inc) if (!visited[e[0]]) chains.push(walk(x, y, e));
    }
  // Remaining boundaries are closed loops without junctions.
  for (let y = 0; y <= H; y++)
    for (let x = 0; x <= W; x++)
      for (const e of incident(x, y)) if (!visited[e[0]]) chains.push(walk(x, y, e));

  return {
    width: W,
    height: H,
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    x0: Float64Array.from(xs),
    y0: Float64Array.from(ys),
    flags: Uint8Array.from(flags),
    chains,
    regionCount: seg.count,
  };
}

/** Oriented reference to a chain: reversed chains are walked backwards. */
export interface ChainRef {
  chain: number;
  reversed: boolean;
}

/**
 * Links a region's chains into closed loops, each oriented so the region lies on the perp
 * side. Because every vertex has equal in- and out-degree, a greedy walk always closes.
 */
export function regionLoops(g: BoundaryGraph): ChainRef[][][] {
  const perRegion: ChainRef[][] = Array.from({ length: g.regionCount }, () => []);
  g.chains.forEach((c, i) => {
    if (c.pLabel >= 0) perRegion[c.pLabel].push({ chain: i, reversed: false });
    if (c.qLabel >= 0) perRegion[c.qLabel].push({ chain: i, reversed: true });
  });
  const start = (r: ChainRef) => {
    const n = g.chains[r.chain].nodes;
    return r.reversed ? n[n.length - 1] : n[0];
  };
  const end = (r: ChainRef) => {
    const n = g.chains[r.chain].nodes;
    return r.reversed ? n[0] : n[n.length - 1];
  };
  return perRegion.map((refs) => {
    const byStart = new Map<number, ChainRef[]>();
    for (const r of refs) {
      const s = start(r);
      if (!byStart.has(s)) byStart.set(s, []);
      byStart.get(s)!.push(r);
    }
    const loops: ChainRef[][] = [];
    for (const r0 of refs) {
      const list = byStart.get(start(r0))!;
      const idx = list.indexOf(r0);
      if (idx === -1) continue; // already used
      list.splice(idx, 1);
      const loop = [r0];
      const origin = start(r0);
      let v = end(r0);
      while (v !== origin) {
        const next = byStart.get(v)?.pop();
        if (!next) break; // should not happen for a valid boundary
        loop.push(next);
        v = end(next);
      }
      loops.push(loop);
    }
    return loops;
  });
}
