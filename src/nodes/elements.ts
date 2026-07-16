// The element lane: Split peels live type into pieces, Duplicator multiplies
// a vector, Place zips elements onto layout placements, Flatten is the
// explicit conversion back down the ladder (elements => vector).
//
// Division of labor with the layout lane (layout.ts): the lane decides what
// slots exist and what signal rides on them; the element lane decides how
// many things exist; Place alone decides how they meet — assignment order,
// keyed joins, spacing (spread), and how the slot channels bend the
// transform (bind). Ordering lives here, not in a layout node, so slot
// `index` stays stable identity for its whole life.

import { boundsOfPaths, transformPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import {
  readChannel,
  type Element,
  type ElementsValue,
  type LayoutValue,
  type PathCmd,
  type Placement,
  type Style,
  type TextValue,
  type Value,
  type VectorValue,
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
    return [{ content: v, transform: { x: 0, y: 0, rotation: 0, scale: 1 }, index: 0, progress: 0, weight: 1 }];
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
            style: text.style,
          },
          transform: { x: x0, y: 0, rotation: 0, scale: 1 }, // keeps its shaped position
          index: wordIdx++,
          progress: 0, // filled below once the count is known
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
            style: text.style,
          },
          transform: { x: g.x, y: g.y, rotation: 0, scale: 1 }, // kerned position preserved
          index: i,
          progress: 0, // filled below once the count is known
          weight: 1,
        });
      });
    }

    items.forEach((el, k) => (el.progress = items.length === 1 ? 0 : k / (items.length - 1)));
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
          progress: count === 1 ? 0 : i / (count - 1), // copy fraction — position, not density
          weight: 1,
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

  // named channels lerp too; a side missing the name reads as neutral 1
  const lerpChannels = (a: Placement, b: Placement, t: number): Record<string, number> | undefined => {
    if (!a.channels && !b.channels) return undefined;
    const out: Record<string, number> = {};
    for (const k of new Set([...Object.keys(a.channels ?? {}), ...Object.keys(b.channels ?? {})])) {
      const av = a.channels?.[k] ?? 1, bv = b.channels?.[k] ?? 1;
      out[k] = av + (bv - av) * t;
    }
    return out;
  };

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
      progress: a.progress + (b.progress - a.progress) * local,
      weight: a.weight + (b.weight - a.weight) * local,
      channels: lerpChannels(a, b, local),
      index: i,
    });
  }
  return out;
}

/** One channel binding: slot signal → element property. */
export interface BindSpec {
  /** 'weight', 'progress', or a named channel a Weight node wrote */
  channel: string;
  target: 'scale' | 'rotation' | 'blur';
  /** scale/rotation: 0..1 strength; blur: radius in px at signal 1 */
  amount: number;
  /** flip the signal (1 − s) before applying */
  invert?: boolean;
  /** added to the signal after invert — biases where the effect sits */
  offset?: number;
}

export const BIND_TARGETS: BindSpec['target'][] = ['scale', 'rotation', 'blur'];

/** Parse a binds param (JSON) defensively — malformed rows drop, never throw. */
export function parseBinds(raw: unknown): BindSpec[] {
  try {
    const arr: unknown = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (b): b is BindSpec =>
        !!b && typeof b === 'object'
        && typeof (b as BindSpec).channel === 'string'
        && BIND_TARGETS.includes((b as BindSpec).target)
        && Number.isFinite(Number((b as BindSpec).amount)),
    ).map((b) => ({
      ...b,
      amount: Number(b.amount),
      invert: b.invert === true,
      offset: Number.isFinite(Number(b.offset)) ? Number(b.offset) : 0,
    }));
  } catch {
    return [];
  }
}

