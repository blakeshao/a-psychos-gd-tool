// Phase 5 gate, headless: Split keeps kerned positions and indices; Place
// zips elements onto placements with weight binding; the round trip
// text -> split -> place(samplePath) -> flatten survives with live geometry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as opentype from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { Evaluator } from '../engine/evaluator';
import type { Graph } from '../engine/graph';
import type { CookContext } from '../engine/registry';
import { buildRegistry } from './index';
import type {
  Element,
  ElementsValue,
  LayoutValue,
  TextValue,
  VectorValue,
} from '../engine/values';
import { TextNode } from './text';
import { ShapeNode } from './shape';
import { DuplicatorNode, FlattenNode, PlaceNode, SplitNode } from './elements';
import {
  DrawLayoutNode,
  FilterLayoutNode,
  FunctionLayoutNode,
  GridNode,
  SamplePathNode,
  WeightNode,
} from './layout';

let ctx: CookContext;

beforeAll(() => {
  const buf = readFileSync(join(__dirname, '../../public/fonts/JetBrainsMono-Regular.ttf'));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  ctx = { gpu: null, fonts: new Map([['default', font]]), frame: { width: 768, height: 512 } };
});

async function shape(content: string): Promise<TextValue> {
  const out = await TextNode.cook({}, { content, fontSize: 100, font: 'default' }, ctx);
  return out.out as TextValue;
}

// full Place param record for direct cook() calls (the evaluator fills defaults)
function placeParams(over: Record<string, number | string> = {}) {
  return {
    distribute: 'by-order', order: 'source', reverse: 'no', seed: 0,
    binds: '[]',
    ...over,
  };
}

// binds param helper: rows of {channel, target, amount, invert?, offset?} as the JSON the UI writes
function binds(...rows: Array<{ channel: string; target: string; amount?: number; invert?: boolean; offset?: number }>) {
  return JSON.stringify(rows.map((r) => ({ amount: 1, ...r })));
}

// full Grid param record for direct cook() calls (the evaluator fills defaults)
function gridParams(over: Record<string, number | string> = {}) {
  return {
    columns: 6, rows: 4, gapX: 0, gapY: 0,
    padding: 'x/y', padX: 48, padY: 48,
    padTop: 48, padRight: 48, padBottom: 48, padLeft: 48,
    distX: 'uniform', distY: 'uniform', ratioX: 1.618, ratioY: 1.618,
    weightsX: '1,1,2,3,5', weightsY: '1,1,2,3,5', exprX: '1', exprY: '1',
    reverseX: 'no', reverseY: 'no',
    stagger: 'none', flow: 'rows',
    ...over,
  };
}

describe('Split', () => {
  it('characters keep kerned positions and string indices', async () => {
    const text = await shape('PSYCHO');
    const split = await SplitNode.cook({ text }, { by: 'characters' }, ctx);
    const items = (split.out as ElementsValue).items;
    expect(items).toHaveLength(6);
    items.forEach((el, i) => {
      expect(el.index).toBe(i);
      expect(el.transform.x).toBeCloseTo(text.glyphs[i].x, 5); // shaped position preserved
      expect(el.content.kind).toBe('text');
    });
    // positions strictly increase — they are real advances, not zeros
    for (let i = 1; i < items.length; i++) {
      expect(items[i].transform.x).toBeGreaterThan(items[i - 1].transform.x);
    }
  });

  it('words split on spaces, skip the spaces, keep word offsets', async () => {
    const text = await shape('A PSYCHOS GD');
    const split = await SplitNode.cook({ text }, { by: 'words' }, ctx);
    const items = (split.out as ElementsValue).items;
    expect(items).toHaveLength(3);
    expect(items.map((e) => (e.content as TextValue).content)).toEqual(['A', 'PSYCHOS', 'GD']);
    expect(items[1].transform.x).toBeGreaterThan(items[0].transform.x);
  });
});

describe('Place', () => {
  it('emits one item per element, filling placements in order and binding weight', async () => {
    const text = await shape('AB');
    const elements = (await SplitNode.cook({ text }, { by: 'characters' }, ctx)).out as ElementsValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 4, rows: 1 }), ctx))
      .out as LayoutValue;
    // grid weight is 1 — override to test binding
    layout.placements.forEach((p, i) => (p.weight = i / 3));

    const placed = await PlaceNode.cook(
      { elements, layout },
      placeParams({ binds: binds({ channel: 'weight', target: 'scale' }) }),
      ctx,
    );
    const items = (placed.out as ElementsValue).items;
    // two elements, four cells: count follows the elements, not the layout
    expect(items).toHaveLength(2);
    expect(items.map((e) => (e.content as TextValue).content)).toEqual(['A', 'B']);
    const scales = items.map((e) => e.transform.scale);
    [0, 1 / 3].forEach((want, i) => expect(scales[i]).toBeCloseTo(want, 10)); // scale = weight at amount 1
    expect(items[0].transform.x).toBe(layout.placements[0].x); // placement replaces position
  });
});

