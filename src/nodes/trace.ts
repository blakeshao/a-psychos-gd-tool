// Trace (raster => vector) — pixels become paths. The expensive GPU→CPU readback
// happens here on the main thread; the actual tracing (imagetracer / Sobel) is
// handed to a Web Worker so it never blocks the UI. See traceWorker.ts.

import { boundsOfPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { RasterValue, VectorValue } from '../engine/values';
import { runTrace } from './traceClient';

export const TraceNode: NodeDef = {
  type: 'Trace',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [
    // fill: quantize to ink/ground and trace filled regions (the original method).
    // sobel: detect edges first, then trace the resulting line map — good for
    // turning photos/gradients into outlines rather than solid shapes.
    { name: 'method', kind: 'select', options: ['fill', 'sobel'], default: 'fill' },
    { name: 'smoothness', kind: 'number', default: 1, min: 0.1, max: 10, step: 0.1 },
    { name: 'minArea', kind: 'number', default: 8, min: 0, max: 100, step: 1 },
    // gradient-magnitude cutoff (0..~1442); only the sobel method reads it
    {
      name: 'threshold',
      kind: 'number',
      default: 100,
      min: 0,
      max: 500,
      step: 1,
      showIf: { param: 'method', in: ['sobel'] },
    },
    {
      name: 'ignoreLight',
      kind: 'select',
      options: ['yes', 'no'],
      default: 'yes',
      showIf: { param: 'method', in: ['fill'] },
    },
  ],
  async cook(inputs, params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Trace needs a GPU context');
    const src = inputs.in as RasterValue;

    const imageData = await gpu.readback(src.texture);
    const method = String(params.method);
    // sobel draws dark edges on a light ground — the light layer is always the
    // background. for fill it's the user's call.
    const paths = await runTrace({
      op: method === 'sobel' ? 'sobel' : 'composite',
      imageData,
      smoothness: Number(params.smoothness),
      minArea: Number(params.minArea),
      threshold: Number(params.threshold),
      dropLight: method === 'sobel' || params.ignoreLight === 'yes',
    });

    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    return { out: value };
  },
};
