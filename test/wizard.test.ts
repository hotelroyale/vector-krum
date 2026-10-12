import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { premultiply, toRgba8 } from '../src/image.js';
import { classifyImage } from '../src/classify.js';
import { loadImage, parseHexColor, toHexColor } from '../src/io.js';
import { vectorize } from '../src/index.js';
import {
  Prompter,
  WizardContext,
  runWizard,
  askDetail,
  toVectorizeOptions,
  equivalentCommand,
  validateOutput,
  defaultOutput,
  suggestPalettes,
} from '../src/wizard.js';
import { findOptimalPalette } from '../src/palette.js';
import { getPreset } from '../src/presets.js';
import { workingImage } from '../src/index.js';
import { logoScene, paint, RED, BLUE } from './fixtures.js';

/** Answers prompts by id; records which prompts were asked and fails on unexpected ones. */
function scripted(answers: Record<string, unknown>): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const answer = (q: { id: string; default?: unknown }) => {
    asked.push(q.id);
    if (q.id in answers) return answers[q.id];
    if (q.default !== undefined) return q.default;
    throw new Error(`unexpected prompt without default: ${q.id}`);
  };
  return {
    asked,
    select: async (q) => {
      const v = answer(q);
      if (!q.choices.some((c) => c.value === v)) throw new Error(`${q.id}: ${String(v)} is not a choice`);
      return v as never;
    },
    input: async (q) => {
      const v = answer(q) as string;
      const ok = q.validate?.(v) ?? true;
      if (ok !== true) throw new Error(`${q.id}: invalid answer ${v}: ${ok}`);
      return v;
    },
    confirm: async (q) => answer(q) as boolean,
    number: async (q) => answer(q) as number,
  };
}

function context(img = logoScene(4), extra: Partial<WizardContext> = {}): WizardContext {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-'));
  return {
    inputPath: join(dir, 'logo.png'),
    image: img,
    classification: classifyImage(premultiply(img)),
    print: () => {},
    color: false,
    written: new Set(),
    ...extra,
  };
}

