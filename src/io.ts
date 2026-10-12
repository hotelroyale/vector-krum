// Loading raster images from disk (PNG and JPEG) and parsing colors given on the command line.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { Image, fromRgba8 } from './image.js';

export const SUPPORTED_INPUT = ['.png', '.jpg', '.jpeg'];

export function loadImage(path: string): Image {
  const buf = readFileSync(path);
  // Sniff the format from the file signature rather than trusting the extension.
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const png = PNG.sync.read(buf);
    return fromRgba8(png.width, png.height, png.data);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const jpg = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return fromRgba8(jpg.width, jpg.height, jpg.data);
  }
  throw new Error(`${path}: unsupported image format (${extname(path) || 'no extension'}); use PNG or JPEG`);
}

export { parseHexColor, toHexColor } from './color.js';
