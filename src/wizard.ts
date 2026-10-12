// Interactive wizard logic: walks through the decisions
// (image type → input quality → transparency → colors → advanced → output), then vectorizes.
// The terminal entry point is wizard-cli.ts.
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { styleText } from 'node:util';
import { select, input, confirm, number } from '@inquirer/prompts';
import { VectorizeOptions, PaletteMode } from './index.js';
import { Image, Color, hasTransparency } from './image.js';
import { ImageType, Quality } from './presets.js';
import { Classification } from './classify.js';
import { parseHexColor, toHexColor } from './color.js';
import { Transparency, suggestPalettes } from './suggest.js';

export { suggestPalettes } from './suggest.js';
export type { Transparency } from './suggest.js';

// ---------------------------------------------------------------------------------------------
// Prompt abstraction (lets tests drive the wizard with scripted answers)

export interface Choice<T> {
  name: string;
  value: T;
  description?: string;
}

export interface Prompter {
  select<T>(q: { id: string; message: string; choices: Choice<T>[]; default?: T }): Promise<T>;
  input(q: { id: string; message: string; default?: string; validate?: (v: string) => true | string }): Promise<string>;
  confirm(q: { id: string; message: string; default?: boolean }): Promise<boolean>;
  number(q: { id: string; message: string; default?: number; min?: number; max?: number; step?: number | 'any' }): Promise<number>;
}

export const inquirerPrompter: Prompter = {
  select: ({ message, choices, default: d }) => select({ message, choices, default: d, pageSize: 12, loop: false }),
  input: ({ message, default: d, validate }) => input({ message, default: d, validate }),
  confirm: ({ message, default: d }) => confirm({ message, default: d }),
  number: async ({ message, default: d, min, max, step }) => (await number({ message, default: d, min, max, step, required: true }))!,
};

// ---------------------------------------------------------------------------------------------
// Wizard state

export type ColorChoice = { kind: 'auto' } | { kind: 'flexible' } | { kind: 'palette'; colors: Color[] };

export interface WizardAnswers {
  type: ImageType;
  quality: Quality;
  transparency: Transparency;
  colors: ColorChoice;
  maxSide: number;
  strokeWidth: number;
  stacked: boolean;
  /** undefined = engine default (on for artwork, off for photos). */
  clusterColors?: boolean;
  output: string;
}

export interface WizardContext {
  inputPath: string;
  image: Image;
  /** Output path given on the command line, if any. */
  outputPath?: string;
  classification: Classification;
  print: (s: string) => void;
  /** True if the terminal can show 24-bit color swatches. */
  color: boolean;
  /** Files this session already wrote (re-runs may overwrite them without asking). */
  written: Set<string>;
}

const DEFAULTS = { maxSide: 0, strokeWidth: 0.35, stacked: true };

const TYPE_CHOICES: Choice<ImageType>[] = [
  {
    value: 'logo_aa',
    name: 'Artwork with blended edges',
    description: 'Logos, icons and clip art with smooth (anti-aliased) edges, 1–2 px of blending between colors.',
  },
  {
    value: 'logo',
    name: 'Artwork without blended edges',
    description: 'Hard pixel edges: GIFs, screenshots, pixel art, images with a 1-bit transparency mask.',
  },
  {
    value: 'photo',
    name: 'Photograph or detailed image',
    description: 'Many colors, gradients and textures. The result is a posterized set of flat shapes.',
  },
];

const QUALITY_CHOICES: Record<ImageType, Choice<Quality>[]> = {
  logo_aa: [
    { value: 2, name: 'High quality', description: 'Clean edges and flat color areas; blending at most ~1 px.' },
    { value: 1, name: 'Medium quality', description: 'Some noise or JPEG artifacts; blending up to 2 px.' },
    { value: 0, name: 'Low quality', description: 'Blurry edges (> 2 px) and noticeably uneven colors. Smooths more.' },
  ],
  logo: [
    { value: 2, name: 'High quality', description: 'Exact pixel edges; keeps small details and single pixels.' },
    { value: 1, name: 'Medium quality', description: 'Mostly clean; tiny specks are merged away.' },
    { value: 0, name: 'Low quality', description: 'Noisy edges; smoother shapes, fewer details.' },
  ],
  photo: [
    { value: 2, name: 'High detail', description: 'Many small shapes; closest to the photo, largest file.' },
    { value: 1, name: 'Medium detail', description: 'Balanced number of shapes.' },
    { value: 0, name: 'Low detail', description: 'Few large shapes; strongly stylized.' },
  ],
};

/**
 * Result-page "Detail Level" (High / Medium / Low): sets the image quality and re-vectorizes,
 * so it is the same preset choice as the quality step, with these texts.
 */