describe('wizard', () => {
  it('accepts all defaults: detected type, medium quality, automatic colors, output next to input', async () => {
    const ctx = context();
    const p = scripted({});
    const a = await runWizard(ctx, p);
    expect(a.type).toBe('logo_aa');
    expect(a.quality).toBe(1);
    expect(a.colors).toEqual({ kind: 'auto' });
    expect(a.output).toBe(defaultOutput(ctx.inputPath));
    // No transparency in this image, and advanced settings were skipped.
    expect(p.asked).toEqual(['type', 'quality', 'colors', 'advanced', 'output']);
    expect(equivalentCommand(ctx.inputPath, a, join(ctx.inputPath, '..'))).toBe('vectorize logo.png -o logo.svg -t logo_aa -q 1');
  });

  it('asks about transparency only for images with alpha, and flattens on request', async () => {
    const img = paint(60, 40, [0, 0, 0, 0], [{ kind: 'circle', cx: 20, cy: 20, r: 12, color: RED }], 4);
    const ctx = context(img);
    const p = scripted({ transparency: 'custom', 'transparency-color': '#00ff00' });
    const a = await runWizard(ctx, p);
    expect(p.asked).toContain('transparency');
    expect(a.transparency).toEqual([0, 1, 0, 1]);
    expect(toVectorizeOptions(a).background).toEqual([0, 1, 0, 1]);
    expect(equivalentCommand('in.png', a)).toContain("--flatten '#00ff00'"); // quoted: # would start a shell comment
  });

  it('offers suggested palettes with the best fit preselected', async () => {
    const ctx = context(logoScene(1));
    const p = scripted({ type: 'logo', colors: 'suggested' }); // take the preselected palette
    const a = await runWizard(ctx, p);
    expect(a.colors.kind).toBe('palette');
    if (a.colors.kind !== 'palette') return;
    // White background plus red, blue and yellow shapes.
    expect(a.colors.colors.length).toBe(4);
    const hexes = a.colors.colors.map(toHexColor);
    expect(hexes).toContain('#ffffff');
    // The palette is reproducible from the printed command.
    expect(equivalentCommand('in.png', a)).toContain(`-p '${hexes.join(',')}'`);
  });

  it('validates a custom palette and advanced settings', async () => {
    const ctx = context();
    const p = scripted({
      colors: 'custom',
      'custom-palette': '#ffffff, #d91a1a,#1a33cc , #f2cc1a',
      advanced: true,
      'max-side': 500,
      stroke: 0.5,
      stacked: false,
    });
    const a = await runWizard(ctx, p);
    expect(a.colors.kind === 'palette' && a.colors.colors.length).toBe(4);
    expect(a).toMatchObject({ maxSide: 500, strokeWidth: 0.5, stacked: false });
    // Cluster colors only applies to flexible palettes, so it was not asked.
    expect(p.asked).not.toContain('cluster-colors');
    expect(equivalentCommand('in.png', a)).toContain('--max-side 500 --stroke 0.5 --no-stack');

    await expect(runWizard(context(), scripted({ colors: 'custom', 'custom-palette': '#fff' }))).rejects.toThrow(/between 2 and 24/);
  });

  it('asks before overwriting an existing file, but not for files it wrote itself', async () => {
    const ctx = context();
    const out = defaultOutput(ctx.inputPath);
    writeFileSync(out, '<svg/>');
    const declined = join(ctx.inputPath, '..', 'other.svg');
    const p = scripted({ output: out, overwrite: false });
    // After declining, the wizard asks again; answer with a fresh name the second time.
    let outputs = 0;
    const p2: Prompter = { ...p, input: async (q) => (q.id === 'output' ? (outputs++ === 0 ? out : declined) : p.input(q)) };
    const a = await runWizard(ctx, p2);
    expect(a.output).toBe(declined);
    expect(p.asked).toContain('overwrite');

    ctx.written.add(out);
    const p3 = scripted({ output: out });
    expect((await runWizard(ctx, p3)).output).toBe(out);
    expect(p3.asked).not.toContain('overwrite');
  });

  it('uses the output path from the command line without asking', async () => {
    const ctx = context();
    const out = join(ctx.inputPath, '..', 'given.svg');
    const p = scripted({});
    const a = await runWizard({ ...ctx, outputPath: out }, p);
    expect(a.output).toBe(out);
    expect(p.asked).not.toContain('output');
  });

  it('re-runs with the previous answers as defaults', async () => {
    const ctx = context();
    const first = await runWizard(ctx, scripted({ type: 'logo', quality: 2, colors: 'flexible', advanced: true, 'cluster-colors': false }));
    const p = scripted({});
    const second = await runWizard(ctx, p, first);
    expect(second).toEqual(first);
  });

  it('suggests palettes made of colors from the image, best fit = automatic mode', () => {
    const img = logoScene(1); // white, red, blue, yellow
    const options = suggestPalettes(img, 'logo', 1, 'keep');
    const hexes = (cs: number[][]) => cs.map((c) => toHexColor(c as never));
    const used = new Set<string>();
    for (let p = 0; p < img.width * img.height; p++) used.add(toHexColor(Array.from(img.data.subarray(p * 4, p * 4 + 4)) as never));
    // Fewer colors than the image has: every palette color is still one the image uses, not a blend.
    const two = options.find((o) => o.colors.length === 2)!;
    for (const h of hexes(two.colors)) expect(used.has(h)).toBe(true);
    const best = options.reduce((b, o) => (o.score < b.score ? o : b));
    const auto = findOptimalPalette(workingImage(img, getPreset('logo', 1)), getPreset('logo', 1).palette);
    expect(hexes(best.colors)).toEqual(hexes(auto.colors));
  });

  it('validates output names', () => {
    expect(validateOutput('out.png')).toMatch(/\.svg/);
    expect(validateOutput('/no/such/dir/out.svg')).toMatch(/does not exist/);
    expect(validateOutput(join(tmpdir(), 'x.svg'))).toBe(true);
  });

  it('produces options the engine accepts', async () => {
    const img = logoScene(4);
    const a = await runWizard(context(img), scripted({ quality: 2 }));
    const r = vectorize(img, toVectorizeOptions(a));
    expect(r.svg).toMatch(/^<\?xml/);
  });

  it('result-page detail level picks the quality preset, current level preselected', async () => {
    let choices: { name: string; value: unknown }[] = [];
    const p = scripted({ detail: 0 });
    const select = p.select;
    p.select = async (q) => ((choices = q.choices), select(q));
    expect(await askDetail(2, p)).toBe(0);
    expect(choices.map((c) => c.name)).toEqual(['High (current)', 'Medium', 'Low']);
    expect(await askDetail(1, scripted({}))).toBe(1);
  });
});

describe('io', () => {
  it('loads PNG and JPEG by content, regardless of extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'io-'));
    const img = paint(8, 6, [1, 1, 1, 1], [{ kind: 'polygon', points: [[0, 0], [4, 0], [4, 6], [0, 6]], color: BLUE }]);
    const png = new PNG({ width: 8, height: 6 });
    png.data = Buffer.from(toRgba8(img));
    writeFileSync(join(dir, 'a.jpg'), PNG.sync.write(png)); // PNG content, misleading extension
    expect(loadImage(join(dir, 'a.jpg')).width).toBe(8);
    const jpeg = (await import('jpeg-js')).default;
    writeFileSync(join(dir, 'b.jpeg'), jpeg.encode({ width: 8, height: 6, data: Buffer.from(toRgba8(img)) }, 95).data);
    const j = loadImage(join(dir, 'b.jpeg'));
    expect([j.width, j.height]).toEqual([8, 6]);
    expect(j.data[2]).toBeGreaterThan(0.6); // blue-ish left half
    writeFileSync(join(dir, 'c.png'), 'not an image');
    expect(() => loadImage(join(dir, 'c.png'))).toThrow(/unsupported/);
  });

  it('parses colors with optional alpha', () => {
    expect(parseHexColor('#ff000080')[3]).toBeCloseTo(128 / 255);
    expect(toHexColor(parseHexColor('00ff00'))).toBe('#00ff00');
    expect(() => parseHexColor('red')).toThrow();
  });
});
