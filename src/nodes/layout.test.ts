// The generators: no counts — structure (lattice, arc-length gap, density)
// decides how many slots exist — and the mask input trims slots to its
// coverage, against both mask kinds (raster: alpha channel, alpha: To
// Alpha's RGB).

import { describe, expect, it } from 'vitest';
import type { CookContext } from '../engine/registry';
import type { AlphaValue, LayoutValue, RasterValue, VectorValue } from '../engine/values';
import { arcCellOutline, boundsOfPaths } from '../engine/path';
import { DrawLayoutNode, FunctionLayoutNode, GridNode, JitterNode, RadialNode, RandomLayoutNode, SamplePathNode, ShuffleNode } from './layout';

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

describe('Radial', () => {
  const ctx = maskCtx('raster');
  const radial = async (over: Record<string, string | number> = {}) =>
    layoutOf(await RadialNode.cook({}, { ...defaults(RadialNode), ...over }, ctx));
  /** slots grouped by the ring they belong to, inner ring first */
  const rings = (l: LayoutValue) => {
    const by = new Map<number, typeof l.placements>();
    for (const p of l.placements) {
      const r = Math.round(p.arc!.r0 * 1e3) / 1e3;
      (by.get(r) ?? by.set(r, []).get(r)!).push(p);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]);
  };

  it('lays concentric rings of cells that partition the annulus', async () => {
    const l = await radial({ rings: 3, spokes: 8, radius: 300, innerRadius: 0 });
    expect(l.placements).toHaveLength(24);

    const byRing = rings(l);
    expect(byRing.map(([r0]) => r0)).toEqual([0, 100, 200]); // uniform tracks of 100
    for (const [r0, cells] of byRing) {
      expect(cells).toHaveLength(8);
      expect(cells.every((p) => p.arc!.r1 - p.arc!.r0 === 100 && p.h === 100)).toBe(true);
      // the sectors cover the full turn exactly, with no overlap and no seam
      const spans = cells.map((p) => [p.arc!.a0, p.arc!.a1]).sort((a, b) => a[0] - b[0]);
      expect(spans.reduce((s, [a0, a1]) => s + (a1 - a0), 0)).toBeCloseTo(Math.PI * 2, 6);
      for (let i = 0; i < spans.length - 1; i++) expect(spans[i][1]).toBeCloseTo(spans[i + 1][0], 6);
      // slots sit at the middle of their own cell
      const rMid = r0 + 50;
      expect(cells.every((p) => Math.abs(Math.hypot(p.x, p.y) - rMid) < 1e-9)).toBe(true);
    }
    // polar, so no cartesian track identity to hand Shuffle's tracks mode
    expect(l.placements.every((p) => p.col === undefined && p.row === undefined)).toBe(true);
  });

  it('spokes only cut the rings up — they never change the rings', async () => {
    const band = (l: LayoutValue) => [...new Set(l.placements.map((p) => `${p.arc!.r0}..${p.arc!.r1}`))];
    const covers = (l: LayoutValue) => rings(l).map(([, cells]) => {
      const spans = cells.map((p) => [p.arc!.a0, p.arc!.a1]).sort((a, b) => a[0] - b[0]);
      return [spans[0][0], spans.at(-1)![1]] as [number, number];
    });

    const sparse = await radial({ rings: 3, spokes: 3, radius: 300 });
    const dense = await radial({ rings: 3, spokes: 64, radius: 300 });
    // same rings, at a 21× finer cut: the bands and the turn they cover are
    // identical, only the internal cuts moved
    expect(band(dense)).toEqual(band(sparse));
    covers(dense).forEach(([a0, a1], i) => {
      expect(a0).toBeCloseTo(covers(sparse)[i][0], 9);
      expect(a1).toBeCloseTo(covers(sparse)[i][1], 9);
    });
    expect(dense.placements).toHaveLength(3 * 64);
    // the cell is the sector, so a ring's cells stay congruent to the ring:
    // one spoke means one cell that is the whole ring
    const whole = await radial({ rings: 1, spokes: 1, radius: 300 });
    expect(whole.placements[0].arc).toMatchObject({ r0: 0, r1: 300 });
    expect(whole.placements[0].arc!.a1 - whole.placements[0].arc!.a0).toBeCloseTo(Math.PI * 2, 6);
  });

  it('a fixed spoke count stretches the outer cells', async () => {
    const widths = rings(await radial({ rings: 3, spokes: 8, radius: 300 })).map(([, c]) => c[0].w!);
    expect(widths[0]).toBeLessThan(widths[1]);
    expect(widths[1]).toBeLessThan(widths[2]);
    // w is the sector straightened: its arc extent at the cell's mid radius
    expect(widths[2]).toBeCloseTo((Math.PI * 2 * 250) / 8, 6);
  });

  it('moves the whole target when the center moves', async () => {
    const home = await radial({ rings: 2, spokes: 6, radius: 100 });
    const moved = await radial({ rings: 2, spokes: 6, radius: 100, centerX: 40, centerY: -25 });
    // a rigid translation: slots, and the cells that describe them, move together
    moved.placements.forEach((p, i) => {
      expect(p.x - 40).toBeCloseTo(home.placements[i].x, 9);
      expect(p.y + 25).toBeCloseTo(home.placements[i].y, 9);
    });
    expect(moved.placements.every((p) => p.arc!.cx === 40 && p.arc!.cy === -25)).toBe(true);
    expect(moved.placements.map((p) => [p.arc!.r0, p.arc!.a0, p.rotation, p.w, p.h]))
      .toEqual(home.placements.map((p) => [p.arc!.r0, p.arc!.a0, p.rotation, p.w, p.h]));
    // the cell outline follows its slot, so it is still drawn around the rings
    const outline = arcCellOutline(moved.placements[0]);
    expect(Math.min(...outline.map((pt) => Math.hypot(pt.x - 40, pt.y + 25)))).toBeCloseTo(0, 6);
  });

  it('distributes ring thickness with the same weights as Grid', async () => {
    const { placements } = await radial({ rings: 5, spokes: 4, distR: 'fibonacci', radius: 300 });
    const thickness = rings({ kind: 'layout', placements }).map(([, cells]) => cells[0].h!);
    // 1,1,2,3,5 of the span — ratios, not absolute sizes
    expect(thickness.map((h) => Math.round((h / thickness[0]) * 10) / 10)).toEqual([1, 1, 2, 3, 5]);
    expect(thickness.reduce((s, h) => s + h, 0)).toBeCloseTo(300, 6);
  });

  it('orients slots to the ring, and staggers odd rings by half a sector', async () => {
    const tangent = await radial({ rings: 1, spokes: 6, radius: 100 });
    for (const p of tangent.placements) {
      expect(Math.cos(p.rotation - (Math.atan2(p.y, p.x) + Math.PI / 2))).toBeCloseTo(1, 6);
    }
    expect((await radial({ rings: 1, spokes: 6, orient: 'none' })).placements.every((p) => p.rotation === 0)).toBe(true);

    const straight = await radial({ rings: 2, spokes: 8, orient: 'none', stagger: 'none' });
    const staggered = await radial({ rings: 2, spokes: 8, orient: 'none', stagger: 'rings' });
    const angle = (l: LayoutValue, i: number) => Math.atan2(l.placements[i].y, l.placements[i].x);
    expect(angle(staggered, 0)).toBeCloseTo(angle(straight, 0), 6); // even rings stay put
    // the odd ring turns by half of its 45° sector
    const turn = angle(staggered, 8) - angle(straight, 8);
    expect(Math.abs(turn)).toBeCloseTo(Math.PI / 8, 6);
  });

  it('a partial sweep fans, and only one full ring is a closed loop', async () => {
    const fan = await radial({ rings: 2, spokes: 6, sweep: 180, startAngle: 0, radius: 100 });
    expect(fan.placements).toHaveLength(12);
    expect(fan.placements.every((p) => p.y >= -1e-9)).toBe(true); // the lower half only
    expect(fan.closed).toBeUndefined();

    expect((await radial({ rings: 1, spokes: 12 })).closed).toBe(true);
    expect((await radial({ rings: 2, spokes: 12 })).closed).toBeUndefined();
    expect((await radial({ rings: 1, spokes: 12, sweep: 270 })).closed).toBeUndefined();
  });

  it('the mask trims cells and the survivors are born a clean run', async () => {
    const params = { rings: 2, spokes: 8, radius: 40 };
    const full = await radial(params);
    const masked = layoutOf(
      await RadialNode.cook({ mask: mask('raster') }, { ...defaults(RadialNode), ...params }, ctx),
    );
    expect(masked.placements.length).toBeLessThan(full.placements.length);
    expect(masked.placements.every((p) => p.x < 0)).toBe(true); // left half in-mask
    expect(masked.placements.map((p) => p.index)).toEqual([...masked.placements.keys()]);
    expect(masked.placements[0].progress).toBe(0);
    expect(masked.placements.at(-1)!.progress).toBe(1);
    expect(masked.closed).toBeUndefined();
  });

  it('draws as rings whatever the spoke count', async () => {
    const drawn = async (spokes: number) => {
      const layout = await radial({ rings: 2, spokes, radius: 300, innerRadius: 100 });
      return (DrawLayoutNode.cook({ layout }, { size: 8 }, ctx) as { out: VectorValue }).out.bounds;
    };
    // the cells are sectors, so however finely the ring is cut the ink covers
    // the same annulus — the picture is the rings, the spokes only partition them
    const sparse = await drawn(3), dense = await drawn(64);
    for (const b of [sparse, dense]) {
      expect(b.x).toBeCloseTo(-300, 1);
      expect(b.y).toBeCloseTo(-300, 1);
      expect(b.width).toBeCloseTo(600, 1);
      expect(b.height).toBeCloseTo(600, 1);
    }
  });

  it('flow decides the fill order, not the geometry', async () => {
    const key = (l: LayoutValue) => l.placements.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
    const byRings = await radial({ rings: 3, spokes: 6 });
    const bySpokes = await radial({ rings: 3, spokes: 6, flow: 'spokes' });
    const serpentine = await radial({ rings: 3, spokes: 6, flow: 'serpentine' });
    for (const other of [bySpokes, serpentine]) {
      expect(new Set(key(other))).toEqual(new Set(key(byRings)));
      expect(key(other)).not.toEqual(key(byRings));
    }
    // spokes walks outward: the first three slots share an angle, not a radius
    const first = bySpokes.placements.slice(0, 3);
    expect(new Set(first.map((p) => Math.round(Math.atan2(p.y, p.x) * 1e3)))).toHaveLength(1);
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

});

describe('Jitter', () => {
  it('masked jitter keeps points inside the mask', async () => {
    const ctx = maskCtx('raster');
    const gridParams = { ...defaults(GridNode), columns: 4, rows: 2, padX: 10, padY: 10 };
    const grid = layoutOf(await GridNode.cook({ mask: mask('raster') }, gridParams, ctx));
    const params = { ...defaults(JitterNode), offset: 40 };
    const jittered = layoutOf(
      await JitterNode.cook({ layout: grid, mask: mask('raster') }, params, ctx),
    );
    // jitter constrains movement, not existence — the run survives intact
    expect(jittered.placements).toHaveLength(grid.placements.length);
    expect(jittered.placements.every((p) => p.x < 0)).toBe(true);
  });

  it('leaves slot identity alone', async () => {
    const ctx = maskCtx('raster');
    const grid = layoutOf(await GridNode.cook({}, { ...defaults(GridNode), columns: 3, rows: 2 }, ctx));
    const params = { ...defaults(JitterNode), offset: 12, rotate: 0.4, scaleJitter: 0.3 };
    const { placements } = layoutOf(await JitterNode.cook({ layout: grid }, params, ctx));
    expect(placements.map((p) => p.index)).toEqual(grid.placements.map((p) => p.index));
    expect(placements.map((p) => p.progress)).toEqual(grid.placements.map((p) => p.progress));
    expect(placements.some((p, i) => p.x !== grid.placements[i].x)).toBe(true);
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

describe('Shuffle', () => {
  const ctx = maskCtx('raster');
  const gridOf = async (over: Record<string, string | number>) =>
    layoutOf(await GridNode.cook({}, { ...defaults(GridNode), gapX: 0, gapY: 0, padX: 0, padY: 0, ...over }, ctx));
  const shuffle = (layout: LayoutValue, params: Record<string, string | number>) =>
    layoutOf(ShuffleNode.cook({ layout }, params, ctx));

  /** the distinct column intervals, left to right */
  function columns(l: LayoutValue): [number, number][] {
    const seen = new Map<number, [number, number]>();
    for (const p of l.placements) seen.set(p.col!, [p.x - p.w! / 2, p.x + p.w! / 2]);
    return [...seen.values()].sort((a, b) => a[0] - b[0]);
  }

  it('permuting tracks still tiles the frame exactly', async () => {
    // fibonacci: every column a different width, so a flat permutation of the
    // cells could not tile — this is the case tracks mode exists for
    const grid = await gridOf({ columns: 5, rows: 3, distX: 'fibonacci' });
    const shuffled = shuffle(grid, { mode: 'tracks', axes: 'x', seed: 3 });

    const before = columns(grid), after = columns(shuffled);
    // same widths, in a different order, with no seam and no overlap between
    // neighbours — the run starts and ends exactly where it did
    expect(after.map(([l, r]) => r - l).sort().map(Math.round))
      .toEqual(before.map(([l, r]) => r - l).sort().map(Math.round));
    expect(after[0][0]).toBeCloseTo(before[0][0], 6);
    expect(after.at(-1)![1]).toBeCloseTo(before.at(-1)![1], 6);
    for (let i = 0; i < after.length - 1; i++) expect(after[i][1]).toBeCloseTo(after[i + 1][0], 6);
    expect(after.map(([l]) => Math.round(l))).not.toEqual(before.map(([l]) => Math.round(l)));
  });

  it('keeps gaps with the positions, not the tracks', async () => {
    const grid = await gridOf({ columns: 4, rows: 1, distX: 'geometric', gapX: 12 });
    const after = columns(shuffle(grid, { mode: 'tracks', axes: 'x', seed: 5 }));
    for (let i = 0; i < after.length - 1; i++) expect(after[i + 1][0] - after[i][1]).toBeCloseTo(12, 6);
    expect(after.at(-1)![1]).toBeCloseTo(columns(grid).at(-1)![1], 6);
  });

  it('leaves slot identity and extents alone', async () => {
    const grid = await gridOf({ columns: 4, rows: 3, distX: 'fibonacci', distY: 'golden' });
    const { placements } = shuffle(grid, { mode: 'tracks', axes: 'both', seed: 9 });
    expect(placements.map((p) => p.index)).toEqual(grid.placements.map((p) => p.index));
    expect(placements.map((p) => p.progress)).toEqual(grid.placements.map((p) => p.progress));
    // a tile placed by-index must find a slot exactly the size it was cut at
    expect(placements.map((p) => [p.w, p.h])).toEqual(grid.placements.map((p) => [p.w, p.h]));
  });

  it('is deterministic in the seed', async () => {
    const grid = await gridOf({ columns: 6, rows: 4, distX: 'fibonacci' });
    const run = (seed: number) =>
      shuffle(grid, { mode: 'tracks', axes: 'x', seed }).placements.map((p) => p.x);
    expect(run(4)).toEqual(run(4));
    expect(run(4)).not.toEqual(run(5));
  });

  it('cells mode permutes congruent cells and only those', async () => {
    const uniform = await gridOf({ columns: 4, rows: 3 });
    const { placements } = shuffle(uniform, { mode: 'cells', seed: 2 });
    // every cell is congruent on a uniform grid: the positions are a
    // permutation of the originals, so the mosaic is still gapless
    const key = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;
    expect(new Set(placements.map(key))).toEqual(new Set(uniform.placements.map(key)));
    expect(placements.some((p, i) => key(p) !== key(uniform.placements[i]))).toBe(true);

    // strictly increasing on both axes: no two cells are the same size, so the
    // only permutation that tiles is the identity — and that is what you get
    const skew = await gridOf({ columns: 4, rows: 3, distX: 'geometric', distY: 'geometric' });
    const still = shuffle(skew, { mode: 'cells', seed: 2 });
    expect(still.placements.map(key)).toEqual(skew.placements.map(key));
  });

  it('permutes a radial ring within itself, rotations riding along', async () => {
    const ring = layoutOf(await RadialNode.cook({}, { ...defaults(RadialNode), rings: 2, spokes: 8, radius: 200 }, ctx));
    // polar: no col/row, so tracks mode has no cartesian lattice to shift
    expect(shuffle(ring, { mode: 'tracks', axes: 'both', seed: 1 }).placements).toEqual(ring.placements);

    const { placements } = shuffle(ring, { mode: 'cells', seed: 2 });
    const key = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;
    expect(new Set(placements.map(key))).toEqual(new Set(ring.placements.map(key)));
    expect(placements.some((p, i) => key(p) !== key(ring.placements[i]))).toBe(true);
    // a ring's cells are congruent to each other and to nothing else, so the
    // swaps stay inside their ring — and each slot's tangent still matches the
    // position it landed on, or a placed tile would sit crooked in its sector
    for (const [i, p] of placements.entries()) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(Math.hypot(ring.placements[i].x, ring.placements[i].y), 6);
      expect(Math.cos(p.rotation - (Math.atan2(p.y, p.x) + Math.PI / 2))).toBeCloseTo(1, 6);
    }
  });

  it('passes a point layout through untouched', async () => {
    const ring = layoutOf(await FunctionLayoutNode.cook({}, { ...defaults(FunctionLayoutNode), fn: 'circle', gap: 20, radius: 40 }, ctx));
    const out = shuffle(ring, { mode: 'tracks', axes: 'both', seed: 1 });
    expect(out.placements).toEqual(ring.placements);
    expect(out.closed).toBe(true);
  });
});
