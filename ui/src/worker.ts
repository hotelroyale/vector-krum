// Runs the vectorizer off the main thread. The image is sent once ('load') and kept here.
import { imageFromRgba, inspectImage, suggestPalettes, vectorizeRgba } from '../../src/browser';
import type { Image, RgbaImage } from '../../src/browser';
import type { Request, Response } from './protocol';

let rgba: RgbaImage | undefined;
let image: Image | undefined;

const post = (r: Response) => (self as unknown as Worker).postMessage(r);

self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    if (req.kind === 'load') {
      rgba = req.image;
      image = imageFromRgba(rgba);
      post({ id: req.id, kind: 'info', info: inspectImage(image) });
      return;
    }
    if (!image || !rgba) throw new Error('no image loaded');
    if (req.kind === 'palettes') {
      post({ id: req.id, kind: 'palettes', palettes: suggestPalettes(image, req.type, req.quality, req.transparency) });
    } else if (req.kind === 'vectorize') {
      const result = vectorizeRgba(rgba, { ...req.options, onProgress: (stage) => post({ id: req.id, kind: 'progress', stage }) });
      post({ id: req.id, kind: 'result', result });
    }
  } catch (err) {
    post({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
