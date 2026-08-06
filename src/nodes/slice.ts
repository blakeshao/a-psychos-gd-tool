// Slice: cut a raster along a layout's cells, one element per cell.
//
// The node has no params, deliberately. Every geometric decision already has a
// home upstream — how many tiles and what sizes is Grid's track distribution,
// which cells exist at all is Grid's mask or Filter, where tiles end up is
// Shuffle and Place. Slice only cuts, so there is no number on it that can
// disagree with the grid the tiles are later placed onto: feeding one Grid to
// both sides makes tile extents and slot extents congruent by construction,
// which is what keeps a non-uniform mosaic seamless.
//
// Cutting is free. The tiles all share the source texture and differ only in
// their srcRect window, so a 12x12 slice costs twelve textures' worth of
// nothing — no readback, no copies. Wire Slice straight to Output and the
// image reassembles pixel for pixel; that identity is the node's whole
// contract.

import type { NodeDef } from '../engine/registry';
import type { Element, ElementsValue, LayoutValue, RasterValue } from '../engine/values';

export const SliceNode: NodeDef = {
  type: 'Slice',
  inputs: [
    { name: 'image', type: 'raster' },
    // cell extents are what there is to cut along: a point layout (Sample Path,
    // Function, Random-generate) carries none, and its slots are skipped
    { name: 'layout', type: 'layout' },
  ],
  outputs: [{ name: 'out', type: 'elements' }],
  params: [],
  usesFrame: true,
  cook(inputs, _params, ctx) {
    const image = inputs.image as RasterValue;
    const layout = inputs.layout as LayoutValue;
    const { width: fw, height: fh } = ctx.frame;
    const items: Element[] = [];

    for (const p of layout.placements) {
      if (!p.w || !p.h || p.w <= 0 || p.h <= 0) continue;
      // layout space is origin-at-center, y down; the frame's top-left is the
      // texture's, so the cell rect lands in 0..1 texture space by a shift
      const left = Math.max(0, p.x - p.w / 2 + fw / 2);
      const top = Math.max(0, p.y - p.h / 2 + fh / 2);
      const right = Math.min(fw, p.x + p.w / 2 + fw / 2);
      const bottom = Math.min(fh, p.y + p.h / 2 + fh / 2);
      // a cell hanging off the frame (stagger, an oversized area) is cut down
      // to the part that has pixels — and re-centered on it, so the tile still
      // draws exactly where its pixels came from
      if (right <= left || bottom <= top) continue;

      items.push({
        content: image,
        srcRect: { x: left / fw, y: top / fh, width: (right - left) / fw, height: (bottom - top) / fh },
        // identity but for position: the slot's own rotation/scale compose in
        // later at Place, and applying them here would count them twice
        transform: { x: (left + right) / 2 - fw / 2, y: (top + bottom) / 2 - fh / 2, rotation: 0, scale: 1 },
        // slot identity carries to the tile, so Place's by-index join can put
        // tile k on slot k's shuffled position
        index: p.index,
        progress: p.progress,
        weight: p.weight,
      });
    }

    return { out: { kind: 'elements', items } satisfies ElementsValue };
  },
};
