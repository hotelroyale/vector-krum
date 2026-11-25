// Splits a vectorizer SVG into removable shapes and writes it back without the removed ones.
// The SVG comes from src/svg.ts: one element per line, each region a filled <path>, optionally
// followed by its underlap stroke (fill="none"), and possibly a background <rect> first.

export interface Shape {
  /** Fill color (#rrggbb). */
  fill: string;
  /** SVG markup of the shape (its fill and underlap elements). */
  markup: string;
  /** Filled outline, in SVG units, for hit testing and highlighting. */
  path: Path2D;
  /** Bounding box [minX, minY, maxX, maxY], for cheap hit testing. */
  box: [number, number, number, number];
  /** Curve nodes (segment end points) as x, y pairs. */
  nodes: number[];
  /** The full-size underlay rectangle behind everything. */
  background: boolean;
  /** Fully opaque (hides what is drawn before it). */
  opaque: boolean;
}

export interface ParsedSvg {
  head: string[];
  shapes: Shape[];
}

const attr = (line: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(line)?.[1] ?? '';

/** End points of the segments of a path made of M, L, C and Z commands. */
function pathNodes(d: string): number[] {
  const nodes: number[] = [];
  for (const m of d.matchAll(/([MLC])([^MLCZ]*)/g)) {
    const v = m[2].trim().split(/[\s,]+/).map(Number);
    if (v.length >= 2) nodes.push(v[v.length - 2], v[v.length - 1]);
  }
  return nodes;
}

/** Box around all points of a path, control points included (a curve stays inside their hull). */
function boxOf(d: string): Shape['box'] {
  const v = d.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? [];
  const box: Shape['box'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < v.length; i += 2) {
    box[0] = Math.min(box[0], v[i]);
    box[1] = Math.min(box[1], v[i + 1]);
    box[2] = Math.max(box[2], v[i]);
    box[3] = Math.max(box[3], v[i + 1]);
  }
  return box;
}

export function parseSvg(svg: string): ParsedSvg {
  const head: string[] = [];
  const shapes: Shape[] = [];
  for (const line of svg.split('\n')) {
    const t = line.trim();
    if (!t || t === '</svg>') continue;
    if (t.startsWith('<rect')) {
      const w = Number(attr(t, 'width'));
      const h = Number(attr(t, 'height'));
      const path = new Path2D();
      path.rect(0, 0, w, h);
      shapes.push({ fill: attr(t, 'fill'), markup: t, path, box: [0, 0, w, h], nodes: [], background: true, opaque: true });
    } else if (t.startsWith('<path')) {
      const fill = attr(t, 'fill');
      const last = shapes[shapes.length - 1];
      if (fill === 'none') {
        // Underlap stroke of the shape before it.
        if (last) last.markup += '\n' + t;
        else head.push(t);
        continue;
      }
      const d = attr(t, 'd');
      const nodes = pathNodes(d);
      shapes.push({ fill, markup: t, path: new Path2D(d), box: boxOf(d), nodes, background: false, opaque: !/\sfill-opacity="/.test(t) });
    } else if (!shapes.length) {
      head.push(t);
    }
  }
  return { head, shapes };
}

export function writeSvg(parsed: ParsedSvg, removed: ReadonlySet<number>): string {
  const lines = [...parsed.head];
  parsed.shapes.forEach((s, i) => removed.has(i) || lines.push(s.markup));
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

let hitContext: OffscreenCanvasRenderingContext2D | null = null;

/** Index of the topmost shape not in `removed` that contains the point (SVG units), or -1. */
export function shapeAt(parsed: ParsedSvg, removed: ReadonlySet<number>, x: number, y: number): number {
  hitContext ??= new OffscreenCanvas(1, 1).getContext('2d');
  if (!hitContext) return -1;
  for (let i = parsed.shapes.length - 1; i >= 0; i--) {
    if (removed.has(i)) continue;
    const { box, path } = parsed.shapes[i];
    if (x < box[0] || y < box[1] || x > box[2] || y > box[3]) continue;
    if (hitContext.isPointInPath(path, x, y)) return i;
  }
  return -1;
}
