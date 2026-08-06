// Slice cuts a raster along a layout's cells. The contract worth pinning down
// is the round trip: tiles that reassemble the source exactly, and that stay
// congruent to the slots they are later placed onto — that congruence is the
// whole reason a non-uniform mosaic can be shuffled without seams.

import { describe, expect, it } from 'vitest';
import type { CookContext } from '../engine/registry';
import type { ElementsValue, LayoutValue, RasterValue } from '../engine/values';
import { GridNode, FunctionLayoutNode, ShuffleNode } from './layout';
import { PlaceNode } from './elements';
import { SliceNode } from './slice';

const FRAME = { width: 200, height: 100 };
const ctx: CookContext = { gpu: null, fonts: new Map(), frame: FRAME };
const image: RasterValue = { kind: 'raster', texture: {} as never, ...FRAME };

function defaults(def: { params: { name: string; default: unknown }[] }) {
  const p: Record<string, string | number | boolean> = {};
  for (const spec of def.params) p[spec.name] = spec.default as string | number | boolean;
  return p;
}

const layoutOf = (out: unknown) => (out as { out: LayoutValue }).out;
const elementsOf = (out: unknown) => (out as { out: ElementsValue }).out.items;

const grid = async (over: Record<string, string | number>) =>
  layoutOf(await GridNode.cook({}, { ...defaults(GridNode), gapX: 0, gapY: 0, padX: 0, padY: 0, ...over }, ctx));

const slice = (layout: LayoutValue) => elementsOf(SliceNode.cook({ image, layout }, {}, ctx));

describe('Slice', () => {
  it('reassembles the source exactly', async () => {
    const tiles = slice(await grid({ columns: 4, rows: 2 }));
    expect(tiles).toHaveLength(8);

    // the windows partition the unit square: every tile's area summed is the
    // whole texture, and each sits where its pixels came from
    const area = tiles.reduce((s, t) => s + t.srcRect!.width * t.srcRect!.height, 0);
    expect(area).toBeCloseTo(1, 9);
    for (const t of tiles) {
      const r = t.srcRect!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
      // the window's center in frame space IS the element's position — drawn
      // untouched, the tile lands back on the pixels it was cut from
      expect((r.x + r.width / 2) * FRAME.width - FRAME.width / 2).toBeCloseTo(t.transform.x, 9);
      expect((r.y + r.height / 2) * FRAME.height - FRAME.height / 2).toBeCloseTo(t.transform.y, 9);
    }
  });

  it('shares one texture across every tile', async () => {
    const tiles = slice(await grid({ columns: 6, rows: 6 }));
    expect(tiles).toHaveLength(36);
    // no copies, no readback: 36 windows onto the same texture
    expect(tiles.every((t) => t.content === image)).toBe(true);
  });

  it('cuts non-uniform cells at their own sizes', async () => {
    const layout = await grid({ columns: 4, rows: 1, distX: 'fibonacci' });
    const tiles = slice(layout);
    // fibonacci over 4 tracks is 1:1:2:3 — the windows carry those ratios
    const widths = tiles.map((t) => t.srcRect!.width * FRAME.width);
    expect(widths.map((w) => Math.round(w))).toEqual([29, 29, 57, 86]);
    expect(widths.reduce((a, b) => a + b)).toBeCloseTo(FRAME.width, 6);
  });

  it('emits an identity transform, leaving rotation and scale to Place', async () => {
    const tiles = slice(await grid({ columns: 2, rows: 2 }));
    expect(tiles.every((t) => t.transform.rotation === 0 && t.transform.scale === 1)).toBe(true);
  });

  it('carries slot identity through, for the by-index join', async () => {
    const layout = await grid({ columns: 3, rows: 2 });
    const tiles = slice(layout);
    expect(tiles.map((t) => t.index)).toEqual(layout.placements.map((p) => p.index));
    expect(tiles.map((t) => t.progress)).toEqual(layout.placements.map((p) => p.progress));
  });

  it('skips slots with no extent', async () => {
    const ring = layoutOf(await FunctionLayoutNode.cook(
      {}, { ...defaults(FunctionLayoutNode), fn: 'circle', gap: 20, radius: 40 }, ctx,
    ));
    expect(ring.placements.length).toBeGreaterThan(0);
    expect(slice(ring)).toHaveLength(0); // a point layout has nothing to cut along
  });

  it('clips a cell that hangs off the frame, and re-centers on what is left', async () => {
    // stagger shifts alternate rows half a pitch, pushing the last cell out
    const layout = await grid({ columns: 4, rows: 2, stagger: 'rows' });
    const tiles = slice(layout);
    for (const t of tiles) {
      const r = t.srcRect!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.width).toBeGreaterThan(0);
      // still centered on its own window, so the clipped tile draws where its
      // pixels are rather than half off the edge
      expect((r.x + r.width / 2) * FRAME.width - FRAME.width / 2).toBeCloseTo(t.transform.x, 9);
    }
  });

  it('lands on a shuffled slot at exactly the size it was cut', async () => {
    const layout = await grid({ columns: 5, rows: 3, distX: 'fibonacci', distY: 'golden' });
    const tiles = slice(layout);
    const shuffled = layoutOf(ShuffleNode.cook({ layout }, { mode: 'tracks', axes: 'both', seed: 7 }, ctx));
    const placed = elementsOf(PlaceNode.cook(
      { elements: { kind: 'elements', items: tiles }, layout: shuffled },
      { ...defaults(PlaceNode), distribute: 'by-index' },
      ctx,
    ));

    expect(placed).toHaveLength(tiles.length);
    const slots = new Map(shuffled.placements.map((p) => [p.index, p]));
    for (const el of placed) {
      const slot = slots.get(el.index)!;
      // the tile kept its window, so it is still exactly cell-sized — and the
      // slot it landed on kept its extents through the shuffle. Congruent, so
      // the mosaic has no gap and no overlap
      expect(el.srcRect!.width * FRAME.width).toBeCloseTo(slot.w!, 6);
      expect(el.srcRect!.height * FRAME.height).toBeCloseTo(slot.h!, 6);
      expect(el.transform.scale).toBe(1);
      expect(el.transform.x).toBeCloseTo(slot.x, 9);
      expect(el.transform.y).toBeCloseTo(slot.y, 9);
    }
    // and it is a real rearrangement, not a no-op
    expect(placed.some((el, i) => el.transform.x !== tiles[i].transform.x)).toBe(true);
  });
});
