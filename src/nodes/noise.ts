// Noise — generated raster source. Deterministic by (seed, scale, size): the
// same params always produce the same pixels, so the cook cache stays honest.

import type { NodeDef } from '../engine/registry';
import type { RasterValue } from '../engine/values';
import { latticeHash, valueNoise2D } from '../util/noise';

export const NoiseNode: NodeDef = {
  type: 'Noise',
  inputs: [],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'mode', kind: 'select', options: ['value', 'grain'], default: 'value' },
    { name: 'scale', kind: 'number', default: 64, min: 1, max: 256, step: 1 },
    { name: 'seed', kind: 'number', default: 7, min: 0, max: 9999, step: 1 },
  ],
  usesFrame: true,
  cook(_inputs, params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Noise needs a GPU context');
    const { width, height } = ctx.frame;
    const seed = Number(params.seed);
    const scale = Math.max(1, Number(params.scale));
    const grain = params.mode === 'grain';

    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = grain ? latticeHash(x, y, seed) : valueNoise2D(x / scale, y / scale, seed);
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
