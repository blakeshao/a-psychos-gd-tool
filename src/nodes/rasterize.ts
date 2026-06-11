// Rasterize (vector => raster) — the CPU→GPU boundary crossing. Resolution is
// introduced HERE, by an explicit param, and everything downstream inherits it.
//
// Scaffold note: paths are drawn via OffscreenCanvas 2D (the browser is the
// tessellator) and uploaded once. Real GPU tessellation can replace the body
// of this cook later without touching its sockets.

import type { NodeDef } from '../engine/registry';
import type { PathCmd, RasterValue, VectorValue } from '../engine/values';

export const RasterizeNode: NodeDef = {
  type: 'Rasterize',
  inputs: [{ name: 'vector', type: 'vector' }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'width', kind: 'number', default: 768, min: 16, max: 4096, step: 1 },
    { name: 'height', kind: 'number', default: 512, min: 16, max: 4096, step: 1 },
  ],
  cook(inputs, params, ctx) {
    const gpu = ctx.gpu;
    if (!gpu) throw new Error('Rasterize needs a GPU context');
    const vector = inputs.vector as VectorValue;
    const width = Math.round(Number(params.width));
    const height = Math.round(Number(params.height));

    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext('2d')!;
    c2d.fillStyle = '#ffffff';
    c2d.fillRect(0, 0, width, height);

    // center the geometry on the artboard
    const b = vector.bounds;
    c2d.translate(width / 2 - (b.x + b.width / 2), height / 2 - (b.y + b.height / 2));
    c2d.fillStyle = '#000000';
    // one fill across ALL subpaths: hole contours must subtract via nonzero
    // winding, which only works inside a single path
    const combined = new Path2D();
    for (const path of vector.paths) appendPath(combined, path);
    c2d.fill(combined);

    const t = gpu.pool.acquire(width, height);
    gpu.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture: t.texture },
      { width, height },
    );

    const value: RasterValue = { kind: 'raster', texture: t, width, height };
    return { out: value };
  },
};

function appendPath(p: Path2D, cmds: PathCmd[]) {
  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'M': p.moveTo(cmd.x, cmd.y); break;
      case 'L': p.lineTo(cmd.x, cmd.y); break;
      case 'C': p.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
      case 'Q': p.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y); break;
      case 'Z': p.closePath(); break;
    }
  }
}
