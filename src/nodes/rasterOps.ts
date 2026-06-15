// The Phase 3 raster ops. Every one is the same shape: acquire a target,
// run one shader pass over the upstream texture(s), return a new handle.

import type { NodeDef } from '../engine/registry';
import type { AlphaValue, RasterValue } from '../engine/values';
import { hexToRgb } from '../util/color';

function requireGpu(ctx: { gpu: unknown }) {
  if (!ctx.gpu) throw new Error('raster ops need a GPU context');
}

export const DitherNode: NodeDef = {
  type: 'Dither',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'levels', kind: 'number', default: 2, min: 2, max: 8, step: 1 },
    { name: 'scale', kind: 'number', default: 2, min: 1, max: 8, step: 1 },
  ],
  cook(inputs, params, ctx) {
    requireGpu(ctx);
    const src = inputs.in as RasterValue;
    const dst = ctx.gpu!.pool.acquire(src.width, src.height);
    ctx.gpu!.runPass('dither', src.texture, dst,
      new Float32Array([Number(params.levels), Number(params.scale), 0, 0]));
    return { out: { kind: 'raster', texture: dst, width: src.width, height: src.height } satisfies RasterValue };
  },
};

export const RecolorNode: NodeDef = {
  type: 'Recolor',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'dark', kind: 'color', default: '#1c1240' },
    { name: 'light', kind: 'color', default: '#ffd27f' },
  ],
  cook(inputs, params, ctx) {
    requireGpu(ctx);
    const src = inputs.in as RasterValue;
    const dst = ctx.gpu!.pool.acquire(src.width, src.height);
    const a = hexToRgb(String(params.dark));
    const b = hexToRgb(String(params.light));
    ctx.gpu!.runPass('recolor', src.texture, dst,
      new Float32Array([...a, 1, ...b, 1]));
    return { out: { kind: 'raster', texture: dst, width: src.width, height: src.height } satisfies RasterValue };
  },
};

export const ChromaKeyNode: NodeDef = {
  type: 'ChromaKey',
  label: 'Chroma Key',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'key', kind: 'color', default: '#ffffff' },
    { name: 'tolerance', kind: 'number', default: 0.2, min: 0, max: 1, step: 0.01 },
    { name: 'softness', kind: 'number', default: 0.1, min: 0, max: 1, step: 0.01 },
  ],
  cook(inputs, params, ctx) {
    requireGpu(ctx);
    const src = inputs.in as RasterValue;
    const dst = ctx.gpu!.pool.acquire(src.width, src.height);
    const key = hexToRgb(String(params.key));
    ctx.gpu!.runPass('chromakey', src.texture, dst,
      new Float32Array([...key, 1, Number(params.tolerance), Number(params.softness), 0, 0]));
    return { out: { kind: 'raster', texture: dst, width: src.width, height: src.height } satisfies RasterValue };
  },
};

export const AsciiNode: NodeDef = {
  type: 'ASCII',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [{ name: 'cell', kind: 'number', default: 8, min: 4, max: 32, step: 1 }],
  cook(inputs, params, ctx) {
    requireGpu(ctx);
    const src = inputs.in as RasterValue;
    const dst = ctx.gpu!.pool.acquire(src.width, src.height);
    const atlas = ctx.gpu!.getAsciiAtlas();
    ctx.gpu!.runPass('ascii', [src.texture, atlas.texture], dst,
      new Float32Array([Number(params.cell), atlas.glyphs, 0, 0]));
    return { out: { kind: 'raster', texture: dst, width: src.width, height: src.height } satisfies RasterValue };
  },
};

export const ToAlphaNode: NodeDef = {
  type: 'ToAlpha',
  label: 'To Alpha',
  inputs: [{ name: 'in', type: 'raster' }],
  outputs: [{ name: 'out', type: 'alpha' }],
  params: [
    { name: 'source', kind: 'select', options: ['luminance', 'alpha'], default: 'luminance' },
    { name: 'invert', kind: 'select', options: ['no', 'yes'], default: 'no' },
  ],
  cook(inputs, params, ctx) {
    requireGpu(ctx);
    const src = inputs.in as RasterValue;
    const dst = ctx.gpu!.pool.acquire(src.width, src.height);
    ctx.gpu!.runPass('toalpha', src.texture, dst,
      new Float32Array([params.source === 'alpha' ? 1 : 0, params.invert === 'yes' ? 1 : 0, 0, 0]));
    return { out: { kind: 'alpha', texture: dst, width: src.width, height: src.height } satisfies AlphaValue };
  },
};

const COMPOSITE_MODES = ['normal', 'multiply', 'screen', 'overlay'];

export const CompositeNode: NodeDef = {
  type: 'Composite',
  inputs: [
    { name: 'base', type: 'raster' },
    { name: 'overlay', type: 'raster' },
    { name: 'mask', type: 'alpha', optional: true },
  ],
  outputs: [{ name: 'out', type: 'raster' }],
  params: [
    { name: 'mode', kind: 'select', options: COMPOSITE_MODES, default: 'normal' },
    { name: 'opacity', kind: 'number', default: 1, min: 0, max: 1, step: 0.01 },
  ],
  cook(inputs, params, ctx) {
    requireGpu(ctx);
    const base = inputs.base as RasterValue;
    const overlay = inputs.overlay as RasterValue;
    const mask = inputs.mask as AlphaValue | undefined;
    const dst = ctx.gpu!.pool.acquire(base.width, base.height);
    ctx.gpu!.runPass(
      'composite',
      [base.texture, overlay.texture, mask ? mask.texture : ctx.gpu!.white()],
      dst,
      new Float32Array([Math.max(0, COMPOSITE_MODES.indexOf(String(params.mode))), Number(params.opacity), 0, 0]),
    );
    return { out: { kind: 'raster', texture: dst, width: base.width, height: base.height } satisfies RasterValue };
  },
};