describe('SamplePath -> Place -> Flatten round trip', () => {
  it('gap subdivides the ring; Place fills one slot per glyph, with tangent rotation', async () => {
    const text = await shape('PSYCHO');
    const elements = (await SplitNode.cook({ text }, { by: 'characters' }, ctx)).out as ElementsValue;
    const ellipse = (await ShapeNode.cook({}, { kind: 'ellipse', width: 400, height: 400, sides: 6 }, ctx))
      .out as VectorValue;
    const layout = (await SamplePathNode.cook({ path: ellipse }, { gap: 120, offset: 0, tangent: 'rotate' }, ctx))
      .out as LayoutValue;

    // gap drives the slot count: ~circumference / 120, more than the 6 glyphs
    expect(layout.placements.length).toBeGreaterThan(6);
    // tangent rotations actually rotate around the ring
    const rotations = layout.placements.map((p) => p.rotation);
    expect(new Set(rotations.map((r) => r.toFixed(2))).size).toBeGreaterThan(4);

    const placed = await PlaceNode.cook({ elements, layout }, placeParams(), ctx);
    // element-driven: 6 glyphs → 6 placed items, each on a distinct slot
    const items = (placed.out as ElementsValue).items;
    expect(items).toHaveLength(6);
    expect(new Set(items.map((e) => `${e.transform.x},${e.transform.y}`)).size).toBe(6);

    const flat = await FlattenNode.cook({ in: placed.out }, {}, ctx);
    const v = flat.out as VectorValue;
    expect(v.paths.length).toBeGreaterThanOrEqual(6); // every glyph contributed geometry
    expect(v.bounds.width).toBeGreaterThan(100); // spread along the ring, not stacked
    expect(v.bounds.height).toBeGreaterThan(100);
  });

  it('spread re-spaces the element count evenly along the whole path', async () => {
    const ellipse = (await ShapeNode.cook({}, { kind: 'ellipse', width: 400, height: 400, sides: 64 }, ctx))
      .out as VectorValue;
    const layout = (await SamplePathNode.cook({ path: ellipse }, { gap: 40, offset: 0, tangent: 'rotate' }, ctx))
      .out as LayoutValue;
    expect(layout.closed).toBe(true);
    const slots = layout.placements.length;

    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;

    const place = async (count: number) => {
      const d = await DuplicatorNode.cook({ in: hex }, { count }, ctx);
      const placed = await PlaceNode.cook(
        { elements: d.out, layout },
        placeParams({ distribute: 'spread' }),
        ctx,
      );
      return (placed.out as ElementsValue).items;
    };

    const gapsOf = (items: Element[]) =>
      items.map((e, i) => {
        const n = items[(i + 1) % items.length];
        return Math.hypot(n.transform.x - e.transform.x, n.transform.y - e.transform.y);
      });
    const evenWithin = (items: Element[], tol: number) => {
      const gaps = gapsOf(items);
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      return gaps.every((g) => Math.abs(g - mean) / mean < tol);
    };

    // fewer elements than slots: spread still covers the full loop, evenly —
    // unlike cycle, which would fill only the first 24 of the slots (a prefix arc)
    const a = await place(24);
    expect(a).toHaveLength(24);
    expect(new Set(a.map((e) => `${e.transform.x.toFixed(2)},${e.transform.y.toFixed(2)}`)).size).toBe(24);
    expect(evenWithin(a, 0.05)).toBe(true);

    // more elements than slots: still one distinct, evenly-spaced position each —
    // they re-space, they don't pile onto the existing slots (cycle would wrap)
    expect(48).toBeGreaterThan(slots);
    const b = await place(48);
    expect(b).toHaveLength(48);
    expect(new Set(b.map((e) => `${e.transform.x.toFixed(2)},${e.transform.y.toFixed(2)}`)).size).toBe(48);
    expect(evenWithin(b, 0.05)).toBe(true);
  });
});

