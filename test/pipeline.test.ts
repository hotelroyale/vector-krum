import { describe, it, expect } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { Image } from '../src/image.js';
import { Accumulator, chainWeights, renderPolygons } from '../src/raster.js';
import { traceBoundaries, regionLoops } from '../src/boundary.js';
import { pixelSegment, relabelComponents, segmentMeans } from '../src/segmentation.js';
import { ContourEnergy } from '../src/smooth.js';
import { fitCubic, Point } from '../src/bezier.js';
import { getPreset } from '../src/presets.js';
import { mixCost } from '../src/antialias.js';
import { vectorize } from '../src/index.js';
import { logoScene, meanAbsDiff, paint, WHITE, RED, BLUE } from './fixtures.js';

function renderSvg(svg: string, w: number, h: number, background = 'white'): Float32Array {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: w }, background }).render();
  expect(png.width).toBe(w);
  expect(png.height).toBe(h);
  return Float32Array.from(png.pixels, (v) => v / 255);
}

/** Premultiplied copy, so RGB under alpha 0 does not matter in comparisons. */
function premultiplied(d: Float32Array): Float32Array {
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = d[i + c] * d[i + 3];
    out[i + 3] = d[i + 3];
  }
  return out;
}

describe('rasterizer', () => {
  it('reproduces a segmentation exactly when nodes sit on the pixel lattice', () => {
    const img = logoScene(1);
    const seg = relabelComponents(img.width, img.height, labelsFromColors(img));
    seg.colors = segmentMeans(img, seg);
    const g = traceBoundaries(seg);
    const out = new Float64Array(img.data.length);
    renderPolygons(g, chainWeights(g, seg.colors), g.x, g.y, new Accumulator(img.width, img.height), out);
    expect(meanAbsDiff(out, img.data)).toBeLessThan(1e-9);
  });

  it('computes exact fractional coverage', () => {
    const acc = new Accumulator(4, 4);
    const w = [1, 1, 1, 1];
    // Square [0.5, 2.5] x [0.5, 2.5], clockwise in y-down coordinates.
    const sq = [[0.5, 0.5], [0.5, 2.5], [2.5, 2.5], [2.5, 0.5], [0.5, 0.5]];
    for (let i = 0; i < 4; i++) acc.line(sq[i][0], sq[i][1], sq[i + 1][0], sq[i + 1][1], w);
    const out = new Float64Array(64);
    acc.resolve(out);
    const cov = (x: number, y: number) => Math.abs(out[(y * 4 + x) * 4]);
    expect(cov(0, 0)).toBeCloseTo(0.25, 9);
    expect(cov(1, 1)).toBeCloseTo(1, 9);
    expect(cov(1, 0)).toBeCloseTo(0.5, 9);
    expect(cov(3, 3)).toBeCloseTo(0, 9);
  });
});

function labelsFromColors(img: Image): Int32Array {
  const keys = new Map<string, number>();
  const labels = new Int32Array(img.width * img.height);
  for (let p = 0; p < labels.length; p++) {
    const k = Array.from(img.data.subarray(p * 4, p * 4 + 4)).join(',');
    if (!keys.has(k)) keys.set(k, keys.size);
    labels[p] = keys.get(k)!;
  }
  return labels;
}

describe('boundary graph', () => {
  it('links every region boundary into closed loops', () => {
    const img = logoScene(1);
    const seg = relabelComponents(img.width, img.height, labelsFromColors(img));
    const g = traceBoundaries(seg);
    const loops = regionLoops(g);
    for (const regionLoopsList of loops)
      for (const loop of regionLoopsList) {
        const first = loop[0];
        const last = loop[loop.length - 1];
        const fn = g.chains[first.chain].nodes;
        const ln = g.chains[last.chain].nodes;
        const start = first.reversed ? fn[fn.length - 1] : fn[0];
        const end = last.reversed ? ln[0] : ln[ln.length - 1];
        expect(end).toBe(start);
      }
  });
});

describe('contour energy gradients', () => {
  for (const measurement of [0, 1] as const)
    it(`matches finite differences (measurement ${measurement})`, () => {
      const img = logoScene(4);
      const seg = relabelComponents(img.width, img.height, labelsFromColors(logoScene(1)));
      seg.colors = segmentMeans(logoScene(1), seg);
      const g = traceBoundaries(seg);
      // Move nodes off the lattice so the measurement is differentiable.
      let s = 1;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.4;
      for (let i = 0; i < g.x.length; i++) {
        if (!(g.flags[i] & 2)) g.x[i] += rnd();
        if (!(g.flags[i] & 4)) g.y[i] += rnd();
      }
      const e = new ContourEnergy(g, img, seg.colors);
      e.phase = { ...getPreset('logo', 1).smoother.phases[0], measurement, lengthPenalty: 0.5 };
      const gx = new Float64Array(g.x.length);
      const gy = new Float64Array(g.x.length);
      e.eval(g.x, g.y, gx, gy);
      const total = () => {
        const t = e.eval(g.x, g.y);
        return t.prior + t.measurement;
      };
      const h = 1e-4;
      let checked = 0;
      let errSq = 0;
      let refSq = 0;
      for (let i = 0; i < g.x.length; i += 3) {
        if (g.flags[i] & 3) continue; // junctions and nodes with fixed x
        const x = g.x[i];
        g.x[i] = x + h;
        const ep = total();
        g.x[i] = x - h;
        const em = total();
        g.x[i] = x;
        const fd = (ep - em) / (2 * h);
        errSq += (fd - gx[i]) ** 2;
        refSq += fd * fd;
        checked++;
      }
      expect(checked).toBeGreaterThan(20);
      // The measurement gradient integrates the residual by sampling, so allow a small error.
      expect(Math.sqrt(errSq / refSq)).toBeLessThan(measurement === 0 ? 1e-6 : 0.1);
    });
});

