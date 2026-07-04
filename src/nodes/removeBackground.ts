// Remove Background (raster => raster) — a segmentation model (RMBG-1.4 via
// Transformers.js) decides which pixels are the foreground subject, and its mask
// is folded into the image's alpha so the background becomes transparent. The
// model and the masking run in a Web Worker (see traceWorker.ts), so the UI stays
// responsive; weights download from the HF hub on first cook and are then cached.

import type { NodeDef } from '../engine/registry';
import type { RasterValue } from '../engine/values';
import { runRemoveBg } from './traceClient';

export const RemoveBackgroundNode: NodeDef = {
  type: 'RemoveBackground',
  label: 'Remove Background',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [],
  async cook(inputs, _params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Remove Background needs a GPU context');
    const src = inputs.in as RasterValue;

    const imageData = await gpu.readback(src.texture);
    const cut = await runRemoveBg(imageData);

    // upload the masked pixels back into a texture (browser is the uploader, as
    // in Image/Rasterize)
    const canvas = new OffscreenCanvas(cut.width, cut.height);
    // copy into a fresh ArrayBuffer-backed array for the ImageData constructor
    const pixels = new ImageData(new Uint8ClampedArray(cut.data), cut.width, cut.height);
    canvas.getContext('2d')!.putImageData(pixels, 0, 0);
    const t = gpu.pool.acquire(cut.width, cut.height);
    gpu.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture: t.texture },
      { width: cut.width, height: cut.height },
    );

    const value: RasterValue = { kind: 'raster', texture: t, width: cut.width, height: cut.height };
    return { out: value };
  },
};