describe('singular/plural lift', () => {
  it('a lone vector lifts to one element and places onto the first cell only', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 40, height: 40, sides: 6 }, ctx))
      .out as VectorValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 3, rows: 2 }), ctx))
      .out as LayoutValue;
    const placed = await PlaceNode.cook(
      { elements: hex, layout }, // vector wired straight into the elements socket
      placeParams(),
      ctx,
    );
    const items = (placed.out as ElementsValue).items;
    // one element → one item; the other five grid cells stay empty (Duplicate to fill them)
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe(hex);
    expect(items[0].transform.x).toBe(layout.placements[0].x);
  });

  it('Duplicator lifts raster-like content and repeats elements', async () => {
    const fakeRaster = { kind: 'raster', texture: {} as never, width: 32, height: 32 } as const;
    const dup = await (await import('./elements')).DuplicatorNode.cook(
      { in: fakeRaster },
      { count: 4 },
      ctx,
    );
    const items = (dup.out as ElementsValue).items;
    expect(items).toHaveLength(4);
    expect(items.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(items.map((e) => e.progress)).toEqual([0, 1 / 3, 2 / 3, 1]); // copy fraction lives in progress
    expect(items.every((e) => e.content === fakeRaster)).toBe(true);
  });
});

describe('Duplicator decides how many items land in a layout', () => {
  it('7 duplicates fill the first 7 cells of a 6×4 grid; the rest stay empty', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 40, height: 40, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 7 }, ctx)).out as ElementsValue;
    expect(dup.items).toHaveLength(7);

    // Grid keeps its own 6×4 = 24 cells, independent of the count
    const grid = (await GridNode.cook({}, gridParams(), ctx)).out as LayoutValue;
    expect(grid.placements).toHaveLength(24);

    const placed = (await PlaceNode.cook(
      { elements: dup, layout: grid },
      placeParams(),
      ctx,
    )).out as ElementsValue;
    // output count follows the Duplicator, not the grid; items sit in cells 0..6
    expect(placed.items).toHaveLength(7);
    placed.items.forEach((item, i) => {
      expect(item.transform.x).toBe(grid.placements[i].x);
      expect(item.transform.y).toBe(grid.placements[i].y);
    });
  });
});

describe('Grid is frame-aware', () => {
  it('subdivides the frame content box: padding + gaps set the cell pitch', async () => {
    // 768×512 frame, 48 padding → 672×416 content; 6×4 cells of 112×104
    const grid = (await GridNode.cook({}, gridParams({ gapX: 0, gapY: 0 }), ctx))
      .out as LayoutValue;
    const xs = grid.placements.map((p) => p.x);
    const ys = grid.placements.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-768 / 2 + 48 + 112 / 2, 6);
    expect(Math.max(...xs)).toBeCloseTo(768 / 2 - 48 - 112 / 2, 6);
    expect(Math.min(...ys)).toBeCloseTo(-512 / 2 + 48 + 104 / 2, 6);
    expect(Math.max(...ys)).toBeCloseTo(512 / 2 - 48 - 104 / 2, 6);

    // gaps shrink the cells but keep the outermost centers pinned to padding
    const gapped = (await GridNode.cook({}, gridParams({ gapX: 24, gapY: 24 }), ctx))
      .out as LayoutValue;
    const gxs = gapped.placements.map((p) => p.x);
    const cellW = (672 - 24 * 5) / 6;
    expect(Math.min(...gxs)).toBeCloseTo(-768 / 2 + 48 + cellW / 2, 6);
    expect(Math.max(...gxs)).toBeCloseTo(768 / 2 - 48 - cellW / 2, 6);
  });

  it('per-side padding shifts the content box asymmetrically', async () => {
    const grid = (await GridNode.cook(
      {},
      gridParams({ padding: 'per-side', padLeft: 100, padRight: 0, padTop: 0, padBottom: 200 }),
      ctx,
    )).out as LayoutValue;
    const xs = grid.placements.map((p) => p.x);
    const ys = grid.placements.map((p) => p.y);
    const cellW = (768 - 100) / 6, cellH = (512 - 200) / 4;
    expect(Math.min(...xs)).toBeCloseTo(-768 / 2 + 100 + cellW / 2, 6);
    expect(Math.max(...xs)).toBeCloseTo(768 / 2 - cellW / 2, 6);
    expect(Math.max(...ys)).toBeCloseTo(512 / 2 - 200 - cellH / 2, 6);
  });

  it('flow reorders filling; stagger offsets alternate rows', async () => {
    const byRows = (await GridNode.cook({}, gridParams({ columns: 3, rows: 2 }), ctx)).out as LayoutValue;
    const byCols = (await GridNode.cook({}, gridParams({ columns: 3, rows: 2, flow: 'columns' }), ctx))
      .out as LayoutValue;
    // column flow walks down the first column before moving right
    expect(byCols.placements[1].x).toBe(byCols.placements[0].x);
    expect(byCols.placements[1].y).toBeGreaterThan(byCols.placements[0].y);
    expect(byRows.placements[1].y).toBe(byRows.placements[0].y);
    const snake = (await GridNode.cook({}, gridParams({ columns: 3, rows: 2, flow: 'serpentine' }), ctx))
      .out as LayoutValue;
    // second row starts where the first row ended (right edge)
    expect(snake.placements[3].x).toBe(snake.placements[2].x);
    expect(snake.placements.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);

    const brick = (await GridNode.cook({}, gridParams({ columns: 3, rows: 2, stagger: 'rows' }), ctx))
      .out as LayoutValue;
    expect(brick.placements[3].x).toBeGreaterThan(brick.placements[0].x); // odd row shifted half a pitch
    expect(brick.placements[3].x - brick.placements[0].x)
      .toBeCloseTo((brick.placements[1].x - brick.placements[0].x) / 2, 6);
  });
});

