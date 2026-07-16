// The generators: no counts — structure (lattice, arc-length gap, density)
// decides how many slots exist — and the mask input trims slots to its
// coverage, against both mask kinds (raster: alpha channel, alpha: To
// Alpha's RGB).

import { describe, expect, it } from 'vitest';
import type { CookContext } from '../engine/registry';
import type { AlphaValue, LayoutValue, RasterValue, VectorValue } from '../engine/values';
import { boundsOfPaths } from '../engine/path';
import { FunctionLayoutNode, GridNode, RandomLayoutNode, SamplePathNode } from './layout';

const FRAME = { width: 200, height: 100 };

/** ctx whose gpu readback returns a frame-sized image, left half in-mask. */
function maskCtx(kind: 'raster' | 'alpha'): CookContext {
  const data = new Uint8ClampedArray(FRAME.width * FRAME.height * 4);
  for (let y = 0; y < FRAME.height; y++) {
    for (let x = 0; x < FRAME.width; x++) {
      const o = (y * FRAME.width + x) * 4;
      const inside = x < FRAME.width / 2 ? 255 : 0;
      if (kind === 'raster') {
        data[o] = data[o + 1] = data[o + 2] = 128;
        data[o + 3] = inside; // a cutout: silhouette rides in alpha
      } else {
        data[o] = data[o + 1] = data[o + 2] = inside; // To Alpha writes RGB
        data[o + 3] = 255;
      }
    }
  }
  const gpu = { readback: async () => ({ data, width: FRAME.width, height: FRAME.height }) };
  return { gpu: gpu as never, fonts: new Map(), frame: FRAME };
}

function mask(kind: 'raster' | 'alpha'): RasterValue | AlphaValue {
  return { kind, texture: {} as never, width: FRAME.width, height: FRAME.height };
}

function defaults(def: { params: { name: string; default: unknown }[] }) {
  const p: Record<string, string | number | boolean> = {};
  for (const spec of def.params) p[spec.name] = spec.default as string | number | boolean;
  return p;
}

const layoutOf = (out: unknown) => (out as { out: LayoutValue }).out;

