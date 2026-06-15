// Output — the artboard / cook root. Accepts a raster or elements and
// composites them over the background at artboard resolution — paper is laid
// down here, never upstream, so ink rasters keep their alpha until the end.
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
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Output needs a GPU context to composite');
    const { width, height } = ctx.frame;
    const [r, g, b] = hexToRgb(String(params.background));
    // a raster lifts to a single centered element — same compositing path
    const texture = renderElements(gpu, ctx.fonts, asElements(input), width, height, { r, g, b, a: 1 });
    return { out: { kind: 'raster', texture, width, height } satisfies RasterValue };
  },
};