describe('Grid distributions (weighted tracks)', () => {
  it('fibonacci splits the content span 1:1:2:3:5 and carries cell extents', async () => {
    // 672 content width × [1,1,2,3,5]/12 → 56, 56, 112, 168, 280
    const grid = (await GridNode.cook({}, gridParams({ columns: 5, rows: 1, distX: 'fibonacci' }), ctx))
      .out as LayoutValue;
    const ws = grid.placements.map((p) => p.w!);
    [56, 56, 112, 168, 280].forEach((w, i) => expect(ws[i]).toBeCloseTo(w, 6));
    // tracks tile the content box exactly: outer edges pinned to padding
    expect(grid.placements[0].x - ws[0] / 2).toBeCloseTo(-768 / 2 + 48, 6);
    expect(grid.placements[4].x + ws[4] / 2).toBeCloseTo(768 / 2 - 48, 6);
    // weight is cell area normalized to the biggest cell
    const weights = grid.placements.map((p) => p.weight);
    [0.2, 0.2, 0.4, 0.6, 1].forEach((w, i) => expect(weights[i]).toBeCloseTo(w, 6));
  });

  it('geometric grows by ratio; reverse flips which side is big', async () => {
    const grid = (await GridNode.cook(
      {},
      gridParams({ columns: 4, rows: 1, distX: 'geometric', ratioX: 2 }),
      ctx,
    )).out as LayoutValue;
    const sx = grid.placements.map((p) => p.x);
    const ws = grid.placements.map((p) => p.w!);
    // 672 × [1,2,4,8]/15 → cells (and center spacing) grow to the right
    [44.8, 89.6, 179.2, 358.4].forEach((w, i) => expect(ws[i]).toBeCloseTo(w, 6));
    expect(sx[1] - sx[0]).toBeLessThan(sx[3] - sx[2]);

    const flipped = (await GridNode.cook(
      {},
      gridParams({ columns: 4, rows: 1, distX: 'geometric', ratioX: 2, reverseX: 'yes' }),
      ctx,
    )).out as LayoutValue;
    expect(flipped.placements[0].w!).toBeCloseTo(358.4, 6);
  });

  it('custom weight lists cycle over the track count', async () => {
    const grid = (await GridNode.cook(
      {},
      gridParams({ columns: 4, rows: 1, distX: 'custom', weightsX: '2,1' }),
      ctx,
    )).out as LayoutValue;
    // '2,1' over 4 columns → 2,1,2,1 → 672 × [2,1,2,1]/6
    const ws = grid.placements.map((p) => p.w!);
    [224, 112, 224, 112].forEach((w, i) => expect(ws[i]).toBeCloseTo(w, 6));
  });

  it('expressions drive weights via t/i/n; a parse error falls back to uniform', async () => {
    const grid = (await GridNode.cook(
      {},
      gridParams({ columns: 4, rows: 1, distX: 'expression', exprX: 't + 0.5' }),
      ctx,
    )).out as LayoutValue;
    // t = i/3 → weights [0.5, 5/6, 7/6, 1.5], sum 4 → 84, 140, 196, 252
    const ws = grid.placements.map((p) => p.w!);
    [84, 140, 196, 252].forEach((w, i) => expect(ws[i]).toBeCloseTo(w, 6));

    const broken = (await GridNode.cook(
      {},
      gridParams({ columns: 4, rows: 1, distX: 'expression', exprX: 'nope(' }),
      ctx,
    )).out as LayoutValue;
    broken.placements.forEach((p) => expect(p.w!).toBeCloseTo(672 / 4, 6));
  });

  it('Draw Layout renders cell placements as their actual rects', async () => {
    const grid = (await GridNode.cook({}, gridParams({ columns: 2, rows: 2 }), ctx))
      .out as LayoutValue;
    const drawn = (await DrawLayoutNode.cook({ layout: grid }, { size: 8 }, ctx))
      .out as VectorValue;
    // 4 cells × (rect + center dot) — and the rects tile the content box
    expect(drawn.paths).toHaveLength(8);
    expect(drawn.bounds.x).toBeCloseTo(-768 / 2 + 48, 6);
    expect(drawn.bounds.y).toBeCloseTo(-512 / 2 + 48, 6);
    expect(drawn.bounds.width).toBeCloseTo(672, 6);
    expect(drawn.bounds.height).toBeCloseTo(416, 6);
  });
});