describe('Grid mask', () => {
  it('keeps only in-mask cells and renumbers them as a fresh run', async () => {
    const ctx = maskCtx('raster');
    const params = { ...defaults(GridNode), columns: 4, rows: 2, padX: 10, padY: 10 };
    const full = layoutOf(await GridNode.cook({}, params, ctx));
    const masked = layoutOf(await GridNode.cook({ mask: mask('raster') }, params, ctx));

    expect(full.placements).toHaveLength(8);
    expect(masked.placements).toHaveLength(4); // left 2 of 4 columns survive
    expect(masked.placements.every((p) => p.x < 0)).toBe(true);
    // born a clean run: index 0..n-1, progress spans 0..1
    expect(masked.placements.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    expect(masked.placements[0].progress).toBe(0);
    expect(masked.placements[3].progress).toBe(1);
  });

  it('reads an alpha-kind mask from RGB', async () => {
    const ctx = maskCtx('alpha');
    const params = { ...defaults(GridNode), columns: 4, rows: 2, padX: 10, padY: 10 };
    const masked = layoutOf(await GridNode.cook({ mask: mask('alpha') }, params, ctx));
    expect(masked.placements).toHaveLength(4);
    expect(masked.placements.every((p) => p.x < 0)).toBe(true);
  });
});

describe('Random', () => {
  it('derives how many fit from spacing; the mask trims and renumbers', async () => {
    const ctx = maskCtx('raster');
    // 180×80 at spacing 20 → one point per 400px² of area = 36
    const params = { ...defaults(RandomLayoutNode), spacing: 20, areaWidth: 180, areaHeight: 80 };
    const free = layoutOf(await RandomLayoutNode.cook({}, params, ctx));
    const masked = layoutOf(await RandomLayoutNode.cook({ mask: mask('raster') }, params, ctx));

    expect(free.placements).toHaveLength(36);
    // the mask trims the same set — spacing (density) holds, count follows
    const freeLeft = free.placements.filter((p) => p.x < 0);
    expect(masked.placements.map((p) => [p.x, p.y])).toEqual(freeLeft.map((p) => [p.x, p.y]));
    // survivors are born a clean run: index 0..n-1, progress spans 0..1
    expect(masked.placements.map((p) => p.index)).toEqual([...masked.placements.keys()]);
    expect(masked.placements[0].progress).toBe(0);
    expect(masked.placements[masked.placements.length - 1].progress).toBe(1);
  });

  it('is deterministic', async () => {
    const ctx = maskCtx('raster');
    const params = { ...defaults(RandomLayoutNode), spacing: 20, areaWidth: 180, areaHeight: 80 };
    const a = layoutOf(await RandomLayoutNode.cook({ mask: mask('raster') }, params, ctx));
    const b = layoutOf(await RandomLayoutNode.cook({ mask: mask('raster') }, params, ctx));
    expect(a.placements).toEqual(b.placements);
  });

  it('poisson-disk packs with spacing as the min distance', async () => {
    const ctx = maskCtx('raster');
    const params = {
      ...defaults(RandomLayoutNode),
      distribution: 'poisson-disk', spacing: 30, areaWidth: 180, areaHeight: 80,
    };
    const { placements } = layoutOf(await RandomLayoutNode.cook({}, params, ctx));
    expect(placements.length).toBeGreaterThan(2);
    for (const a of placements) {
      for (const b of placements) {
        if (a === b) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('gaussian clusters around the center, refilling its out-of-area tail', async () => {
    const ctx = maskCtx('raster');
    const params = {
      ...defaults(RandomLayoutNode),
      distribution: 'gaussian', spacing: 20, areaWidth: 180, areaHeight: 80,
    };
    const { placements } = layoutOf(await RandomLayoutNode.cook({}, params, ctx));
    expect(placements).toHaveLength(36); // the tail refills, the quota holds
    expect(placements.every((p) => Math.abs(p.x) <= 90 && Math.abs(p.y) <= 40)).toBe(true);
    // σ = extent/4 puts ~46% in the central quarter-area box vs 25% uniform
    const central = placements.filter((p) => Math.abs(p.x) < 45 && Math.abs(p.y) < 20);
    expect(central.length).toBeGreaterThan(36 * 0.25);
  });

  it('masked jitter keeps points inside the mask', async () => {
    const ctx = maskCtx('raster');
    const gridParams = { ...defaults(GridNode), columns: 4, rows: 2, padX: 10, padY: 10 };
    const grid = layoutOf(await GridNode.cook({ mask: mask('raster') }, gridParams, ctx));
    const params = { ...defaults(RandomLayoutNode), offset: 40 };
    const jittered = layoutOf(
      await RandomLayoutNode.cook({ layout: grid, mask: mask('raster') }, params, ctx),
    );
    expect(jittered.placements).toHaveLength(grid.placements.length);
    expect(jittered.placements.every((p) => p.x < 0)).toBe(true);
  });
});

describe('Function', () => {
  it('derives how many fit from the gap and the curve length', async () => {
    const ctx = maskCtx('raster');
    // circumference 2π·40 ≈ 251 at gap 20 → 12 slots on the loop
    const params = { ...defaults(FunctionLayoutNode), fn: 'circle', gap: 20, radius: 40 };
    const full = layoutOf(await FunctionLayoutNode.cook({}, params, ctx));
    expect(full.placements).toHaveLength(12);
    expect(full.closed).toBe(true);
    expect(full.placements.every((p) => Math.abs(Math.hypot(p.x, p.y) - 40) < 0.5)).toBe(true);

    const dense = layoutOf(await FunctionLayoutNode.cook({}, { ...params, gap: 10 }, ctx));
    expect(dense.placements).toHaveLength(25); // halve the gap, double the slots
  });

  it('wave width sets the extent, not a count param', async () => {
    const ctx = maskCtx('raster');
    const params = { ...defaults(FunctionLayoutNode), fn: 'wave', gap: 20, width: 200 };
    const narrow = layoutOf(await FunctionLayoutNode.cook({}, params, ctx));
    const wide = layoutOf(await FunctionLayoutNode.cook({}, { ...params, width: 400 }, ctx));
    expect(narrow.placements.length).toBeGreaterThan(0);
    expect(wide.placements.length).toBeGreaterThan(narrow.placements.length);
    expect(narrow.placements.every((p) => Math.abs(p.x) <= 100)).toBe(true);
  });

  it('trims out-of-mask slots, keeps arc progress, opens the loop', async () => {
    const ctx = maskCtx('raster');
    const params = { ...defaults(FunctionLayoutNode), fn: 'circle', gap: 20, radius: 40 };
    const full = layoutOf(await FunctionLayoutNode.cook({}, params, ctx));
    const masked = layoutOf(await FunctionLayoutNode.cook({ mask: mask('raster') }, params, ctx));

    expect(masked.placements.length).toBeLessThan(full.placements.length);
    expect(masked.placements.length).toBeGreaterThan(0);
    expect(masked.placements.every((p) => p.x < 0)).toBe(true);
    expect(masked.closed).toBeUndefined(); // the mask cut the loop
    // survivors keep their true arc position but are renumbered from birth
    expect(masked.placements.map((p) => p.index)).toEqual([...masked.placements.keys()]);
    const fullByPos = new Map(full.placements.map((p) => [`${p.x},${p.y}`, p.progress]));
    for (const p of masked.placements) expect(p.progress).toBe(fullByPos.get(`${p.x},${p.y}`));
  });

  it('returns an empty layout when the mask misses the curve entirely', async () => {
    const ctx = maskCtx('raster');
    const data = new Uint8ClampedArray(FRAME.width * FRAME.height * 4); // all 0
    (ctx.gpu as unknown as { readback: () => Promise<unknown> }).readback =
      async () => ({ data, width: FRAME.width, height: FRAME.height });
    const params = { ...defaults(FunctionLayoutNode), fn: 'circle', gap: 20, radius: 40 };
    const masked = layoutOf(await FunctionLayoutNode.cook({ mask: mask('raster') }, params, ctx));
    expect(masked.placements).toHaveLength(0);
  });
});

describe('Sample Path mask', () => {
  it('trims out-of-mask samples, keeps arc progress, opens the loop', async () => {
    const ctx = maskCtx('raster');
    // a centered 120×60 rectangle (recentering is a no-op; straddles the mask edge)
    const paths = [[
      { type: 'M' as const, x: -60, y: -30 },
      { type: 'L' as const, x: 60, y: -30 },
      { type: 'L' as const, x: 60, y: 30 },
      { type: 'L' as const, x: -60, y: 30 },
      { type: 'Z' as const },
    ]];
    const vector: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    const params = { ...defaults(SamplePathNode), gap: 20 };
    const full = layoutOf(await SamplePathNode.cook({ path: vector }, params, ctx));
    const masked = layoutOf(await SamplePathNode.cook({ path: vector, mask: mask('raster') }, params, ctx));

    expect(full.closed).toBe(true);
    expect(masked.placements.length).toBeLessThan(full.placements.length);
    expect(masked.placements.length).toBeGreaterThan(0);
    expect(masked.placements.every((p) => p.x < 0)).toBe(true);
    expect(masked.closed).toBe(false);
    // survivors keep their true arc position but are renumbered from birth
    expect(masked.placements.map((p) => p.index)).toEqual([...masked.placements.keys()]);
    const fullByPos = new Map(full.placements.map((p) => [`${p.x},${p.y}`, p.progress]));
    for (const p of masked.placements) expect(p.progress).toBe(fullByPos.get(`${p.x},${p.y}`));
  });
});
