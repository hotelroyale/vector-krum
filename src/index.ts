// Full pipeline: classify → preprocess → palette → segment → (anti-aliasing model) →
// trace boundaries → smooth contours → fit Béziers → SVG.
import { Image, Color, createImage, downsample, shrinkByFactor, shrinkFactor, reduceNoise, hasTransparency, premultiply, unpremultiply, flattenAlpha } from './image.js';
import { ImageType, Quality, Preset, getPreset } from './presets.js';
import { classifyImage, Classification } from './classify.js';
import { findOptimalPalette, findPalette } from './palette.js';
import {
  Segmentation,
  pixelSegment,
  segmentMeans,
  segmentInteriorMedians,
  mergeEqualNeighbours,
  clusterColors,
  snapToPalette,
  segmentSizes,
} from './segmentation.js';
import { subPixelSegment } from './subpixel.js';
import { BoundaryGraph, traceBoundaries } from './boundary.js';
import { PhaseLog, smoothContours } from './smooth.js';
import { Segment, fitChains } from './bezier.js';
import { toSvg } from './svg.js';

export type PaletteMode = 'auto' | 'flexible' | number | Color[];

export interface VectorizeOptions {
  type?: ImageType | 'auto';
  quality?: Quality;
  /** 'auto' (fixed palette for logos, flexible for photos), 'flexible', a color count, or explicit colors. */
  palette?: PaletteMode;
  /**
   * Longer side of the working image; larger inputs are downsampled. 0 (default) = shrink by an integer factor to at most 1.6 megapixels.
   */
  maxSide?: number;
  strokeWidth?: number;
  /**
   * Flexible palette only: unify similar segment colors. Default: on for artwork, off for photos.
   */
  clusterColors?: boolean;
  /** Composite transparent pixels onto this color first (straight alpha); default: keep transparency. */
  background?: Color;
  /** Stacked shapes: fill holes that later shapes cover, avoiding seams (default true). */
  stacked?: boolean;
  onProgress?: (stage: string) => void;
}

export interface VectorizeResult {
  svg: string;
  type: ImageType;
  quality: Quality;
  classification?: Classification;
  palette?: Color[];
  segmentation: Segmentation;
  graph: BoundaryGraph;
  curves: Segment[][];
  smoothing: PhaseLog[];
  /** Working image (premultiplied alpha, after downsampling and noise reduction). */
  working: Image;
}

export function vectorize(input: Image, options: VectorizeOptions = {}): VectorizeResult {
  const progress = options.onProgress ?? (() => {});
  if (options.background) input = flattenAlpha(input, options.background);
  const quality = options.quality ?? 1;
  let classification: Classification | undefined;
  let type: ImageType;
  if (!options.type || options.type === 'auto') {
    progress('classify');
    classification = classifyImage(premultiply(input));
    type = classification.type;
  } else type = options.type;
  const preset = getPreset(type, quality);

  progress('preprocess');
  const working = workingImage(input, preset, options.maxSide);
  const scale = options.maxSide ? input.width / working.width : shrinkFactor(input.width, input.height);

  // Palette selection.
  progress('palette');
  const mode = options.palette ?? 'auto';
  let palette: Color[] | undefined;
  if (Array.isArray(mode)) palette = mode.map((c) => [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]] as Color);
  else if (typeof mode === 'number') palette = findPalette(working, mode, preset.palette).colors;
  else if (mode === 'auto' && type !== 'photo') palette = findOptimalPalette(working, preset.palette).colors;

  // For aliased artwork with a fixed palette, quantise first so segmentation sees clean colors.
  let segInput = working;
  if (palette && !preset.isAntiAliased) segInput = quantize(working, palette);

  progress('segment');
  let seg = pixelSegment(segInput, preset.segmenter);
  if (preset.isAntiAliased) {
    progress('anti-aliasing');
    seg = subPixelSegment(working, seg, preset.subPixel, {
      clusterMargin: (options.clusterColors ?? true) ? preset.subPixel.colorClusterMargin : undefined,
      palette,
    });
  } else {
    seg.colors = segmentMeans(working, seg);
    if (palette) seg.colors = snapToPalette(seg, palette);
    else if (options.clusterColors ?? type !== 'photo')
      seg.colors = clusterColors(seg, preset.subPixel.colorClusterMargin, segmentSizes(seg));
  }
  seg = mergeEqualNeighbours(working, seg);

  progress('trace');
  const graph = traceBoundaries(seg);
  progress('smooth');
  const smoothing = smoothContours(graph, working, seg.colors, preset.smoother, seg.labels);
  progress('bezier');
  const curves = fitChains(graph, preset.bezier);
  progress('svg');
  const svg = toSvg(graph, curves, seg.colors.map(unpremultiply), segmentSizes(seg), {
    scale,
    strokeWidth: options.strokeWidth ?? 0.35,
    alphaThreshold: hasTransparency(input) ? 0.5 : 0,
    stacked: options.stacked ?? true,
  });
  return { svg, type, quality, classification, palette, segmentation: seg, graph, curves, smoothing, working };
}

/** Premultiplied, downsampled and denoised image that all later stages (and palettes) work on. */
export function workingImage(input: Image, preset: Preset, maxSide = 0): Image {
  const img = premultiply(input);
  const small = maxSide > 0 ? downsample(img, maxSide) : shrinkByFactor(img, shrinkFactor(img.width, img.height));
  return reduceNoise(small, preset.reduceNoiseOrder);
}

function quantize(img: Image, palette: Color[]): Image {
  const out = createImage(img.width, img.height);
  for (let p = 0; p < img.width * img.height; p++) {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < palette.length; k++) {
      let d = 0;
      for (let c = 0; c < 4; c++) d += (img.data[p * 4 + c] - palette[k][c]) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    out.data.set(palette[best], p * 4);
  }
  return out;
}

export { getPreset } from './presets.js';
export type { ImageType, Quality, Preset } from './presets.js';
export type { Image, Color } from './image.js';
export { fromRgba8, toRgba8 } from './image.js';
