// Phase 5 gate, headless: Split keeps kerned positions and indices; Place
// zips elements onto placements with weight binding; the round trip
// text -> split -> place(samplePath) -> flatten survives with live geometry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as opentype from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CookContext } from '../engine/registry';
import type {
  ElementsValue,
  LayoutValue,
  TextValue,
  VectorValue,
} from '../engine/values';
import { TextNode } from './text';
import { ShapeNode } from './shape';
import { FlattenNode, PlaceNode, SplitNode } from './elements';
import { GridNode, SamplePathNode, FilterLayoutNode, SortLayoutNode } from './layout';

let ctx: CookContext;

beforeAll(() => {
  const buf = readFileSync(join(__dirname, '../../public/fonts/JetBrainsMono-Regular.ttf'));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  ctx = { gpu: null, fonts: new Map([['default', font]]) };
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
  it('cycles elements over placements and binds weight to scale', async () => {
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
    expect(items).toHaveLength(4);
    expect(items.map((e) => (e.content as TextValue).content)).toEqual(['A', 'B', 'A', 'B']);
    const scales = items.map((e) => e.transform.scale);
    [0, 1 / 3, 2 / 3, 1].forEach((want, i) => expect(scales[i]).toBeCloseTo(want, 10)); // scale = weight at amount 1
    expect(items[0].transform.x).toBe(layout.placements[0].x); // placement replaces position
  });
});

describe('SamplePath -> Place -> Flatten round trip', () => {
  it('spaces glyphs evenly along an ellipse with tangent rotation', async () => {
    const text = await shape('PSYCHO');
    const elements = (await SplitNode.cook({ text }, { by: 'characters' }, ctx)).out as ElementsValue;
    const ellipse = (await ShapeNode.cook({}, { kind: 'ellipse', width: 400, height: 400, sides: 6 }, ctx))
      .out as VectorValue;
    const layout = (await SamplePathNode.cook({ path: ellipse }, { count: 6, tangent: 'rotate' }, ctx))
      .out as LayoutValue;

    expect(layout.placements).toHaveLength(6);
    // even arc-length spacing on a circle of r=200: chord for 60° ≈ 200
    const d01 = Math.hypot(
      layout.placements[1].x - layout.placements[0].x,
      layout.placements[1].y - layout.placements[0].y,
    );
    const d12 = Math.hypot(
      layout.placements[2].x - layout.placements[1].x,
      layout.placements[2].y - layout.placements[1].y,
    );
    expect(Math.abs(d01 - d12) / d01).toBeLessThan(0.05);
    // tangent rotations actually rotate around the ring
    const rotations = layout.placements.map((p) => p.rotation);
    expect(new Set(rotations.map((r) => r.toFixed(2))).size).toBeGreaterThan(4);

    const placed = await PlaceNode.cook(
      { elements, layout },
      { distribute: 'cycle', bindWeight: 'none', bindAmount: 1, seed: 0 },
      ctx,
    );
    const flat = await FlattenNode.cook({ in: placed.out }, {}, ctx);
    const v = flat.out as VectorValue;
    expect(v.paths.length).toBeGreaterThanOrEqual(6); // every glyph contributed geometry
    expect(v.bounds.width).toBeGreaterThan(300); // spread around the ring, not stacked
    expect(v.bounds.height).toBeGreaterThan(300);
  });
});

describe('singular/plural lift', () => {
  it('a lone vector placed onto a grid cycles onto every placement', async () => {
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
    expect(items).toHaveLength(6);
    expect(items.every((e) => e.content === hex)).toBe(true); // shared content, six transforms
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
