// Phase 5 gate, headless: Split keeps kerned positions and indices; Place
// zips elements onto placements with weight binding; the round trip
// text -> split -> place(samplePath) -> flatten survives with live geometry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as opentype from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CookContext } from '../engine/registry';
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
import { GridNode, SamplePathNode, FilterLayoutNode, SortLayoutNode } from './layout';

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
    const layout = (await GridNode.cook({}, { columns: 4, rows: 1, spacingX: 50, spacingY: 50 }, ctx))
      .out as LayoutValue;
    // grid weight is 1 — override to test binding
    layout.placements.forEach((p, i) => (p.weight = i / 3));

    const placed = await PlaceNode.cook(
      { elements, layout },
      { distribute: 'cycle', bindWeight: 'scale', bindAmount: 1, seed: 0 },
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

    const placed = await PlaceNode.cook(
      { elements, layout },
      { distribute: 'cycle', bindWeight: 'none', bindAmount: 1, seed: 0 },
      ctx,
    );
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
        { distribute: 'spread', bindWeight: 'none', bindAmount: 1, seed: 0 },
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
    const layout = (await GridNode.cook({}, { columns: 3, rows: 2, spacingX: 60, spacingY: 60 }, ctx))
      .out as LayoutValue;
    const placed = await PlaceNode.cook(
      { elements: hex, layout }, // vector wired straight into the elements socket
      { distribute: 'cycle', bindWeight: 'none', bindAmount: 1, seed: 0 },
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
    const grid = (await GridNode.cook({}, { columns: 6, rows: 4, spacingX: 100, spacingY: 100 }, ctx))
      .out as LayoutValue;
    expect(grid.placements).toHaveLength(24);

    const placed = (await PlaceNode.cook(
      { elements: dup, layout: grid },
      { distribute: 'cycle', bindWeight: 'none', bindAmount: 1, seed: 0 },
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

describe('Filter / Sort', () => {
  it('every-nth keeps each nth placement; sort by x re-indexes', async () => {
    const layout = (await GridNode.cook({}, { columns: 6, rows: 1, spacingX: 10, spacingY: 10 }, ctx))
      .out as LayoutValue;
    const filtered = (await FilterLayoutNode.cook({ layout }, { mode: 'every-nth', n: 2, threshold: 0.5 }, ctx))
      .out as LayoutValue;
    expect(filtered.placements).toHaveLength(3);

    const reversed = (await SortLayoutNode.cook(
      { layout },
      { by: 'x', reverse: 'yes', seed: 1 },
      ctx,
    )).out as LayoutValue;
    expect(reversed.placements[0].x).toBeGreaterThan(reversed.placements[5].x);
    expect(reversed.placements.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]); // re-indexed in new order
  });
});
