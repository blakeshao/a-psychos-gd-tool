// Outline Image (raster => vector) — traces a hollow outline around the image's
// silhouette (its alpha shape). Pairs with Remove Background: cut the subject
// out, then outline it. The GPU→CPU readback happens here; the tracing runs in a
// Web Worker (see traceWorker.ts) so it never blocks the UI.

import { boundsOfPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { RasterValue, VectorValue } from '../engine/values';
import { runTrace } from './traceClient';

export const OutlineImageNode: NodeDef = {
  type: 'OutlineImage',
  label: 'Outline Image',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [
    // outline stroke width, in (capped) pixels — scales up with the image
    { name: 'thickness', kind: 'number', default: 6, min: 1, max: 40, step: 1 },
    // alpha cutoff that separates the image's shape from its transparent ground
    { name: 'threshold', kind: 'number', default: 128, min: 1, max: 255, step: 1 },
    { name: 'smoothness', kind: 'number', default: 1, min: 0.1, max: 10, step: 0.1 },
    { name: 'minArea', kind: 'number', default: 8, min: 0, max: 100, step: 1 },
  ],
  async cook(inputs, params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Outline Image needs a GPU context');
    const src = inputs.in as RasterValue;

    const imageData = await gpu.readback(src.texture);
    const paths = await runTrace({
      op: 'silhouette',
      imageData,
      smoothness: Number(params.smoothness),
      minArea: Number(params.minArea),
      threshold: Number(params.threshold),
      dropLight: true,
      thickness: Number(params.thickness),
    });

    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    return { out: value };
  },
};
