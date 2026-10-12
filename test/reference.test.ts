// Compares our output with the reference SVGs in test/images.
//
// Each reference is `<name>_<image type>_input-quality-<q>_<colors>_detail-<d>.svg` next to the
// input `<name>.png|jpg`, made with exactly those wizard settings. We vectorize
// the input with the same settings and compare the shapes: outline positions, fragments, region
// and color counts. Run with `npm run test:reference` (not part of `npm test`: slow, and these
// are fidelity targets rather than regression checks).
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vectorize, PaletteMode } from '../src/index.js';
import { loadImage } from '../src/io.js';
import { ImageType, Quality } from '../src/presets.js';
import { renderLabels, svgPalette, svgSize, svgStats, edgeAgreement, outlineOffset, components } from './reference.js';

const DIR = join(import.meta.dirname, 'images');
/** Render scale: edges are compared on a grid of 1/SCALE source pixels. */
const SCALE = 4;

const TYPES: Record<string, ImageType> = {
  'artwork-with-blended-edges': 'logo_aa',
  'artwork-without-blended-edges': 'logo',
  photograph: 'photo',
};
const LEVELS: Record<string, Quality> = { low: 0, medium: 1, high: 2 };

interface Reference {
  name: string;
  svgFile: string;
  inputFile: string;
  type: ImageType;
  quality: Quality;
  palette: PaletteMode;
}

function parseReference(svgFile: string): Reference {
  const m = svgFile.match(/^(.+?)_([a-z-]+)_input-quality-(low|medium|high)_(\d+|unlimited|automatic)-colors_detail-(low|medium|high)\.svg$/);
  if (!m || !(m[2] in TYPES)) throw new Error(`reference name not understood: ${svgFile}`);
  const [, name, type, , colors, detail] = m;
  const inputFile = ['png', 'jpg', 'jpeg'].map((e) => `${name}.${e}`).find((f) => existsSync(join(DIR, f)));
  if (!inputFile) throw new Error(`no input image for ${svgFile}`);
  return {
    name,
    svgFile,
    inputFile,
    type: TYPES[type],
    // The result page's detail level overwrites the input quality (both are the same setting),
    // so the detail level is what was used.
    quality: LEVELS[detail],
    palette: colors === 'unlimited' ? 'flexible' : colors === 'automatic' ? 'auto' : Number(colors),
  };
}

const references = readdirSync(DIR)
  .filter((f) => f.endsWith('.svg'))
  .sort()
  .map(parseReference);

/**
 * Acceptance limits. The reference itself passes all of them trivially; the margins allow
 * for differences too small to see at 100% zoom.
 */
const LIMITS = {
  /** Our outline pixels within ¼ px of the reference outline, and vice versa. */
  edgeMatch: 0.97,
  /** Mean distance from our outline to the reference's, in source pixels. */
  edgeDistance: 0.15,
  /** Area between the two outlines per outline length, in source pixels. */
  outlineOffset: 0.15,
  /** Outline length relative to the reference's: wobbly or split strokes make it longer. */
  outlineLength: 1.03,
  /** Visible regions smaller than 6 px² (fragments, specks, split-off stroke tips): ×reference + 5. */
  fragments: 1.25,
  /** Connected same-color regions, relative to the reference's. */
  regions: [0.85, 1.15],
  /** SVG paths and fill colors, relative to the reference's. */
  paths: 1.5,
  colors: [0.75, 1.25],
};

describe.each(references)('matches the reference $svgFile', (ref) => {
  it(`type ${ref.type}, quality ${ref.quality}, palette ${ref.palette}`, () => {
    const reference = readFileSync(join(DIR, ref.svgFile), 'utf8');
    const { width, height } = svgSize(reference);
    const result = vectorize(loadImage(join(DIR, ref.inputFile)), {
      type: ref.type,
      quality: ref.quality,
      palette: ref.palette,
    });
    expect(result.working.width, 'working size as the reference').toBe(width);
    const out = join(import.meta.dirname, 'output');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, ref.svgFile), result.svg);

    const palette = svgPalette(reference);
    const theirs = renderLabels(reference, width * SCALE, height * SCALE, palette);
    const ours = renderLabels(result.svg, width * SCALE, height * SCALE, palette);
    const edges = edgeAgreement(ours, theirs, 1);
    const speck = 6 * SCALE * SCALE;
    const cv = components(theirs, speck);
    const co = components(ours, speck);
    const sv = svgStats(reference);
    const so = svgStats(result.svg);
    const m = {
      edgePrecision: edges.precision,
      edgeRecall: edges.recall,
      edgeDistance: edges.meanDistance / SCALE,
      outlineOffset: outlineOffset(ours, theirs) / SCALE,
      outlineLength: edges.lengthRatio,
      fragments: [co.specks, cv.specks],
      regions: [co.count, cv.count],
      paths: [so.paths, sv.paths],
      colors: [so.colors, sv.colors],
    };
    console.log(`${ref.svgFile}\n  ours vs reference: ${JSON.stringify(m, (_, v) => (typeof v === 'number' ? +v.toFixed(3) : v))}`);

    expect.soft(m.edgePrecision, 'edges: ours near reference outline').toBeGreaterThanOrEqual(LIMITS.edgeMatch);
    expect.soft(m.edgeRecall, 'edges: reference outline near ours').toBeGreaterThanOrEqual(LIMITS.edgeMatch);
    expect.soft(m.edgeDistance, 'edges: mean distance (px)').toBeLessThanOrEqual(LIMITS.edgeDistance);
    expect.soft(m.outlineOffset, 'edges: mean outline offset (px)').toBeLessThanOrEqual(LIMITS.outlineOffset);
    expect.soft(m.outlineLength, 'lines: outline length ratio').toBeLessThanOrEqual(LIMITS.outlineLength);
    expect.soft(co.specks, 'details: fragments < 6 px²').toBeLessThanOrEqual(cv.specks * LIMITS.fragments + 5);
    expect.soft(co.count, 'details: regions').toBeGreaterThanOrEqual(cv.count * LIMITS.regions[0]);
    expect.soft(co.count, 'details: regions').toBeLessThanOrEqual(cv.count * LIMITS.regions[1]);
    expect.soft(so.paths, 'details: SVG paths').toBeLessThanOrEqual(sv.paths * LIMITS.paths);
    expect.soft(so.colors, 'colors').toBeGreaterThanOrEqual(sv.colors * LIMITS.colors[0]);
    expect.soft(so.colors, 'colors').toBeLessThanOrEqual(sv.colors * LIMITS.colors[1]);
  }, 300_000);
});
