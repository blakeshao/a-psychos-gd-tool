// Noise — generated raster source. Deterministic by (seed, scale, size): the
// same params always produce the same pixels, so the cook cache stays honest.

import type { NodeDef } from '../engine/registry';
import type { RasterValue } from '../engine/values';

/** integer lattice hash -> 0..1, stable across runs */
function latticeHash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export const NoiseNode: NodeDef = {
  type: 'Noise',
  inputs: [],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'width', kind: 'number', default: 768, min: 16, max: 4096, step: 1 },
    { name: 'height', kind: 'number', default: 512, min: 16, max: 4096, step: 1 },
    { name: 'mode', kind: 'select', options: ['value', 'grain'], default: 'value' },
    { name: 'scale', kind: 'number', default: 64, min: 1, max: 256, step: 1 },
    { name: 'seed', kind: 'number', default: 7, min: 0, max: 9999, step: 1 },
  ],
  cook(_inputs, params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Noise needs a GPU context');
    const width = Math.round(Number(params.width));
    const height = Math.round(Number(params.height));
    const seed = Number(params.seed);
    const scale = Math.max(1, Number(params.scale));
    const grain = params.mode === 'grain';

    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v: number;
        if (grain) {
          v = latticeHash(x, y, seed);
        } else {
          const fx = x / scale, fy = y / scale;
          const ix = Math.floor(fx), iy = Math.floor(fy);
          const tx = smooth(fx - ix), ty = smooth(fy - iy);
          const a = latticeHash(ix, iy, seed), b = latticeHash(ix + 1, iy, seed);
          const c = latticeHash(ix, iy + 1, seed), d = latticeHash(ix + 1, iy + 1, seed);
          v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        }
        const i = (y * width + x) * 4;
        const byte = Math.round(v * 255);
        data[i] = byte; data[i + 1] = byte; data[i + 2] = byte; data[i + 3] = 255;
      }
    }

    const t = gpu.pool.acquire(width, height);
    gpu.device.queue.writeTexture(
      { texture: t.texture },
      data,
      { bytesPerRow: width * 4 },
      { width, height },
    );
    const value: RasterValue = { kind: 'raster', texture: t, width, height };
    return { out: value };
  },
};
