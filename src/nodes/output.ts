// Output — the artboard / cook root. Requesting it forces the graph to cook.
// For now it passes the raster through; export & color space land here later.

import type { NodeDef } from '../engine/registry';
import type { RasterValue } from '../engine/values';

export const OutputNode: NodeDef = {
  type: 'Output',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [],
  cook(inputs, _params, ctx) {
    const src = inputs.in as RasterValue;
    // passthrough shares the upstream texture, so this cache entry takes its
    // own ref — each entry owns exactly one ref to each texture it holds
    ctx.gpu?.pool.retain(src.texture);
    const value: RasterValue = { ...src };
    return { out: value };
  },
};
