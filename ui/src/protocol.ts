// Messages between the UI and the vectorizer worker.
import type { ImageInfo, ImageType, Quality, RgbaImage, SuggestedPalette, Transparency, VectorizeOptions, vectorizeRgba } from '../../src/browser';

export type WorkerOptions = Omit<VectorizeOptions, 'onProgress'>;
export type VectorResult = ReturnType<typeof vectorizeRgba>;

export type Request =
  | { id: number; kind: 'load'; image: RgbaImage }
  | { id: number; kind: 'palettes'; type: ImageType; quality: Quality; transparency: Transparency }
  | { id: number; kind: 'vectorize'; options: WorkerOptions };

export type Response =
  | { id: number; kind: 'info'; info: ImageInfo }
  | { id: number; kind: 'palettes'; palettes: SuggestedPalette[] }
  | { id: number; kind: 'progress'; stage: string }
  | { id: number; kind: 'result'; result: VectorResult }
  | { id: number; kind: 'error'; message: string };