export const PlaceNode: NodeDef = {
  type: 'Place',
  inputs: [
    { name: 'elements', type: ['elements', 'vector', 'raster', 'text'] },
    { name: 'layout', type: 'layout' },
  ],
  outputs: [{ name: 'out', type: 'elements' }],
  params: [
    // by-order: zip elements onto slots in `order` (extra slots stay empty; if
    //   elements outnumber slots they wrap). by-index: keyed join on slot
    //   identity — elements whose slot is gone (Filtered away) sit out.
    // spread: re-space the elements evenly along the layout (treated as an
    //   ordered path), so the element count drives the spacing — add copies
    //   and they re-distribute instead of stacking.
    { name: 'distribute', kind: 'select', options: ['by-order', 'by-index', 'spread'], default: 'by-order' },
    // nudge the whole arrangement — every placed element shifts by this much
    { name: 'offsetX', kind: 'number', default: 0, min: -1000, max: 1000, step: 1 },
    { name: 'offsetY', kind: 'number', default: 0, min: -1000, max: 1000, step: 1 },
    // slot consumption order — Sort, absorbed. `source` = the generator's fill
    // order; `random` is a seeded permutation (every slot used once).
    { name: 'order', kind: 'select', options: ['source', 'x', 'y', 'progress', 'weight', 'random'], default: 'source', showIf: { param: 'distribute', in: ['by-order', 'spread'] } },
    { name: 'reverse', kind: 'select', options: ['no', 'yes'], default: 'no', showIf: { param: 'distribute', in: ['by-order', 'spread'] } },
    { name: 'seed', kind: 'number', default: 0, min: 0, max: 9999, step: 1, showIf: { param: 'order', in: ['random'] } },
    // binds: a list of {channel, target, amount} rows — each binds one slot
    // signal (weight, progress, or a named channel a Weight node wrote) to one
    // element property, so several independent signals can drive one Place.
    // The editor renders the rows with an "add channel" button.
    { name: 'binds', kind: 'binds', default: '[]' },
  ],
  cook(inputs, params) {
    const elements = asElements(inputs.elements as Value);
    const layoutValue = inputs.layout as LayoutValue;
    if (elements.length === 0 || layoutValue.placements.length === 0) {
      return { out: { kind: 'elements', items: [] } satisfies ElementsValue };
    }

    const binds = parseBinds(params.binds);

    // sequence the slots — a view over the layout; slot identity is untouched
    let slots = [...layoutValue.placements];
    const key: ((p: Placement) => number) | null =
      params.order === 'x' ? (p) => p.x
      : params.order === 'y' ? (p) => p.y
      : params.order === 'progress' ? (p) => p.progress
      : params.order === 'weight' ? (p) => p.weight
      : null;
    if (key) slots.sort((a, b) => key(a) - key(b));
    if (params.order === 'random') {
      const seed = Number(params.seed);
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(latticeHash(i, 31, seed) * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
    }
    if (params.reverse === 'yes') slots.reverse();

    // spread resamples the (ordered) slot run into exactly one slot per
    // element, evenly by arc length — the element count drives the spacing.
    if (params.distribute === 'spread') {
      slots = spreadAlongPath(slots, layoutValue.closed ?? false, elements.length);
    }

    const byIndex = params.distribute === 'by-index'
      ? new Map(layoutValue.placements.map((p) => [p.index, p]))
      : null;

    const offsetX = Number(params.offsetX ?? 0);
    const offsetY = Number(params.offsetY ?? 0);
    const items: Element[] = [];
    elements.forEach((e, i) => {
      // keyed join: no slot with this identity → the element sits out
      const p = byIndex ? byIndex.get(e.index) : slots[i % slots.length];
      if (!p) return;
      let scale = e.transform.scale * p.scale;
      let rotation = e.transform.rotation + p.rotation;
      let blur = 0;
      for (const b of binds) {
        let s = readChannel(p, b.channel);
        if (b.invert) s = 1 - s;
        s += b.offset ?? 0;
        if (b.target === 'scale') scale *= 1 - b.amount * (1 - s);
        else if (b.target === 'rotation') rotation += b.amount * (s - 0.5) * Math.PI;
        else if (b.target === 'blur') blur += s * b.amount; // amount = px at signal 1
      }
      items.push({
        content: e.content,
        // the placement replaces the element's position; rotation/scale compose
        transform: { x: p.x + offsetX, y: p.y + offsetY, rotation, scale },
        index: e.index,
        progress: p.progress, // position is a property of where you landed
        weight: e.weight * p.weight, // density composes; 1 is the identity
        ...(blur > 0 ? { blur } : {}),
      });
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
    // Flatten collapses to one vector, one style — the first styled content wins
    let style: Style | undefined;
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
      style ??= el.content.style;
      paths.push(...transformPaths(content, el.transform));
    }
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths), style };
    return { out: value };
  },
};
