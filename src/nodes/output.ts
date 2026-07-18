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
  // optional input: an unwired Output is an empty artboard (bare paper, or
  // nothing at all when transparent) — a fresh layer cooks clean before it's wired
  inputs: [{ name: 'in', type: ['raster', 'elements'], optional: true }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    // a transparent layer leaves the paper to the layers below it
    { name: 'transparent', kind: 'toggle', default: false },
    { name: 'background', kind: 'color', default: '#ffffff', showIf: { param: 'transparent', in: ['false'] } },
  ],
  usesFrame: true,
  cook(inputs, params, ctx) {
    const input = inputs.in as RasterValue | ElementsValue | undefined;
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Output needs a GPU context to composite');
    const { width, height } = ctx.frame;
    const [r, g, b] = hexToRgb(String(params.background));
    const background = params.transparent === true ? { r: 0, g: 0, b: 0, a: 0 } : { r, g, b, a: 1 };
    // a raster lifts to a single centered element — same compositing path
    const texture = renderElements(gpu, ctx.fonts, input ? asElements(input) : [], width, height, background);
    return { out: { kind: 'raster', texture, width, height } satisfies RasterValue };
  },
};