describe('bezier fitting', () => {
  it('recovers a cubic from samples', () => {
    const c = [[0, 0], [10, 20], [30, 20], [40, 0]];
    const pts: Point[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const u = 1 - t;
      pts.push([0, 1].map((k) => u ** 3 * c[0][k] + 3 * u * u * t * c[1][k] + 3 * u * t * t * c[2][k] + t ** 3 * c[3][k]) as Point);
    }
    // Sum of squared distances over 21 points; ~0.05 px RMS is ample for vectorization.
    expect(fitCubic(pts).error).toBeLessThan(0.05);
  });
});

describe('segmentation', () => {
  it('finds the three shapes plus background in a noisy aliased image', () => {
    const img = logoScene(1);
    let s = 7;
    for (let i = 0; i < img.data.length; i++)
      if (i % 4 !== 3) img.data[i] = Math.min(1, Math.max(0, img.data[i] + (((s = (s * 16807) % 2147483647) / 2147483647) - 0.5) * 0.06));
    const seg = pixelSegment(img, getPreset('logo', 1).segmenter);
    // background, circle, star (split into pieces by nothing), bar; star overlaps circle.
    expect(seg.count).toBeGreaterThanOrEqual(4);
    expect(seg.count).toBeLessThanOrEqual(6);
  });

  it('explains a 50/50 blend pixel cheaply but not a foreign color', () => {
    const o = getPreset('logo_aa', 1).subPixel;
    const blend = [0.5, 0.5, 0.5, 1];
    const black: [number, number, number, number] = [0, 0, 0, 1];
    const white: [number, number, number, number] = [1, 1, 1, 1];
    expect(mixCost(blend, 0, black, white, o)).toBeLessThan(0.01);
    expect(mixCost([1, 0, 0, 1], 0, black, white, o)).toBeGreaterThan(0.5);
  });
});

describe('end to end', () => {
  it('vectorizes anti-aliased artwork faithfully', () => {
    const img = logoScene(4);
    const r = vectorize(img, { type: 'auto', quality: 1 });
    expect(r.type).toBe('logo_aa');
    expect(r.segmentation.count).toBeGreaterThanOrEqual(4);
    expect(r.segmentation.count).toBeLessThanOrEqual(6);
    const out = renderSvg(r.svg, img.width, img.height);
    expect(meanAbsDiff(out, img.data)).toBeLessThan(0.02);
  });

  it('vectorizes aliased artwork', () => {
    const img = logoScene(1);
    const r = vectorize(img, { type: 'auto', quality: 1 });
    expect(r.type).toBe('logo');
    const out = renderSvg(r.svg, img.width, img.height);
    expect(meanAbsDiff(out, img.data)).toBeLessThan(0.03);
  });

  it('omits transparent background and keeps shapes', () => {
    // Shapes on a transparent background whose hidden RGB is white (as some encoders store it).
    const img = paint(96, 80, [1, 1, 1, 0], [
      { kind: 'circle', cx: 32, cy: 40, r: 24, color: RED },
      { kind: 'polygon', points: [[50, 10], [90, 10], [90, 70], [50, 70]], color: BLUE },
    ], 4);
    const r = vectorize(img, { type: 'auto', quality: 1 });
    expect(r.svg.match(/<path fill="#/g)?.length).toBe(2);
    const out = renderSvg(r.svg, img.width, img.height, 'rgba(0,0,0,0)');
    expect(meanAbsDiff(premultiplied(out), premultiplied(img.data))).toBeLessThan(0.02);
  });

  it('keeps a straight-edged square sharp', () => {
    const img = paint(40, 40, WHITE, [{ kind: 'polygon', points: [[10, 10], [30, 10], [30, 30], [10, 30]], color: BLUE }], 1);
    const r = vectorize(img, { type: 'logo', quality: 1 });
    const out = renderSvg(r.svg, 40, 40);
    expect(meanAbsDiff(out, img.data)).toBeLessThan(0.01);
    void RED;
  });
});