const DETAIL_CHOICES: Choice<Quality>[] = [
  { value: 2, name: 'High', description: 'Preserve as many details as possible.' },
  { value: 1, name: 'Medium', description: 'Preserve some details but do some smoothing.' },
  { value: 0, name: 'Low', description: 'Strong smoothing, details lost but robust to blurry and low-quality source images.' },
];

/** Result-page detail level: returns the quality to re-vectorize with. */
export async function askDetail(current: Quality, p: Prompter): Promise<Quality> {
  return p.select({
    id: 'detail',
    message: 'Detail level',
    choices: DETAIL_CHOICES.map((c) => (c.value === current ? { ...c, name: `${c.name} (current)` } : c)),
    default: current,
  });
}

export const TYPE_NAMES: Record<ImageType, string> = {
  logo_aa: 'Artwork with blended edges',
  logo: 'Artwork without blended edges',
  photo: 'Photograph',
};

// ---------------------------------------------------------------------------------------------
// Presentation helpers

export const bold = (s: string) => styleText('bold', s);
export const dim = (s: string) => styleText('dim', s);
const cyan = (s: string) => styleText('cyan', s);

export function swatch(c: Color, color: boolean): string {
  if (c[3] < 0.5) return color ? dim('░░░') : 'transparent';
  if (!color) return toHexColor(c);
  const [r, g, b] = c.map((v) => Math.round(v * 255));
  return `\x1b[48;2;${r};${g};${b}m   \x1b[0m`;
}

export function swatches(colors: Color[], color: boolean): string {
  return colors.map((c) => swatch(c, color)).join(color ? ' ' : ', ');
}

