// Browser entry point: the parts of the library that run without Node (no fs, no terminal
// prompts). Images come in as RGBA bytes, e.g. from a canvas' ImageData. Used by the web UI.
import { vectorize, VectorizeOptions, VectorizeResult } from './index.js';
import { Image, fromRgba8, hasTransparency, premultiply, unpremultiply } from './image.js';
import { classifyImage, Classification } from './classify.js';

export { vectorize, workingImage, getPreset } from './index.js';
export type { VectorizeOptions, VectorizeResult, PaletteMode, ImageType, Quality, Preset, Image, Color } from './index.js';
export { fromRgba8, toRgba8, hasTransparency, flattenAlpha } from './image.js';
export { classifyImage } from './classify.js';
export type { Classification } from './classify.js';
export { suggestPalettes } from './suggest.js';
export type { SuggestedPalette, Transparency } from './suggest.js';
export { parseHexColor, toHexColor } from './color.js';

/** RGBA bytes (straight alpha), as in ImageData. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export function imageFromRgba(rgba: RgbaImage): Image {
  return fromRgba8(rgba.width, rgba.height, rgba.data);
}

export interface ImageInfo {
  classification: Classification;
  hasTransparency: boolean;
}

/** What the wizard needs to know about a freshly loaded image. */
export function inspectImage(img: Image): ImageInfo {
  return { classification: classifyImage(premultiply(img)), hasTransparency: hasTransparency(img) };
}

/**
 * Curve anchor points of a result, in SVG coordinates (for showing the paths' nodes). Each
 * chain's start and end and every point between two curve segments.
 */
export function curveNodes(result: VectorizeResult): Float32Array {
  const m = /<svg[^>]*\swidth="([\d.]+)"/.exec(result.svg);
  const scale = m ? Number(m[1]) / result.graph.width : 1;
  const pts: number[] = [];
  for (const chain of result.curves) {
    if (chain.length === 0) continue;
    pts.push(chain[0].p0[0] * scale, chain[0].p0[1] * scale);
    for (const s of chain) pts.push(s.p3[0] * scale, s.p3[1] * scale);
  }
  return Float32Array.from(pts);
}

/** vectorize() with RGBA input; returns only what can be posted from a worker. */
export function vectorizeRgba(rgba: RgbaImage, options: VectorizeOptions = {}) {
  const result = vectorize(imageFromRgba(rgba), options);
  return {
    svg: result.svg,
    type: result.type,
    quality: result.quality,
    palette: result.palette?.map(unpremultiply),
    nodes: curveNodes(result),
    workingWidth: result.working.width,
    workingHeight: result.working.height,
  };
}
