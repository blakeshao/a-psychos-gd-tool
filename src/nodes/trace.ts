// Trace (raster => vector) — pixels become paths. The expensive GPU→CPU
// boundary crossing: readback + imagetracerjs. Async, like a model node —
// the evaluator awaits it and caches the result like any other cook.

import ImageTracer from 'imagetracerjs';
import { boundsOfPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { PathCmd, RasterValue, VectorValue } from '../engine/values';

export const TraceNode: NodeDef = {
  type: 'Trace',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [
    { name: 'smoothness', kind: 'number', default: 1, min: 0.1, max: 10, step: 0.1 },
    { name: 'minArea', kind: 'number', default: 8, min: 0, max: 100, step: 1 },
    { name: 'ignoreLight', kind: 'select', options: ['yes', 'no'], default: 'yes' },
  ],
  async cook(inputs, params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Trace needs a GPU context');
    const src = inputs.in as RasterValue;

    const imageData = await gpu.readback(src.texture);
    const traced = ImageTracer.imagedataToTracedata(imageData, {
      ltres: Number(params.smoothness),
      qtres: Number(params.smoothness),
      pathomit: Number(params.minArea),
      numberofcolors: 2,
      colorsampling: 0,
      blurradius: 0,
    });

    const paths: PathCmd[][] = [];
    traced.layers.forEach((layer, li) => {
      const c = traced.palette[li];
      const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
      // with 2 colors the light layer is the background — usually unwanted
      if (params.ignoreLight === 'yes' && lum > 0.5) return;
      for (const path of layer) {
        if (path.segments.length === 0) continue;
        const cmds: PathCmd[] = [{ type: 'M', x: path.segments[0].x1, y: path.segments[0].y1 }];
        for (const s of path.segments) {
          if (s.type === 'Q' && s.x3 !== undefined && s.y3 !== undefined) {
            cmds.push({ type: 'Q', x1: s.x2, y1: s.y2, x: s.x3, y: s.y3 });
          } else {
            cmds.push({ type: 'L', x: s.x2, y: s.y2 });
          }
        }
        cmds.push({ type: 'Z' });
        paths.push(cmds);
      }
    });

    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    return { out: value };
  },
};