describe('Channels: progress / weight / index', () => {
  it('generators emit t along the traversal and neutral weights', async () => {
    const grid = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    expect(grid.placements.map((p) => p.progress)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    grid.placements.forEach((p) => expect(p.weight).toBe(1)); // uniform grid: no density signal

    const circle = (await FunctionLayoutNode.cook(
      {},
      { fn: 'circle', count: 8, radius: 100, turns: 3, spacing: 40 },
      ctx,
    )).out as LayoutValue;
    expect(circle.closed).toBe(true); // a circle is a loop — spread wraps, no seam
    circle.placements.forEach((p) => expect(p.weight).toBe(1)); // position lives in progress now
  });
});

describe('Weight', () => {
  const weightParams = (over: Record<string, number | string> = {}) => ({
    source: 'noise', seed: 1, expr: '1 - progress', ...over,
  });

  it('writes to the channel named after its source; the built-in weight stays', async () => {
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const ramp = (await WeightNode.cook({ layout }, weightParams({ source: 'progress' }), ctx))
      .out as LayoutValue;
    expect(ramp.placements.map((p) => p.channels?.progress)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    // geometry, identity, and the generator's weight untouched
    expect(ramp.placements.map((p) => p.weight)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(ramp.placements.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ramp.placements.map((p) => p.x)).toEqual(layout.placements.map((p) => p.x));
  });

  it('area source captures cell density; expression sees i/n/progress/x/y/w', async () => {
    const fib = (await GridNode.cook({}, gridParams({ columns: 5, rows: 1, distX: 'fibonacci' }), ctx))
      .out as LayoutValue;
    const area = (await WeightNode.cook({ layout: fib }, weightParams({ source: 'area' }), ctx))
      .out as LayoutValue;
    [0.2, 0.2, 0.4, 0.6, 1].forEach((w, i) => expect(area.placements[i].channels?.area).toBeCloseTo(w, 6));

    const expr = (await WeightNode.cook(
      { layout: fib },
      weightParams({ source: 'expression', expr: 'w * progress' }), // w = the built-in weight
      ctx,
    )).out as LayoutValue;
    expr.placements.forEach((p) => expect(p.channels?.expression).toBeCloseTo(p.weight * p.progress, 6));
    // a broken expression writes the channel's prior value (neutral 1 here)
    const broken = (await WeightNode.cook(
      { layout: fib },
      weightParams({ source: 'expression', expr: 'nope(' }),
      ctx,
    )).out as LayoutValue;
    broken.placements.forEach((p) => expect(p.channels?.expression).toBe(1));
  });

  it('noise is seed-deterministic', async () => {
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const a = (await WeightNode.cook({ layout }, weightParams({ seed: 7 }), ctx)).out as LayoutValue;
    const b = (await WeightNode.cook({ layout }, weightParams({ seed: 7 }), ctx)).out as LayoutValue;
    expect(a.placements.map((p) => p.channels?.noise)).toEqual(b.placements.map((p) => p.channels?.noise));
    a.placements.forEach((p) => expect(p.channels!.noise).toBeGreaterThanOrEqual(0));
    a.placements.forEach((p) => expect(p.channels!.noise).toBeLessThan(1));
  });
});

describe('Filter', () => {
  const filterParams = (over: Record<string, number | string> = {}) => ({
    mode: 'every-nth', n: 2, channel: 'weight', comparison: 'above', threshold: 0.5,
    keep: 0.5, seed: 1, ...over,
  });

  it('every-nth keeps slots and preserves identity; closed survives', async () => {
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const filtered = (await FilterLayoutNode.cook({ layout }, filterParams(), ctx))
      .out as LayoutValue;
    expect(filtered.placements).toHaveLength(3);
    // survivors keep their slot identity — by-index Place still matches them
    expect(filtered.placements.map((p) => p.index)).toEqual([0, 2, 4]);

    const circle = (await FunctionLayoutNode.cook(
      {},
      { fn: 'circle', count: 8, radius: 100, turns: 3, spacing: 40 },
      ctx,
    )).out as LayoutValue;
    const thinned = (await FilterLayoutNode.cook({ layout: circle }, filterParams(), ctx))
      .out as LayoutValue;
    expect(thinned.closed).toBe(true); // a thinned ring is still a ring
  });

  it('threshold reads the chosen channel; random keep is a seeded subset', async () => {
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const back = (await FilterLayoutNode.cook(
      { layout },
      filterParams({ mode: 'threshold', channel: 'progress', comparison: 'above', threshold: 0.5 }),
      ctx,
    )).out as LayoutValue;
    // "the back half of the run" — a positional slice, spelled as progress, not weight
    expect(back.placements.map((p) => p.index)).toEqual([3, 4, 5]);

    const all = (await FilterLayoutNode.cook({ layout }, filterParams({ mode: 'random', keep: 1 }), ctx))
      .out as LayoutValue;
    expect(all.placements).toHaveLength(6); // latticeHash < 1 always
    const none = (await FilterLayoutNode.cook({ layout }, filterParams({ mode: 'random', keep: 0 }), ctx))
      .out as LayoutValue;
    expect(none.placements).toHaveLength(0);
    const someA = (await FilterLayoutNode.cook({ layout }, filterParams({ mode: 'random', seed: 3 }), ctx))
      .out as LayoutValue;
    const someB = (await FilterLayoutNode.cook({ layout }, filterParams({ mode: 'random', seed: 3 }), ctx))
      .out as LayoutValue;
    expect(someA.placements.map((p) => p.index)).toEqual(someB.placements.map((p) => p.index));
  });
});

describe('Place ordering & joins (Sort absorbed)', () => {
  it('order x + reverse fills right-to-left; slot identity is untouched', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 6 }, ctx)).out as ElementsValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const placed = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ order: 'x', reverse: 'yes' }),
      ctx,
    )).out as ElementsValue;
    const xs = placed.items.map((e) => e.transform.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
    // ordering is a view — the layout's own indices were not rewritten
    expect(layout.placements.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('order random is a seeded permutation — every slot used exactly once', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 6 }, ctx)).out as ElementsValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const placed = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ order: 'random', seed: 5 }),
      ctx,
    )).out as ElementsValue;
    // no collisions, no gaps: 6 elements land on 6 distinct slots
    expect(new Set(placed.items.map((e) => e.transform.x)).size).toBe(6);
    const again = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ order: 'random', seed: 5 }),
      ctx,
    )).out as ElementsValue;
    expect(again.items.map((e) => e.transform.x)).toEqual(placed.items.map((e) => e.transform.x));
  });

  it('by-index drops elements whose slot was filtered away', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 6 }, ctx)).out as ElementsValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const filtered = (await FilterLayoutNode.cook(
      { layout },
      { mode: 'every-nth', n: 2, channel: 'weight', comparison: 'above', threshold: 0.5, keep: 0.5, seed: 1 },
      ctx,
    )).out as LayoutValue;

    const placed = (await PlaceNode.cook(
      { elements: dup, layout: filtered },
      placeParams({ distribute: 'by-index' }),
      ctx,
    )).out as ElementsValue;
    // elements 1, 3, 5 have no surviving slot — they sit out instead of wrapping
    expect(placed.items).toHaveLength(3);
    expect(placed.items.map((e) => e.index)).toEqual([0, 2, 4]);
    placed.items.forEach((e, k) => expect(e.transform.x).toBe(filtered.placements[k].x));
  });

  it('bind progress → scale ramps along the run; weight composes multiplicatively', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 6 }, ctx)).out as ElementsValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const placed = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ binds: binds({ channel: 'progress', target: 'scale' }) }),
      ctx,
    )).out as ElementsValue;
    // uniform grid, so this ramp is only expressible via progress — weight is all 1s
    placed.items.forEach((e, i) => expect(e.transform.scale).toBeCloseTo(i / 5, 10));
    placed.items.forEach((e, i) => {
      expect(e.progress).toBeCloseTo(i / 5, 10); // slot position wins
      expect(e.weight).toBe(1); // 1 × 1 — neutral stays neutral
    });

    // invert flips the signal per bind (this used to live on Weight)
    const inverted = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ binds: binds({ channel: 'progress', target: 'scale', invert: true }) }),
      ctx,
    )).out as ElementsValue;
    inverted.items.forEach((e, i) => expect(e.transform.scale).toBeCloseTo(1 - i / 5, 10));

    // offset biases the signal after invert
    const biased = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ binds: binds({ channel: 'progress', target: 'scale', offset: 0.5 }) }),
      ctx,
    )).out as ElementsValue;
    biased.items.forEach((e, i) => expect(e.transform.scale).toBeCloseTo(i / 5 + 0.5, 10));
  });

  it('offsetX/offsetY shift every placed element off its slot', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 6 }, ctx)).out as ElementsValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const placed = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ offsetX: 30, offsetY: -12 }),
      ctx,
    )).out as ElementsValue;
    placed.items.forEach((e, i) => {
      expect(e.transform.x).toBeCloseTo(layout.placements[i].x + 30, 10);
      expect(e.transform.y).toBeCloseTo(layout.placements[i].y - 12, 10);
    });
  });

  it('named channels: two Weights author two signals, one Place binds both', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 6 }, ctx)).out as ElementsValue;
    const grid = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;

    const wp = { seed: 1, expr: '' };
    const ramped = (await WeightNode.cook(
      { layout: grid },
      { ...wp, source: 'progress' }, // → channels.progress
      ctx,
    )).out as LayoutValue;
    const layout = (await WeightNode.cook(
      { layout: ramped },
      { ...wp, source: 'noise', seed: 9 }, // → channels.noise
      ctx,
    )).out as LayoutValue;
    // both signals ride the slots; the built-in weight channel is untouched
    layout.placements.forEach((p, i) => {
      expect(p.channels?.progress).toBeCloseTo(i / 5, 10);
      expect(p.channels?.noise).toBeGreaterThanOrEqual(0);
      expect(p.weight).toBe(1);
    });

    const placed = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({
        binds: binds(
          { channel: 'progress', target: 'scale' },
          { channel: 'noise', target: 'rotation' },
        ),
      }),
      ctx,
    )).out as ElementsValue;
    // scale follows the ramp, rotation follows the noise — one Place, two signals
    placed.items.forEach((e, i) => {
      expect(e.transform.scale).toBeCloseTo(i / 5, 10);
      expect(e.transform.rotation)
        .toBeCloseTo((layout.placements[i].channels!.noise - 0.5) * Math.PI, 10);
    });

    // a dangling bind (channel nobody wrote) is neutral — nothing bends
    const dangling = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ binds: binds({ channel: 'nope', target: 'scale' }) }),
      ctx,
    )).out as ElementsValue;
    dangling.items.forEach((e) => expect(e.transform.scale).toBe(1));
  });

  it('blur bind writes a px radius onto elements; malformed binds drop', async () => {
    const hex = (await ShapeNode.cook({}, { kind: 'polygon', width: 20, height: 20, sides: 6 }, ctx))
      .out as VectorValue;
    const dup = (await DuplicatorNode.cook({ in: hex }, { count: 6 }, ctx)).out as ElementsValue;
    const layout = (await GridNode.cook({}, gridParams({ columns: 6, rows: 1 }), ctx))
      .out as LayoutValue;
    const placed = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ binds: binds({ channel: 'progress', target: 'blur', amount: 10 }) }),
      ctx,
    )).out as ElementsValue;
    // blur = signal × amount px; the zero-signal element carries no blur at all
    expect(placed.items[0].blur).toBeUndefined();
    placed.items.slice(1).forEach((e, k) => expect(e.blur).toBeCloseTo(((k + 1) / 5) * 10, 10));
    // transforms untouched — blur is a property, not a transform bend
    placed.items.forEach((e) => expect(e.transform.scale).toBe(1));

    const junk = (await PlaceNode.cook(
      { elements: dup, layout },
      placeParams({ binds: 'not json [' }),
      ctx,
    )).out as ElementsValue;
    junk.items.forEach((e) => {
      expect(e.transform.scale).toBe(1);
      expect(e.blur).toBeUndefined();
    });
  });
});

