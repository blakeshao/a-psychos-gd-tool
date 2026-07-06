// Vector ops that bend geometry point-by-point. Both flatten curves to
// polylines first (path.ts) so the deformation is uniform along the curve.

import { flattenPaths, polylinesToPaths, boundsOfPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { VectorValue } from '../engine/values';
import { valueNoise2D } from '../util/noise';

export const DisplaceNode: NodeDef = {
  type: 'Displace',
  inputs: [{ name: 'in', type: 'vector' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [
    { name: 'amount', kind: 'number', default: 8, min: 0, max: 100, step: 0.5 },
    { name: 'scale', kind: 'number', default: 40, min: 2, max: 400, step: 1 },
    { name: 'seed', kind: 'number', default: 0, min: 0, max: 9999, step: 1 },
  ],
  cook(inputs, params) {
    const src = inputs.in as VectorValue;
    const amount = Number(params.amount);
    const scale = Math.max(2, Number(params.scale));
    const seed = Number(params.seed);

    const polys = flattenPaths(src.paths);
    for (const poly of polys) {
      for (const p of poly.points) {
        // two decorrelated noise fields, one per axis
        p.x += (valueNoise2D(p.x / scale, p.y / scale, seed) - 0.5) * 2 * amount;
        p.y += (valueNoise2D(p.x / scale, p.y / scale, seed + 101) - 0.5) * 2 * amount;
      }
    }
    const paths = polylinesToPaths(polys);
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths), style: src.style };
    return { out: value };
  },
};

export const WarpNode: NodeDef = {
  type: 'Warp',
  inputs: [{ name: 'in', type: 'vector' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [
    { name: 'axis', kind: 'select', options: ['y', 'x'], default: 'y' },
    { name: 'amplitude', kind: 'number', default: 20, min: 0, max: 200, step: 1 },
    { name: 'wavelength', kind: 'number', default: 250, min: 10, max: 2000, step: 1 },
    { name: 'phase', kind: 'number', default: 0, min: 0, max: 6.28, step: 0.01 },
  ],
  cook(inputs, params) {
    const src = inputs.in as VectorValue;
    const amp = Number(params.amplitude);
    const wl = Math.max(10, Number(params.wavelength));
    const phase = Number(params.phase);
    const alongY = params.axis !== 'x';

    const polys = flattenPaths(src.paths);
    for (const poly of polys) {
      for (const p of poly.points) {
        if (alongY) p.y += amp * Math.sin((p.x / wl) * Math.PI * 2 + phase);
        else p.x += amp * Math.sin((p.y / wl) * Math.PI * 2 + phase);
      }
    }
    const paths = polylinesToPaths(polys);
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths), style: src.style };
    return { out: value };
  },
};
