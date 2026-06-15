import { describe, expect, it } from 'vitest';
import { boundsOfPaths, flattenPaths, polylinesToPaths, samplePathEvenly } from './path';
import type { PathCmd } from './values';
import { DisplaceNode } from '../nodes/vectorOps';
import { ShapeNode } from '../nodes/shape';
import type { CookContext } from './registry';
import type { VectorValue } from './values';

const ctx: CookContext = { gpu: null, fonts: new Map(), frame: { width: 768, height: 512 } };

describe('flattenPaths', () => {
  it('keeps line segments and the closed flag', () => {
    const cmds: PathCmd[][] = [[
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'Z' },
    ]];
    const polys = flattenPaths(cmds);
    expect(polys).toHaveLength(1);
    expect(polys[0].closed).toBe(true);
    expect(polys[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it('samples cubics densely and lands exactly on the endpoint', () => {
    const cmds: PathCmd[][] = [[
      { type: 'M', x: 0, y: 0 },
      { type: 'C', x1: 0, y1: 100, x2: 100, y2: 100, x: 100, y: 0 },
    ]];
    const polys = flattenPaths(cmds, 2.5);
    const pts = polys[0].points;
    expect(pts.length).toBeGreaterThan(10);
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 0 });
  });

  it('splits multiple M-subpaths into separate polylines', () => {
    const cmds: PathCmd[][] = [[
      { type: 'M', x: 0, y: 0 }, { type: 'L', x: 5, y: 0 }, { type: 'Z' },
      { type: 'M', x: 20, y: 20 }, { type: 'L', x: 25, y: 20 }, { type: 'Z' },
    ]];
    expect(flattenPaths(cmds)).toHaveLength(2);
  });
});

describe('polylinesToPaths', () => {
  it('round-trips a polyline to M/L/Z', () => {
    const paths = polylinesToPaths([{ points: [{ x: 0, y: 0 }, { x: 4, y: 2 }], closed: true }]);
    expect(paths).toEqual([[
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 4, y: 2 },
      { type: 'Z' },
    ]]);
  });
});

describe('Shape node', () => {
  it('makes an ellipse with the requested bounds', async () => {
    const out = await ShapeNode.cook({}, { kind: 'ellipse', width: 300, height: 200, sides: 6 }, ctx);
    const v = out.out as VectorValue;
    expect(v.bounds.width).toBeGreaterThanOrEqual(298);
    expect(v.bounds.width).toBeLessThanOrEqual(302);
    expect(v.bounds.height).toBeGreaterThanOrEqual(198);
    expect(v.bounds.height).toBeLessThanOrEqual(202);
  });
});

describe('samplePathEvenly offset / gap', () => {
  // a unit square, perimeter 400, walked clockwise from the origin
  const square = flattenPaths([[
    { type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 },
    { type: 'L', x: 100, y: 100 }, { type: 'L', x: 0, y: 100 }, { type: 'Z' },
  ]]);

  it('gap drives how many points fit; the run is centered on the path', () => {
    const pts = samplePathEvenly(square, 100); // 400 / 100 = 4 points, centered
    expect(pts).toHaveLength(4);
    expect(pts.map((p) => [p.x, p.y])).toEqual([[50, 100], [0, 50], [50, 0], [100, 50]]);
  });

  it('offset slides the whole run along the arc (half a side → the corners)', () => {
    const pts = samplePathEvenly(square, 100, 50);
    expect(pts.map((p) => [p.x, p.y])).toEqual([[0, 100], [0, 0], [100, 0], [100, 100]]);
  });

  it('a gap that does not divide the length evenly drops the remainder', () => {
    expect(samplePathEvenly(square, 120)).toHaveLength(3); // floor(400 / 120)
  });

  it('is not pinned to the start: the first sample moves when gap changes', () => {
    const a = samplePathEvenly(square, 100)[0];
    const b = samplePathEvenly(square, 160)[0];
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
  });
});

describe('Displace node', () => {
  it('is deterministic for the same seed, different for another', async () => {
    const square: VectorValue = {
      kind: 'vector',
      paths: [[
        { type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 100 }, { type: 'L', x: 0, y: 100 }, { type: 'Z' },
      ]],
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    };
    const p = { amount: 8, scale: 40, seed: 3 };
    const a = await DisplaceNode.cook({ in: square }, p, ctx);
    const b = await DisplaceNode.cook({ in: square }, p, ctx);
    const c = await DisplaceNode.cook({ in: square }, { ...p, seed: 4 }, ctx);
    expect(a.out).toEqual(b.out); // cache-safe: same params, same geometry
    expect(a.out).not.toEqual(c.out);
    expect(boundsOfPaths((a.out as VectorValue).paths).width).toBeGreaterThan(90);
  });
});
