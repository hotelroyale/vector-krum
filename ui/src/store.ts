// Wizard state shared by all components, and the actions that drive the engine.
import { computed, markRaw, reactive, watch } from 'vue';
import type { Color, ImageInfo, ImageType, Quality, SuggestedPalette, Transparency } from '../../src/browser';
import { Cancelled, Engine } from './engine';
import type { VectorResult, WorkerOptions } from './protocol';

export type Step = 'start' | 'type' | 'quality' | 'transparency' | 'colors' | 'palette' | 'result';
export type ColorMode = 'two' | 'custom' | 'unlimited';
export type ViewMode = 'bitmap' | 'vector' | 'split';

export interface LoadedImage {
  name: string;
  /** Object URL of the original file, shown in the bitmap view. */
  url: string;
  pixels: ImageData;
}

const engine = new Engine();

export const state = reactive({
  step: 'start' as Step,
  image: null as LoadedImage | null,
  info: null as ImageInfo | null,
  loading: false,
  error: '',

  type: 'logo_aa' as ImageType,
  quality: 1 as Quality,
  transparency: 'keep' as Transparency,
  colorMode: 'custom' as ColorMode,
  /** Custom palette (straight alpha). */
  palette: [] as Color[],
  /** Swatch of the custom palette that picking a color changes. */
  activeSwatch: -1,
  suggestions: [] as SuggestedPalette[],
  suggestionsKey: '',
  suggesting: false,

  maxSide: 0,
  strokeWidth: 0.35,
  stacked: true,
  /** undefined = engine default. */
  clusterColors: undefined as boolean | undefined,

  result: null as VectorResult | null,
  /** Settings the current result was made with (to show which buttons are active). */
  resultOptions: null as WorkerOptions | null,
  busy: false,
  stage: '',

  view: 'bitmap' as ViewMode,
  showPaths: false,
});

export const recommendedType = computed<ImageType>(() => state.info?.classification.type ?? 'logo_aa');
export const recommendedColorMode = computed<ColorMode>(() => (state.type === 'photo' ? 'unlimited' : 'custom'));

export const steps = computed<Step[]>(() => {
  const s: Step[] = ['type', 'quality'];
  if (state.info?.hasTransparency) s.push('transparency');
  s.push('colors');
  if (state.colorMode === 'custom') s.push('palette');
  s.push('result');
  return s;
});

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

function showError(e: unknown) {
  if (e instanceof Cancelled) return;
  state.error = e instanceof Error ? e.message : String(e);
}

/** Decodes any image format the browser supports into straight-alpha RGBA. */
async function decode(file: File): Promise<ImageData> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error(`${file.name}: not an image this browser can read`);
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function openFile(file: File) {
  state.error = '';
  if (file.type === 'image/svg+xml' || (file.type && !file.type.startsWith('image/'))) {
    state.error = `${file.name}: please choose a pixel image (PNG, JPEG, GIF, WebP, BMP, …)`;
    return;
  }
  state.loading = true;
  try {
    const pixels = await decode(file);
    if (state.image) URL.revokeObjectURL(state.image.url);
    state.image = markRaw({ name: file.name, url: URL.createObjectURL(file), pixels });
    state.result = null;
    state.resultOptions = null;
    state.busy = false;
    state.info = null;
    state.view = 'bitmap';
    state.suggestions = [];
    state.suggestionsKey = '';
    state.palette = [];
    state.activeSwatch = -1;
    state.transparency = 'keep';
    state.info = await engine.load({ width: pixels.width, height: pixels.height, data: pixels.data });
    state.type = state.info.classification.type;
    state.quality = 1;
    state.colorMode = recommendedColorMode.value;
    state.step = 'type';
  } catch (e) {
    showError(e);
  } finally {
    state.loading = false;
  }
}

export function goTo(step: Step) {
  state.error = '';
  state.step = step;
  if (step === 'palette') loadSuggestions();
  if (step === 'result') vectorize();
}

export function next() {
  const i = steps.value.indexOf(state.step);
  if (i >= 0 && i + 1 < steps.value.length) goTo(steps.value[i + 1]);
}

export function back() {
  const i = steps.value.indexOf(state.step);
  if (i > 0) goTo(steps.value[i - 1]);
}

export function startPage() {
  state.step = state.image ? 'type' : 'start';
  if (state.image) state.view = 'bitmap';
}

/** Suggested palettes for the current type, quality and transparency; the best fit preselected. */
export async function loadSuggestions() {
  const key = JSON.stringify([state.type, state.quality, state.transparency]);
  if (state.suggestionsKey === key) return;
  state.suggesting = true;
  try {
    const palettes = await engine.palettes(state.type, state.quality, transparency());
    state.suggestions = palettes;
    state.suggestionsKey = key;
    if (palettes.length && state.palette.length === 0) state.palette = palettes[bestSuggestion.value].colors.map((c) => [...c] as Color);
  } catch (e) {
    showError(e);
  } finally {
    state.suggesting = false;
  }
}

/** Plain copy (reactive proxies cannot be posted to the worker). */
function transparency(): Transparency {
  return state.transparency === 'keep' ? 'keep' : ([...state.transparency] as Color);
}

export const bestSuggestion = computed(() => state.suggestions.reduce((b, o, i, a) => (o.score < a[b].score ? i : b), 0));

export function currentOptions(): WorkerOptions {
  return {
    type: state.type,
    quality: state.quality,
    palette: state.colorMode === 'two' ? 2 : state.colorMode === 'unlimited' ? 'flexible' : state.palette.map((c) => [...c] as Color),
    background: state.transparency === 'keep' ? undefined : (transparency() as Color),
    maxSide: state.maxSide,
    strokeWidth: state.strokeWidth,
    stacked: state.stacked,
    clusterColors: state.clusterColors,
  };
}

export async function vectorize() {
  const options = currentOptions();
  state.busy = true;
  state.stage = '';
  state.error = '';
  try {
    const result = await engine.vectorize(options, (stage) => (state.stage = STAGES[stage] ?? stage));
    state.result = markRaw(result);
    state.resultOptions = options;
    state.busy = false;
    if (state.view === 'bitmap') state.view = 'vector';
  } catch (e) {
    if (!(e instanceof Cancelled)) state.busy = false;
    showError(e);
  }
}

/** Result page: change one setting and re-vectorize. */
export function rerun(change: () => void) {
  change();
  vectorize();
}

export function downloadSvg() {
  if (!state.result || !state.image) return;
  const blob = new Blob([state.result.svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.image.name.replace(/\.[^.]+$/, '') + '.svg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Pixel color at image coordinates (straight alpha). */
export function pixelColor(x: number, y: number): Color | null {
  const img = state.image?.pixels;
  if (!img) return null;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return null;
  const o = (yi * img.width + xi) * 4;
  return [img.data[o] / 255, img.data[o + 1] / 255, img.data[o + 2] / 255, img.data[o + 3] / 255];
}

// Palette suggestions depend on type, quality and transparency: recompute when those change.
watch(
  () => [state.type, state.quality, state.transparency],
  () => {
    state.suggestionsKey = '';
  },
);
