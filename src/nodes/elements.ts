// The element lane: Split peels live type into pieces, Duplicator multiplies
// a vector, Place zips elements onto layout placements, Flatten is the
// explicit conversion back down the ladder (elements => vector).

import { boundsOfPaths, transformPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type {
  Element,
  ElementsValue,
  LayoutValue,
  PathCmd,
  Placement,
  TextValue,
  Value,
  VectorValue,
} from '../engine/values';
import { latticeHash } from '../util/noise';

/**
 * elements is one type, singular or plural: a lone vector/raster/text value
 * lifts to a single-element list. Wrapping is containment, not coercion —
 * the value itself is untouched.
 */
export function asElements(v: Value): Element[] {
  if (v.kind === 'elements') return v.items;
  if (v.kind === 'vector' || v.kind === 'raster' || v.kind === 'text') {
    return [{ content: v, transform: { x: 0, y: 0, rotation: 0, scale: 1 }, index: 0, weight: 1 }];
  }
  throw new Error(`cannot treat ${v.kind} as elements`);
}

export const SplitNode: NodeDef = {
  type: 'Split',
  inputs: [{ name: 'text', type: 'text' }],
  outputs: [{ name: 'out', type: 'elements' }],
  params: [{ name: 'by', kind: 'select', options: ['characters', 'words'], default: 'characters' }],
  cook(inputs, params) {
    const text = inputs.text as TextValue;
    const items: Element[] = [];

    if (params.by === 'words') {
      // glyph index aligns with char index (stringToGlyphs is 1:1 for our fonts)
      let start = 0;
      let wordIdx = 0;
      const flush = (end: number) => {
        const glyphs = text.glyphs.slice(start, end).filter((g) => text.content[g.index] !== ' ');
        if (glyphs.length === 0) return;
        const x0 = glyphs[0].x;
        items.push({
          content: {
            kind: 'text',
            content: text.content.slice(glyphs[0].index, glyphs[glyphs.length - 1].index + 1),
            glyphs: glyphs.map((g) => ({ ...g, x: g.x - x0 })),
            fontKey: text.fontKey,
            fontSize: text.fontSize,
            width: glyphs[glyphs.length - 1].x - x0,
          },
          transform: { x: x0, y: 0, rotation: 0, scale: 1 }, // keeps its shaped position
          index: wordIdx++,
          weight: 1,
        });
      };
      for (let i = 0; i <= text.content.length; i++) {
        if (i === text.content.length || text.content[i] === ' ') {
          flush(i);
          start = i + 1;
        }
      }
    } else {
      text.glyphs.forEach((g, i) => {
        if (text.content[g.index] === ' ') return;
        items.push({
          content: {
            kind: 'text',
            content: text.content[g.index] ?? '',
            glyphs: [{ glyphId: g.glyphId, x: 0, y: 0, index: 0 }],
            fontKey: text.fontKey,
            fontSize: text.fontSize,
            width: 0,
          },
          transform: { x: g.x, y: g.y, rotation: 0, scale: 1 }, // kerned position preserved
          index: i,
          weight: 1,
        });
      });
    }

    const value: ElementsValue = { kind: 'elements', items };
    return { out: value };
  },
};

export const DuplicatorNode: NodeDef = {
  type: 'Duplicator',
  inputs: [{ name: 'in', type: ['vector', 'raster', 'text', 'elements'] }],
  outputs: [{ name: 'out', type: 'elements' }],
  params: [{ name: 'count', kind: 'number', default: 12, min: 1, max: 500, step: 1 }],
  cook(inputs, params) {
    const base = asElements(inputs.in as Value);
    const count = Math.round(Number(params.count));
    const items: Element[] = [];
    for (let i = 0; i < count; i++) {
      for (const el of base) {
        items.push({
          content: el.content, // copies share content; transforms differ after Place
          transform: { ...el.transform },
          index: items.length,
          weight: count === 1 ? 1 : i / (count - 1),
        });
      }
    }
    const value: ElementsValue = { kind: 'elements', items };
    return { out: value };
  },
};

/** shortest-arc interpolation between two angles (radians). */
function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

/**
 * Resample an ordered placement run into `n` slots spaced evenly by arc length,
 * interpolating position / rotation / scale / weight between the originals. This
 * is what lets a Sample Path layout follow the curve at any element count: the
 * count drives the spacing, independent of how densely the path was sampled.
 * A closed run wraps across the closing segment so the last slot doesn't double
 * the first.
 */
function spreadAlongPath(layout: Placement[], closed: boolean, n: number): Placement[] {
  // a single sample (or single element) has nothing to space along
  if (layout.length === 1 || n === 1) {
    return Array.from({ length: n }, (_, i) => ({ ...layout[0], index: i }));
  }

  const ring = closed ? [...layout, layout[0]] : layout;
  const cum = [0];
  for (let i = 1; i < ring.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return Array.from({ length: n }, (_, i) => ({ ...layout[0], index: i }));

  const out: Placement[] = [];
  for (let i = 0; i < n; i++) {
    // closed: spread over the full loop (i/n); open: endpoints included (i/(n-1))
    const target = (closed ? i / n : i / (n - 1)) * total;
    let seg = 0;
    while (seg < ring.length - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg];
    const local = span === 0 ? 0 : (target - cum[seg]) / span;
    const a = ring[seg], b = ring[seg + 1];
    out.push({
      x: a.x + (b.x - a.x) * local,
      y: a.y + (b.y - a.y) * local,
      rotation: lerpAngle(a.rotation, b.rotation, local),
      scale: a.scale + (b.scale - a.scale) * local,
      weight: a.weight + (b.weight - a.weight) * local,
      index: i,
    });
  }
  return out;
}

export const PlaceNode: NodeDef = {
  type: 'Place',
  inputs: [
    { name: 'elements', type: ['elements', 'vector', 'raster', 'text'] },
    { name: 'layout', type: 'layout' },
  ],
  outputs: [{ name: 'out', type: 'elements' }],
  params: [
    // spread: re-space the elements evenly along the layout (treated as an
    //   ordered path), so the element count drives the spacing — add copies and
    //   they re-distribute instead of stacking. cycle/by-index/shuffle snap each
    //   element to an existing slot (good for grids; a prefix of a Sample Path).
    { name: 'distribute', kind: 'select', options: ['spread', 'cycle', 'by-index', 'shuffle'], default: 'cycle' },
    { name: 'bindWeight', kind: 'select', options: ['none', 'scale', 'rotation'], default: 'none' },
    { name: 'bindAmount', kind: 'number', default: 1, min: 0, max: 1, step: 0.01 },
    { name: 'seed', kind: 'number', default: 0, min: 0, max: 9999, step: 1 },
  ],
  cook(inputs, params) {
    const elements = asElements(inputs.elements as Value);
    const layoutValue = inputs.layout as LayoutValue;
    const layout = layoutValue.placements;
    const amount = Number(params.bindAmount);
    const seed = Number(params.seed);
    if (elements.length === 0 || layout.length === 0) {
      return { out: { kind: 'elements', items: [] } satisfies ElementsValue };
    }

    // spread mode resamples the layout into exactly one slot per element, evenly
    // along the path — so changing the element count re-spaces everything.
    const spread =
      params.distribute === 'spread'
        ? spreadAlongPath(layout, layoutValue.closed ?? false, elements.length)
        : null;

    // The element lane decides how many: one output item per element. cycle/
    // by-index/shuffle snap to existing slots — extra placements (e.g. unused
    // grid cells) stay empty; if elements outnumber placements they wrap.
    const slotFor = (e: Element, i: number): Placement => {
      if (spread) return spread[i];
      if (params.distribute === 'by-index') {
        return layout.find((p) => p.index === e.index) ?? layout[i % layout.length];
      }
      if (params.distribute === 'shuffle') {
        return layout[Math.floor(latticeHash(i, 31, seed) * layout.length)];
      }
      return layout[i % layout.length];
    };

    const items: Element[] = elements.map((e, i) => {
      const p = slotFor(e, i);
      let scale = e.transform.scale * p.scale;
      let rotation = e.transform.rotation + p.rotation;
      if (params.bindWeight === 'scale') scale *= 1 - amount * (1 - p.weight);
      if (params.bindWeight === 'rotation') rotation += amount * (p.weight - 0.5) * Math.PI;
      return {
        content: e.content,
        // the placement replaces the element's position; rotation/scale compose
        transform: { x: p.x, y: p.y, rotation, scale },
        index: e.index,
        weight: p.weight,
      };
    });

    const value: ElementsValue = { kind: 'elements', items };
    return { out: value };
  },
};

export const FlattenNode: NodeDef = {
  type: 'Flatten',
  inputs: [{ name: 'in', type: 'elements' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [],
  cook(inputs, _params, ctx) {
    const elements = (inputs.in as ElementsValue).items;
    const paths: PathCmd[][] = [];
    for (const el of elements) {
      let content: PathCmd[][];
      if (el.content.kind === 'vector') {
        content = el.content.paths;
      } else if (el.content.kind === 'text') {
        const font = ctx.fonts.get(el.content.fontKey);
        if (!font) throw new Error(`font not loaded: ${el.content.fontKey}`);
        const t = el.content;
        content = t.glyphs.map((g) => font.glyphs.get(g.glyphId).getPath(g.x, g.y, t.fontSize).commands as PathCmd[]);
      } else {
        throw new Error('Flatten: raster element content is not supported yet — Trace it first');
      }
      paths.push(...transformPaths(content, el.transform));
    }
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    return { out: value };
  },
};
