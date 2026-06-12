// Output — the artboard / cook root. Accepts a finished raster (passthrough)
// OR elements, which it composites natively in z-order at artboard resolution.
// Requesting it forces the graph to cook; export & color space land here later.

import type { NodeDef } from '../engine/registry';
import type { ElementsValue, RasterValue } from '../engine/values';
import { renderElements } from '../gpu/elementRenderer';
import { hexToRgb } from '../util/color';
import { asElements } from './elements';

export const OutputNode: NodeDef = {
  type: 'Output',
  inputs: [{ name: 'in', type: ['raster', 'elements'] }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [{ name: 'background', kind: 'color', default: '#ffffff' }],
  usesFrame: true,
  cook(inputs, params, ctx) {
    const input = inputs.in as RasterValue | ElementsValue;

    if (input.kind === 'raster') {
      // passthrough shares the upstream texture, so this cache entry takes its
      // own ref — each entry owns exactly one ref to each texture it holds
      ctx.gpu?.pool.retain(input.texture);
      return { out: { ...input } satisfies RasterValue };
    }

    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Output needs a GPU context to composite elements');
    const { width, height } = ctx.frame;
    const [r, g, b] = hexToRgb(String(params.background));
    const texture = renderElements(gpu, ctx.fonts, asElements(input), width, height, { r, g, b, a: 1 });
    return { out: { kind: 'raster', texture, width, height } satisfies RasterValue };
  },
};
