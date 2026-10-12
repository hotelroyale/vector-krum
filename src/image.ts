/** RGBA image with float channels in [0, 1], row-major, 4 floats per pixel. */
export interface Image {
  width: number;
  height: number;
  data: Float32Array;
}

export type Color = [number, number, number, number];

export function createImage(width: number, height: number): Image {
  return { width, height, data: new Float32Array(width * height * 4) };
}

export function fromRgba8(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Image {
  const img = createImage(width, height);
  for (let i = 0; i < rgba.length; i++) img.data[i] = rgba[i] / 255;
  return img;
}

export function toRgba8(img: Image): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(img.data[i] * 255);
  return out;
}

export function getColor(img: Image, p: number): Color {
  const o = p * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

export function dist2(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): number {
  const d0 = a[ai] - b[bi];
  const d1 = a[ai + 1] - b[bi + 1];
  const d2 = a[ai + 2] - b[bi + 2];
  const d3 = a[ai + 3] - b[bi + 3];
  return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
}

/** Composites semi-transparent pixels onto `background` and makes them opaque. */
export function flattenAlpha(img: Image, background: Color): Image {
  const out = createImage(img.width, img.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    for (let c = 0; c < 3; c++) out.data[i + c] = d[i + c] * a + background[c] * (1 - a);
    out.data[i + 3] = 1;
  }
  return out;
}

export function hasTransparency(img: Image): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 0.999) return true;
  return false;
}

/** Larger inputs are shrunk to at most this many pixels. */
export const MAX_WORKING_PIXELS = 1_600_000;

/**
 * Integer shrink factor: ceil(sqrt(pixels / maxPixels)), or 1 if the
 * image already has at most `maxPixels` pixels.
 */
export function shrinkFactor(width: number, height: number, maxPixels = MAX_WORKING_PIXELS): number {
  return width * height > maxPixels ? Math.ceil(Math.sqrt((width * height) / maxPixels)) : 1;
}

/**
 * Shrinks by an integer factor: averages f×f pixel blocks into a ceil(w/f) × ceil(h/f) image
 * (blocks at the right and bottom border may be partial).
 */
export function shrinkByFactor(img: Image, f: number): Image {
  if (f <= 1) return img;
  const w = Math.ceil(img.width / f);
  const h = Math.ceil(img.height / f);
  const out = createImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      const y1 = Math.min(img.height, (y + 1) * f);
      const x1 = Math.min(img.width, (x + 1) * f);
      for (let yy = y * f; yy < y1; yy++)
        for (let xx = x * f; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += img.data[o + c];
        }
      const n = (y1 - y * f) * (x1 - x * f);
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = acc[c] / n;
    }
  return out;
}

/** Box-filter downsampling so that the longer side is at most `maxSide`. */
export function downsample(img: Image, maxSide: number): Image {
  const scale = Math.max(img.width, img.height) / maxSide;
  if (scale <= 1) return img;
  const w = Math.max(1, Math.round(img.width / scale));
  const h = Math.max(1, Math.round(img.height / scale));
  const out = createImage(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const acc = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += img.data[o + c];
        }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = acc[c] / n;
    }
  }
  return out;
}

/**
 * Edge-preserving noise reduction, applied
 * `order` times: each pixel becomes the mean of the 3x3 neighbours whose color is within
 * `tolerance` of it. Unlike a median filter, this never erodes corners or thin lines.
 */
export function reduceNoise(img: Image, order: number, tolerance = 0.12): Image {
  let cur = img;
  const { width: w, height: h } = img;
  const t2 = tolerance * tolerance;
  for (let it = 0; it < order; it++) {
    const src = cur.data;
    const out = createImage(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = (yy * w + xx) * 4;
            if (dist2(src, p, src, q) > t2) continue;
            for (let c = 0; c < 4; c++) acc[c] += src[q + c];
            n++;
          }
        }
        for (let c = 0; c < 4; c++) out.data[p + c] = acc[c] / n;
      }
    cur = out;
  }
  return cur;
}

/**
 * Converts to premultiplied alpha. The pipeline works in premultiplied space so that blends
 * at transparent edges are linear and all fully transparent pixels are identical (0,0,0,0).
 */
export function premultiply(img: Image): Image {
  const out = createImage(img.width, img.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    out.data[i] = d[i] * a;
    out.data[i + 1] = d[i + 1] * a;
    out.data[i + 2] = d[i + 2] * a;
    out.data[i + 3] = a;
  }
  return out;
}

export function unpremultiply(c: Color): Color {
  const a = c[3];
  if (a <= 1e-6) return [0, 0, 0, 0];
  return [Math.min(1, c[0] / a), Math.min(1, c[1] / a), Math.min(1, c[2] / a), a];
}