/** Path relative to the working directory when that is shorter and stays inside it. */
export function displayPath(p: string, cwd = process.cwd()): string {
  const rel = relative(cwd, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
}

function shellQuote(s: string): string {
  return /^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function defaultOutput(inputPath: string): string {
  return join(dirname(inputPath), basename(inputPath, extname(inputPath)) + '.svg');
}

// ---------------------------------------------------------------------------------------------
// Steps

async function askType(ctx: WizardContext, p: Prompter, prev?: WizardAnswers): Promise<ImageType> {
  const detected = ctx.classification.type;
  return p.select({
    id: 'type',
    message: 'What kind of image is this?',
    choices: TYPE_CHOICES.map((c) => ({ ...c, name: c.value === detected ? `${c.name} ${cyan('(detected)')}` : c.name })),
    default: prev?.type ?? detected,
  });
}

async function askQuality(type: ImageType, p: Prompter, prev?: WizardAnswers): Promise<Quality> {
  return p.select({
    id: 'quality',
    message: type === 'photo' ? 'How much detail should the result keep?' : 'How clean is the source image?',
    choices: QUALITY_CHOICES[type],
    default: prev?.type === type ? prev.quality : 1,
  });
}

async function askTransparency(ctx: WizardContext, p: Prompter, prev?: WizardAnswers): Promise<Transparency> {
  if (!hasTransparency(ctx.image)) return 'keep';
  const prevKey = prev === undefined || prev.transparency === 'keep' ? 'keep' : 'custom';
  const choice = await p.select<'keep' | 'white' | 'black' | 'custom'>({
    id: 'transparency',
    message: 'The image has transparent areas. How should they be handled?',
    choices: [
      { value: 'keep', name: 'Keep transparency', description: 'Transparent areas are left out of the SVG.' },
      { value: 'white', name: 'Fill with white', description: 'Composite onto a white background first.' },
      { value: 'black', name: 'Fill with black', description: 'Composite onto a black background first.' },
      { value: 'custom', name: 'Fill with another color…' },
    ],
    default: prevKey,
  });
  if (choice === 'keep') return 'keep';
  if (choice === 'white') return [1, 1, 1, 1];
  if (choice === 'black') return [0, 0, 0, 1];
  const prevHex = prev && prev.transparency !== 'keep' ? toHexColor(prev.transparency) : '#ffffff';
  const hex = await p.input({ id: 'transparency-color', message: 'Background color (#rrggbb):', default: prevHex, validate: validateColor });
  return [...parseHexColor(hex).slice(0, 3), 1] as Color;
}

function validateColor(v: string): true | string {
  try {
    parseHexColor(v);
    return true;
  } catch {
    return 'Enter a color like #ff8800';
  }
}

async function askColors(ctx: WizardContext, type: ImageType, quality: Quality, transparency: Transparency, p: Prompter, prev?: WizardAnswers): Promise<ColorChoice> {
  const autoDesc =
    type === 'photo'
      ? 'Unlimited colors: every shape gets its own color.'
      : 'A fixed palette whose size is chosen automatically.';
  const kind = await p.select<'auto' | 'suggested' | 'custom' | 'flexible'>({
    id: 'colors',
    message: 'Which colors should the result use?',
    choices: [
      { value: 'auto', name: 'Automatic (recommended)', description: autoDesc },
      { value: 'suggested', name: 'Pick from suggested palettes', description: 'Choose the number of colors; shows color previews.' },
      { value: 'custom', name: 'Enter my own palette', description: 'Exactly these colors (#rrggbb, comma-separated).' },
      { value: 'flexible', name: 'Unlimited colors', description: 'Each shape keeps its own color (flexible palette).' },
    ],
    default: prev ? (prev.colors.kind === 'palette' ? 'custom' : prev.colors.kind) : 'auto',
  });
  if (kind === 'auto' || kind === 'flexible') return { kind };

  if (kind === 'custom') {
    const prevList = prev?.colors.kind === 'palette' ? prev.colors.colors.map(toHexColor).join(', ') : undefined;
    const list = await p.input({
      id: 'custom-palette',
      message: 'Palette colors (#rrggbb, comma-separated, 2–24 colors):',
      default: prevList,
      validate: (v) => {
        const parts = v.split(',').filter((s) => s.trim());
        if (parts.length < 2 || parts.length > 24) return 'Enter between 2 and 24 colors';
        for (const s of parts) if (validateColor(s) !== true) return `Not a color: ${s.trim()}`;
        return true;
      },
    });
    return { kind: 'palette', colors: list.split(',').filter((s) => s.trim()).map(parseHexColor) };
  }

  ctx.print(dim('  Computing palettes…'));
  const options = suggestPalettes(ctx.image, type, quality, transparency, prev?.maxSide);
  if (options.length === 0) {
    ctx.print('  The image has a single color; using automatic mode.');
    return { kind: 'auto' };
  }
  const best = options.reduce((b, o, i) => (o.score < options[b].score ? i : b), 0);
  const pick = await p.select<number>({
    id: 'suggested-palette',
    message: 'Choose a palette:',
    choices: options.map((o, i) => ({
      value: i,
      name: `${String(o.colors.length).padStart(2)} colors  ${swatches(o.colors, ctx.color)}${i === best ? `  ${cyan('★ best fit')}` : ''}`,
    })),
    default: best,
  });
  return { kind: 'palette', colors: options[pick].colors };
}

async function askAdvanced(colors: ColorChoice, type: ImageType, p: Prompter, prev?: WizardAnswers) {
  const base = {
    maxSide: prev?.maxSide ?? DEFAULTS.maxSide,
    strokeWidth: prev?.strokeWidth ?? DEFAULTS.strokeWidth,
    stacked: prev?.stacked ?? DEFAULTS.stacked,
    clusterColors: prev?.clusterColors,
  };
  const changed = base.maxSide !== DEFAULTS.maxSide || base.strokeWidth !== DEFAULTS.strokeWidth || !base.stacked || base.clusterColors !== undefined;
  if (!(await p.confirm({ id: 'advanced', message: 'Adjust advanced settings?', default: changed }))) return base;
  base.maxSide = await p.number({
    id: 'max-side',
    message: 'Working resolution (longer side in px; 0 = automatic, at most 1.6 megapixels):',
    default: base.maxSide,
    min: 0,
    max: 10000,
  });
  base.strokeWidth = await p.number({
    id: 'stroke',
    message: 'Seam underlap in px (shapes extend this far under shapes drawn on top, hiding hairline gaps; 0 = none):',
    default: base.strokeWidth,
    min: 0,
    max: 5,
    step: 'any',
  });
  base.stacked = await p.confirm({
    id: 'stacked',
    message: 'Stack shapes (fill holes that shapes on top cover; avoids seams)?',
    default: base.stacked,
  });
  const flexible = colors.kind === 'flexible' || (colors.kind === 'auto' && type === 'photo');
  if (flexible)
    base.clusterColors = await p.confirm({
      id: 'cluster-colors',
      message: 'Unify similar colors across shapes?',
      default: base.clusterColors ?? type !== 'photo',
    });
  return base;
}

async function askOutput(ctx: WizardContext, p: Prompter, prev?: WizardAnswers): Promise<string> {
  let suggestion = prev?.output ?? ctx.outputPath ?? defaultOutput(ctx.inputPath);
  // An output path from the command line is used as-is unless it would overwrite something.
  let fromArg = !prev && ctx.outputPath !== undefined;
  for (;;) {
    const out = fromArg
      ? suggestion
      : resolve(
          await p.input({
            id: 'output',
            message: 'Save the SVG as:',
            default: suggestion,
            validate: (v) => validateOutput(v),
          }),
        );
    fromArg = false;
    const problem = validateOutput(out);
    if (problem !== true) {
      ctx.print(`  ${problem}`);
      suggestion = defaultOutput(ctx.inputPath);
      continue;
    }
    if (!existsSync(out) || ctx.written.has(out)) return out;
    if (await p.confirm({ id: 'overwrite', message: `${displayPath(out)} exists. Overwrite?`, default: false })) return out;
    suggestion = out;
  }
}

export function validateOutput(v: string): true | string {
  if (!v.trim()) return 'Enter a file name';
  if (extname(v).toLowerCase() !== '.svg') return 'The output must be an .svg file';
  const dir = dirname(resolve(v));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return `Directory does not exist: ${dir}`;
  return true;
}

export async function runWizard(ctx: WizardContext, p: Prompter, prev?: WizardAnswers): Promise<WizardAnswers> {
  const type = await askType(ctx, p, prev);
  const quality = await askQuality(type, p, prev);
  const transparency = await askTransparency(ctx, p, prev);
  const colors = await askColors(ctx, type, quality, transparency, p, prev);
  const advanced = await askAdvanced(colors, type, p, prev);
  const output = await askOutput(ctx, p, prev);
  return { type, quality, transparency, colors, ...advanced, output };
}

// ---------------------------------------------------------------------------------------------
// Mapping answers to the engine and to the equivalent command line

export function toVectorizeOptions(a: WizardAnswers): VectorizeOptions {
  const palette: PaletteMode = a.colors.kind === 'palette' ? a.colors.colors : a.colors.kind;
  return {
    type: a.type,
    quality: a.quality,
    palette,
    background: a.transparency === 'keep' ? undefined : a.transparency,
    maxSide: a.maxSide,
    strokeWidth: a.strokeWidth,
    stacked: a.stacked,
    clusterColors: a.clusterColors,
  };
}

export function equivalentCommand(inputPath: string, a: WizardAnswers, cwd = process.cwd()): string {
  const args = ['vectorize', shellQuote(displayPath(inputPath, cwd)), '-o', shellQuote(displayPath(a.output, cwd)), '-t', a.type, '-q', String(a.quality)];
  if (a.colors.kind === 'palette') args.push('-p', shellQuote(a.colors.colors.map(toHexColor).join(',')));
  else if (a.colors.kind === 'flexible') args.push('-p', 'flexible');
  if (a.transparency !== 'keep') args.push('--flatten', shellQuote(toHexColor(a.transparency)));
  if (a.maxSide !== DEFAULTS.maxSide) args.push('--max-side', String(a.maxSide));
  if (a.strokeWidth !== DEFAULTS.strokeWidth) args.push('--stroke', String(a.strokeWidth));
  if (!a.stacked) args.push('--no-stack');
  if (a.clusterColors !== undefined) args.push('--cluster-colors', a.clusterColors ? 'on' : 'off');
  return args.join(' ');
}

export function summary(a: WizardAnswers, color: boolean): string {
  const q = QUALITY_CHOICES[a.type].find((c) => c.value === a.quality)!.name;
  const colors =
    a.colors.kind === 'auto'
      ? 'automatic'
      : a.colors.kind === 'flexible'
        ? 'unlimited'
        : `${a.colors.colors.length} colors  ${swatches(a.colors.colors, color)}`;
  const rows: [string, string][] = [
    ['Image type', TYPE_NAMES[a.type]],
    ['Quality', q],
    ['Transparency', a.transparency === 'keep' ? 'keep' : `fill with ${swatch(a.transparency, color)}${color ? ' ' + toHexColor(a.transparency) : ''}`],
    ['Colors', colors],
    ['Advanced', `${a.maxSide ? `max side ${a.maxSide}px` : 'automatic size'}, stroke ${a.strokeWidth}px, ${a.stacked ? 'stacked' : 'not stacked'}` + (a.clusterColors === undefined ? '' : `, cluster colors ${a.clusterColors ? 'on' : 'off'}`)],
    ['Output', displayPath(a.output)],
  ];
  return rows.map(([k, v]) => `  ${dim(k.padEnd(13))}${v}`).join('\n');
}

export const STAGES: Record<string, string> = {
  classify: 'Classifying image',
  preprocess: 'Preprocessing',
  palette: 'Finding palette',
  segment: 'Segmenting image',
  'anti-aliasing': 'Modelling anti-aliasing',
  trace: 'Tracing boundaries',
  smooth: 'Smoothing paths',
  bezier: 'Fitting curves',
  svg: 'Writing SVG',
};
