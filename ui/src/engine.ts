// Promise-based client for the vectorizer worker. A new request of the same kind supersedes a
// running one: the worker is restarted (the computation cannot be interrupted otherwise) and the
// old promise rejects with a Cancelled error.
import type { ImageInfo, ImageType, Quality, RgbaImage, SuggestedPalette, Transparency } from '../../src/browser';
import type { Request, Response, VectorResult, WorkerOptions } from './protocol';

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

interface Pending {
  kind: Request['kind'];
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: string) => void;
}

type Payload = Request extends infer R ? (R extends Request ? Omit<R, 'id'> : never) : never;

export class Engine {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private image?: RgbaImage;

  constructor() {
    this.start();
  }

  private start() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const r = e.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      if (r.kind === 'progress') return p.onProgress?.(r.stage);
      this.pending.delete(r.id);
      if (r.kind === 'error') p.reject(new Error(r.message));
      else p.resolve(r);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker failed'));
      this.pending.clear();
    };
  }

  /** Stops whatever runs and starts a fresh worker with the current image. */
  private restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Cancelled());
    this.pending.clear();
    this.start();
    if (this.image) this.worker.postMessage({ id: 0, kind: 'load', image: this.image } satisfies Request);
  }

  private send(req: Payload, onProgress?: (stage: string) => void): Promise<Response> {
    if ([...this.pending.values()].some((p) => p.kind === req.kind || req.kind === 'load')) this.restart();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: req.kind, resolve, reject, onProgress });
      this.worker.postMessage({ ...req, id });
    });
  }

  async load(image: RgbaImage): Promise<ImageInfo> {
    this.image = undefined; // a restart inside send() must not post it a second time
    const sent = this.send({ kind: 'load', image });
    this.image = image;
    const r = await sent;
    return (r as Extract<Response, { kind: 'info' }>).info;
  }

  async palettes(type: ImageType, quality: Quality, transparency: Transparency): Promise<SuggestedPalette[]> {
    const r = await this.send({ kind: 'palettes', type, quality, transparency });
    return (r as Extract<Response, { kind: 'palettes' }>).palettes;
  }

  async vectorize(options: WorkerOptions, onProgress?: (stage: string) => void): Promise<VectorResult> {
    const r = await this.send({ kind: 'vectorize', options }, onProgress);
    return (r as Extract<Response, { kind: 'result' }>).result;
  }
}
