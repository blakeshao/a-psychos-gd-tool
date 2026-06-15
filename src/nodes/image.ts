// Image — an uploaded bitmap as a raster source. The file is decoded to an
// ImageBitmap and drawn onto a frame-sized canvas, so it shares the raster
// lane's resolution (like Noise / Rasterize) and composes downstream as ink on
// a transparent ground. The image bytes live in the `src` param as a data: URI
// so the picture travels with the document — no external asset store.

import type { NodeDef } from '../engine/registry';
import type { RasterValue } from '../engine/values';

export const ImageNode: NodeDef = {
  type: 'Image',
  inputs: [],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'src', kind: 'image', default: '' },
    // how the image's native size maps onto the artboard before scaleX/scaleY
    { name: 'fit', kind: 'select', options: ['contain', 'cover', 'stretch', 'actual'], default: 'contain' },
    // negative scale mirrors the image (free horizontal/vertical flip)
    { name: 'scaleX', kind: 'number', default: 1, min: -8, max: 8, step: 0.01 },
    { name: 'scaleY', kind: 'number', default: 1, min: -8, max: 8, step: 0.01 },
    { name: 'offsetX', kind: 'number', default: 0, min: -4096, max: 4096, step: 1 },
    { name: 'offsetY', kind: 'number', default: 0, min: -4096, max: 4096, step: 1 },
    { name: 'rotation', kind: 'number', default: 0, min: -180, max: 180, step: 1 },
    { name: 'opacity', kind: 'number', default: 1, min: 0, max: 1, step: 0.01 },
  ],
  usesFrame: true,
  async cook(_inputs, params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Image needs a GPU context');
    const { width, height } = ctx.frame;

    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext('2d')!;

    const src = String(params.src);
    if (src) {
      const bmp = await createImageBitmap(await (await fetch(src)).blob());

      // base scale fits the native bitmap to the frame; scaleX/scaleY ride on top
      let baseX = 1;
      let baseY = 1;
      const fit = String(params.fit);
      if (fit === 'contain') baseX = baseY = Math.min(width / bmp.width, height / bmp.height);
      else if (fit === 'cover') baseX = baseY = Math.max(width / bmp.width, height / bmp.height);
      else if (fit === 'stretch') { baseX = width / bmp.width; baseY = height / bmp.height; }
      // 'actual' keeps the bitmap at 1:1 pixels

      const sx = baseX * Number(params.scaleX);
      const sy = baseY * Number(params.scaleY);

      c2d.translate(width / 2 + Number(params.offsetX), height / 2 + Number(params.offsetY));
      c2d.rotate((Number(params.rotation) * Math.PI) / 180);
      c2d.scale(sx, sy);
      c2d.globalAlpha = Math.max(0, Math.min(1, Number(params.opacity)));
      c2d.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
      bmp.close();
    }

    const t = gpu.pool.acquire(width, height);
    gpu.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture: t.texture },
      { width, height },
    );
    return { out: { kind: 'raster', texture: t, width, height } satisfies RasterValue };
  },
};
