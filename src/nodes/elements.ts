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
  TextValue,
  VectorValue,
} from '../engine/values';
import { latticeHash } from '../util/noise';

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
  inputs: [{ name: 'in', type: 'vector' }],
  outputs: [{ name: 'out', type: 'elements' }],
  params: [{ name: 'count', kind: 'number', default: 12, min: 1, max: 500, step: 1 }],
  cook(inputs, params) {
    const src = inputs.in as VectorValue;
    const count = Math.round(Number(params.count));
    const items: Element[] = [];
    for (let i = 0; i < count; i++) {
      items.push({
        content: src, // copies share the source paths; transforms differ after Place
        transform: { x: 0, y: 0, rotation: 0, scale: 1 },
        index: i,
        weight: count === 1 ? 1 : i / (count - 1),
      });
    }
    const value: ElementsValue = { kind: 'elements', items };
    return { out: value };
  },
};

export const PlaceNode: NodeDef = {
  type: 'Place',
  inputs: [
    { name: 'elements', type: 'elements' },
    { name: 'layout', type: 'layout' },
  ],
  outputs: [{ name: 'out', type: 'elements' }],
  params: [
    { name: 'distribute', kind: 'select', options: ['cycle', 'by-index', 'shuffle'], default: 'cycle' },
    { name: 'bindWeight', kind: 'select', options: ['none', 'scale', 'rotation'], default: 'none' },
    { name: 'bindAmount', kind: 'number', default: 1, min: 0, max: 1, step: 0.01 },
    { name: 'seed', kind: 'number', default: 0, min: 0, max: 9999, step: 1 },
  ],
  cook(inputs, params) {
    const elements = (inputs.elements as ElementsValue).items;
    const layout = (inputs.layout as LayoutValue).placements;
    const amount = Number(params.bindAmount);
    const seed = Number(params.seed);
    if (elements.length === 0 || layout.length === 0) {
      return { out: { kind: 'elements', items: [] } satisfies ElementsValue };
    }

    const pick = (i: number): Element => {
      if (params.distribute === 'by-index') {
        const p = layout[i];
        return elements.find((e) => e.index === p.index) ?? elements[i % elements.length];
      }
      if (params.distribute === 'shuffle') {
        return elements[Math.floor(latticeHash(i, 31, seed) * elements.length)];
      }
      return elements[i % elements.length];
    };

    const items: Element[] = layout.map((p, i) => {
      const e = pick(i);
      let scale = e.transform.scale * p.scale;
      let rotation = e.transform.rotation + p.rotation;
      if (params.bindWeight === 'scale') scale *= 1 - amount * (1 - p.weight);
      if (params.bindWeight === 'rotation') rotation += amount * (p.weight - 0.5) * Math.PI;
      return {
        content: e.content,
        // the placement replaces the element's position; rotation/scale compose
        transform: { x: p.x, y: p.y, rotation, scale },
        index: p.index,
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
