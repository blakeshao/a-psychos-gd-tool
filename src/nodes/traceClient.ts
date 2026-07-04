// Main-thread handle to the trace worker (see traceWorker.ts). One worker is
// created lazily on first use and reused; requests are matched to responses by id.
// Node cooks read a texture back from the GPU and hand the pixels here:
//  - runTrace()    → vector paths (composite / sobel / silhouette ops)
//  - runRemoveBg() → the image with its background cut out (removebg op)

import type { PathCmd } from '../engine/values';

export interface TraceRequest {
  op: 'composite' | 'sobel' | 'silhouette' | 'removebg';
  imageData: ImageData;
  smoothness: number;
  minArea: number;
  threshold: number;
  dropLight: boolean;
  /** silhouette op: outline band width in (capped) pixels */
  thickness?: number;
}

interface WorkerImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
interface WorkerReply {
  id: number;
  paths?: PathCmd[][];
  image?: WorkerImage;
  error?: string;
}

let worker: Worker | null = null;
let seq = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./traceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const { id, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(e.data);
    };
    worker.onerror = (e) => {
      // a worker-level failure can't be tied to one request — fail them all
      for (const p of pending.values()) p.reject(new Error(e.message || 'trace worker error'));
      pending.clear();
    };
  }
  return worker;
}

// post the readback pixels to the worker; the ImageData isn't used again, so
// transfer its buffer (zero-copy) rather than cloning it across the boundary.
function dispatch(req: Omit<TraceRequest, 'imageData'>, imageData: ImageData): Promise<WorkerReply> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<WorkerReply>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(
      { id, ...req, width: imageData.width, height: imageData.height, data: imageData.data.buffer },
      [imageData.data.buffer],
    );
  });
}

export async function runTrace(req: TraceRequest): Promise<PathCmd[][]> {
  const { imageData, ...rest } = req;
  const reply = await dispatch(rest, imageData);
  return reply.paths ?? [];
}

export async function runRemoveBg(imageData: ImageData): Promise<WorkerImage> {
  const reply = await dispatch(
    { op: 'removebg', smoothness: 0, minArea: 0, threshold: 0, dropLight: false },
    imageData,
  );
  if (!reply.image) throw new Error('remove background: no image returned');
  return reply.image;
}