describe('multiple weights through the real evaluator (the app path)', () => {
  it('Grid → Weight(progress) → Weight(noise) → Place drives scale and rotation independently', async () => {
    // sparse params, exactly like document nodes — the evaluator fills defaults
    const g: Graph = {
      frame: { width: 768, height: 512 },
      nodes: {
        shape: { id: 'shape', type: 'Shape', params: { kind: 'polygon', width: 20, height: 20, sides: 6 }, position: { x: 0, y: 0 } },
        dup: { id: 'dup', type: 'Duplicator', params: { count: 6 }, position: { x: 0, y: 0 } },
        grid: { id: 'grid', type: 'Grid', params: { columns: 6, rows: 1 }, position: { x: 0, y: 0 } },
        w1: { id: 'w1', type: 'Weight', params: { source: 'progress' }, position: { x: 0, y: 0 } },
        w2: { id: 'w2', type: 'Weight', params: { source: 'noise', seed: 9 }, position: { x: 0, y: 0 } },
        place: {
          id: 'place',
          type: 'Place',
          params: {
            binds: JSON.stringify([
              { channel: 'progress', target: 'scale', amount: 1 },
              { channel: 'noise', target: 'rotation', amount: 1 },
            ]),
          },
          position: { x: 0, y: 0 },
        },
      },
      edges: [
        { from: { node: 'shape', socket: 'out' }, to: { node: 'dup', socket: 'in' } },
        { from: { node: 'dup', socket: 'out' }, to: { node: 'place', socket: 'elements' } },
        { from: { node: 'grid', socket: 'out' }, to: { node: 'w1', socket: 'layout' } },
        { from: { node: 'w1', socket: 'out' }, to: { node: 'w2', socket: 'layout' } },
        { from: { node: 'w2', socket: 'out' }, to: { node: 'place', socket: 'layout' } },
      ],
    };

    const ev = new Evaluator(buildRegistry());
    const slots = ((await ev.evaluate(g, 'w2', ctx)).outputs.out as LayoutValue).placements;
    slots.forEach((p, i) => {
      expect(p.channels?.progress).toBeCloseTo(i / 5, 10); // Weight #1 survives Weight #2
      expect(typeof p.channels?.noise).toBe('number');
      expect(p.weight).toBe(1); // built-in untouched by either
    });

    const items = ((await ev.evaluate(g, 'place', ctx)).outputs.out as ElementsValue).items;
    expect(items).toHaveLength(6);
    items.forEach((e, i) => {
      expect(e.transform.scale).toBeCloseTo(i / 5, 10); // the progress ramp
      expect(e.transform.rotation).toBeCloseTo((slots[i].channels!.noise - 0.5) * Math.PI, 10);
    });
    // two genuinely independent signals: scale is monotonic, rotation is noise
    expect(new Set(items.map((e) => e.transform.rotation.toFixed(4))).size).toBeGreaterThan(3);
  });
});

