import { describe, expect, it } from 'vitest';
import { boundsOfPaths, flattenPaths, polylinesToPaths } from './path';
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
