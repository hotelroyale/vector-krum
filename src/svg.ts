// SVG export. Shapes abut exactly. To hide anti-aliasing seams between neighbouring shapes, a
// shape may extend slightly under the neighbours that are drawn after it (a stroke of its own
// color along the shared boundary, always covered by the later shape), so visible edges keep their
// exact position and thin lines are not thickened.
import { BoundaryGraph, ChainRef, regionLoops } from './boundary.js';
import { Segment, reverseSegments } from './bezier.js';
import { Color } from './image.js';

export interface SvgOptions {
  /** Output units per working pixel (to undo downsampling). */
  scale: number;
  /** Width of the underlap below later-drawn neighbours, in working pixels (0 = none). */
  strokeWidth: number;
  /** Regions with alpha below this are treated as transparent and omitted. */
  alphaThreshold: number;
  /** Fill holes that are completely covered by shapes drawn later (no seams around nested shapes). */
  stacked: boolean;
}

const fmt = (v: number) => {
  const s = (Math.round(v * 100) / 100).toFixed(2);
  return s.replace(/\.?0+$/, '');
};

function hex(c: Color): string {
  return (
    '#' +
    c
      .slice(0, 3)
      .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

function loopSegments(loop: ChainRef[], curves: Segment[][]): Segment[] {
  const segs: Segment[] = [];
  for (const ref of loop) segs.push(...(ref.reversed ? reverseSegments(curves[ref.chain]) : curves[ref.chain]));
  return segs;
}

/** Signed area of a loop's polygon (node positions), via the shoelace formula. */
function loopArea(g: BoundaryGraph, loop: ChainRef[]): number {
  let a = 0;
  for (const ref of loop) {
    const n = g.chains[ref.chain].nodes;
    const order = ref.reversed ? [...n].reverse() : n;
    for (let k = 0; k + 1 < order.length; k++)
      a += g.x[order[k]] * g.y[order[k + 1]] - g.x[order[k + 1]] * g.y[order[k]];
  }
  return a / 2;
}

/**
 * Decides which holes can be dropped in stacked mode: a hole of region r may be filled if
 * every region inside it is drawn later (and opaquely), so it paints over r's fill. This
 * turns seams around nested shapes into overlaps.
 */
function droppableHoles(g: BoundaryGraph, loops: ChainRef[][][], rank: Int32Array, opaqueDrawn: (r: number) => boolean): Set<ChainRef[]> {
  const adj: Set<number>[] = Array.from({ length: g.regionCount }, () => new Set());
  for (const c of g.chains)
    if (c.pLabel >= 0 && c.qLabel >= 0) {
      adj[c.pLabel].add(c.qLabel);
      adj[c.qLabel].add(c.pLabel);
    }
  const drop = new Set<ChainRef[]>();
  loops.forEach((regionLoopsList, r) => {
    if (regionLoopsList.length < 2) return;
    const areas = regionLoopsList.map((l) => loopArea(g, l));
    let outer = 0;
    areas.forEach((a, i) => {
      if (Math.abs(a) > Math.abs(areas[outer])) outer = i;
    });
    regionLoopsList.forEach((loop, i) => {
      if (i === outer || Math.sign(areas[i]) === Math.sign(areas[outer])) return;
      // Regions inside the hole: flood the adjacency graph from the hole's neighbours, not through r.
      const seen = new Set<number>();
      const stack: number[] = [];
      for (const ref of loop) {
        const c = g.chains[ref.chain];
        const other = c.pLabel === r ? c.qLabel : c.pLabel;
        if (!seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
      let ok = true;
      while (stack.length && ok) {
        const q = stack.pop()!;
        if (q < 0 || rank[q] < rank[r] || !opaqueDrawn(q)) ok = false;
        else
          for (const nb of adj[q])
            if (nb !== r && !seen.has(nb)) {
              seen.add(nb);
              stack.push(nb);
            }
      }
      if (ok) drop.add(loop);
    });
  });
  return drop;
}

export function regionPaths(g: BoundaryGraph, curves: Segment[][], scale: number, skip?: Set<ChainRef[]>): string[] {
  const loops = regionLoops(g);
  return pathsFromLoops(loops, curves, scale, skip);
}

function pathsFromLoops(loops: ChainRef[][][], curves: Segment[][], scale: number, skip?: Set<ChainRef[]>): string[] {
  const pt = (p: [number, number]) => `${fmt(p[0] * scale)} ${fmt(p[1] * scale)}`;
  return loops.map((regionLoopsList) => {
    let d = '';
    for (const loop of regionLoopsList) {
      if (skip?.has(loop)) continue;
      const segs = loopSegments(loop, curves);
      if (segs.length === 0) continue;
      d += `M${pt(segs[0].p0)}`;
      for (const s of segs) d += s.line ? `L${pt(s.p3)}` : `C${pt(s.p1)} ${pt(s.p2)} ${pt(s.p3)}`;
      d += 'Z';
    }
    return d;
  });
}

/** Open subpaths along the given chains (for underlap strokes). */
function chainPaths(chains: number[], curves: Segment[][], scale: number): string {
  const pt = (p: [number, number]) => `${fmt(p[0] * scale)} ${fmt(p[1] * scale)}`;
  let d = '';
  for (const c of chains) {
    const segs = curves[c];
    if (segs.length === 0) continue;
    d += `M${pt(segs[0].p0)}`;
    for (const s of segs) d += s.line ? `L${pt(s.p3)}` : `C${pt(s.p1)} ${pt(s.p2)} ${pt(s.p3)}`;
  }
  return d;
}

export function toSvg(g: BoundaryGraph, curves: Segment[][], colors: Color[], areas: Int32Array, opts: SvgOptions): string {
  const W = g.width * opts.scale;
  const H = g.height * opts.scale;
  // Large shapes first so small details sit on top of their neighbours' underlaps.
  const order = [...colors.keys()].sort((a, b) => areas[b] - areas[a]);
  const rank = new Int32Array(colors.length);
  order.forEach((r, i) => (rank[r] = i));
  const drawn = (r: number) => colors[r][3] >= opts.alphaThreshold;
  const loops = regionLoops(g);
  const skip = opts.stacked ? droppableHoles(g, loops, rank, (r) => drawn(r) && colors[r][3] >= 0.995) : undefined;
  const paths = pathsFromLoops(loops, curves, opts.scale, skip);
  // Underlaps: each opaque shape extends under the opaque neighbours drawn after it.
  const opaque = (r: number) => r >= 0 && drawn(r) && colors[r][3] >= 0.995;
  const under: number[][] = Array.from({ length: colors.length }, () => []);
  if (opts.strokeWidth > 0)
    g.chains.forEach((c, i) => {
      const [a, b] = [c.pLabel, c.qLabel];
      if (!opaque(a) || !opaque(b)) return;
      under[rank[a] < rank[b] ? a : b].push(i);
    });
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}" height="${fmt(H)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`,
  ];
  // Stacked mode on an opaque image: underlay the largest shape's color so that seams between
  // sibling shapes blend toward a nearby color instead of showing transparency.
  if (opts.stacked && opts.alphaThreshold === 0 && order.length > 0 && colors[order[0]][3] >= 0.995)
    lines.push(`<rect width="${fmt(W)}" height="${fmt(H)}" fill="${hex(colors[order[0]])}"/>`);
  for (const r of order) {
    const c = colors[r];
    if (!paths[r] || !drawn(r)) continue;
    const col = hex(c);
    const opacity = c[3] < 0.995 ? ` fill-opacity="${fmt(c[3])}"` : '';
    lines.push(`<path fill="${col}"${opacity} d="${paths[r]}"/>`);
    if (under[r].length)
      lines.push(
        `<path fill="none" stroke="${col}" stroke-width="${fmt(opts.strokeWidth * opts.scale)}" stroke-linecap="round" stroke-linejoin="round" d="${chainPaths(under[r], curves, opts.scale)}"/>`,
      );
  }
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}