describe('Style', () => {
  it('Text bakes fill/weight/stroke into a style that Split and Flatten carry', async () => {
    const out = await TextNode.cook(
      {},
      {
        content: 'AB', fontSize: 100, font: 'default', weight: 700, fill: '#ff0000',
        stroke: true, strokeColor: '#0000ff', strokeWidth: 2, strokeAlign: 'outside',
      },
      ctx,
    );
    const text = out.out as TextValue;
    // weight 700 bakes to px grow: (700-400)/400 * fontSize * 0.03
    expect(text.style).toEqual({
      fill: '#ff0000', stroke: '#0000ff', strokeWidth: 2, strokeAlign: 'outside', grow: 2.25,
    });

    const split = (await SplitNode.cook({ text }, { by: 'characters' }, ctx)).out as ElementsValue;
    for (const el of split.items) {
      expect(el.content.kind === 'text' && el.content.style).toEqual(text.style);
    }

    const flat = (await FlattenNode.cook({ in: split }, {}, ctx)).out as VectorValue;
    expect(flat.style).toEqual(text.style);
  });

  it('Shape carries fill/stroke; unchecked stroke folds to width 0', async () => {
    const styled = (await ShapeNode.cook(
      {},
      {
        kind: 'rect', width: 10, height: 10, sides: 6, fill: '#20a040',
        stroke: true, strokeColor: '#e020c0', strokeWidth: 10, strokeAlign: 'inside',
      },
      ctx,
    )).out as VectorValue;
    expect(styled.style).toEqual({
      fill: '#20a040', stroke: '#e020c0', strokeWidth: 10, strokeAlign: 'inside', grow: 0,
    });

    // stroke toggle off: the width folds to 0 even though a width is set
    const off = (await ShapeNode.cook(
      {},
      { kind: 'rect', width: 10, height: 10, sides: 6, stroke: false, strokeWidth: 10 },
      ctx,
    )).out as VectorValue;
    expect(off.style?.strokeWidth).toBe(0);

    const bare = (await ShapeNode.cook({}, { kind: 'rect', width: 10, height: 10, sides: 6 }, ctx))
      .out as VectorValue;
    expect(bare.style).toEqual({
      fill: '#000000', stroke: '#000000', strokeWidth: 0, strokeAlign: 'center', grow: 0,
    });
  });
});
