// Layout lane. Generators (Grid, Random, Sample Path, Function) emit
// placements; modulators (Random-with-input, Filter, Sort) reshape them.
// Draw Layout makes placements visible/styleable geometry for debugging.

import { boundsOfPaths, flattenPaths, polylinesToPaths, samplePathEvenly } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { LayoutValue, PathCmd, Placement, VectorValue } from '../engine/values';
import { latticeHash } from '../util/noise';

export const GridNode: NodeDef = {
  type: 'Grid',
  inputs: [],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'columns', kind: 'number', default: 6, min: 1, max: 64, step: 1 },
    { name: 'rows', kind: 'number', default: 4, min: 1, max: 64, step: 1 },
    { name: 'spacingX', kind: 'number', default: 100, min: 1, max: 600, step: 1 },
    { name: 'spacingY', kind: 'number', default: 100, min: 1, max: 600, step: 1 },
  ],
  cook(_inputs, params) {
    const cols = Math.round(Number(params.columns));
    const rows = Math.round(Number(params.rows));
    const sx = Number(params.spacingX), sy = Number(params.spacingY);
    const placements: Placement[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        placements.push({
          x: (c - (cols - 1) / 2) * sx,
          y: (r - (rows - 1) / 2) * sy,
          rotation: 0,
          scale: 1,
          weight: 1,
          index: r * cols + c,
        });
      }
    }
    return { out: { kind: 'layout', placements } satisfies LayoutValue };
  },
};

export const RandomLayoutNode: NodeDef = {
  type: 'Random',
  inputs: [{ name: 'layout', type: 'layout', optional: true }],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    // generate mode (no input): uniform placements in an area
    { name: 'count', kind: 'number', default: 24, min: 1, max: 1000, step: 1 },
    { name: 'areaWidth', kind: 'number', default: 600, min: 10, max: 4096, step: 1 },
    { name: 'areaHeight', kind: 'number', default: 400, min: 10, max: 4096, step: 1 },
    // modulate mode (input wired): seeded jitter on existing placements
    { name: 'offset', kind: 'number', default: 0, min: 0, max: 300, step: 1 },
    { name: 'rotate', kind: 'number', default: 0, min: 0, max: 3.14, step: 0.01 },
    { name: 'scaleJitter', kind: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  ],
  cook(inputs, params) {
    const seed = Number(params.seed);
    const upstream = inputs.layout as LayoutValue | undefined;

    if (!upstream) {
      const count = Math.round(Number(params.count));
      const w = Number(params.areaWidth), h = Number(params.areaHeight);
      const placements: Placement[] = [];
      for (let i = 0; i < count; i++) {
        placements.push({
          x: (latticeHash(i, 1, seed) - 0.5) * w,
          y: (latticeHash(i, 2, seed) - 0.5) * h,
          rotation: 0,
          scale: 1,
          weight: latticeHash(i, 3, seed),
          index: i,
        });
      }
      return { out: { kind: 'layout', placements } satisfies LayoutValue };
    }

    const off = Number(params.offset), rot = Number(params.rotate), sj = Number(params.scaleJitter);
    const placements = upstream.placements.map((p, i) => ({
      ...p,
      x: p.x + (latticeHash(i, 11, seed) - 0.5) * 2 * off,
      y: p.y + (latticeHash(i, 12, seed) - 0.5) * 2 * off,
      rotation: p.rotation + (latticeHash(i, 13, seed) - 0.5) * 2 * rot,
      scale: p.scale * (1 + (latticeHash(i, 14, seed) - 0.5) * 2 * sj),
    }));
    return { out: { kind: 'layout', placements } satisfies LayoutValue };
  },
};

export const SamplePathNode: NodeDef = {
  type: 'SamplePath',
  inputs: [{ name: 'path', type: 'vector' }],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'count', kind: 'number', default: 12, min: 1, max: 500, step: 1 },
    { name: 'tangent', kind: 'select', options: ['rotate', 'upright'], default: 'rotate' },
  ],
  cook(inputs, params) {
    const vector = inputs.path as VectorValue;
    const samples = samplePathEvenly(flattenPaths(vector.paths), Math.round(Number(params.count)));
    const placements: Placement[] = samples.map((s, i) => ({
      x: s.x,
      y: s.y,
      rotation: params.tangent === 'rotate' ? s.rotation : 0,
      scale: 1,
      weight: s.t, // arc-length position as the density signal
      index: i,
    }));
    return { out: { kind: 'layout', placements } satisfies LayoutValue };
  },
};

export const FunctionLayoutNode: NodeDef = {
  type: 'Function',
  inputs: [],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'fn', kind: 'select', options: ['circle', 'spiral', 'wave'], default: 'circle' },
    { name: 'count', kind: 'number', default: 16, min: 1, max: 500, step: 1 },
    { name: 'radius', kind: 'number', default: 200, min: 1, max: 1000, step: 1 },
    { name: 'turns', kind: 'number', default: 3, min: 0.25, max: 12, step: 0.25 },
    { name: 'spacing', kind: 'number', default: 40, min: 1, max: 300, step: 1 },
  ],
  cook(_inputs, params) {
    const count = Math.round(Number(params.count));
    const r = Number(params.radius), turns = Number(params.turns), spacing = Number(params.spacing);
    const placements: Placement[] = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      let x = 0, y = 0, rotation = 0;
      switch (params.fn) {
        case 'spiral': {
          const a = turns * Math.PI * 2 * t;
          const rr = r * t;
          x = Math.cos(a) * rr;
          y = Math.sin(a) * rr;
          rotation = a + Math.PI / 2;
          break;
        }
        case 'wave':
          x = (i - (count - 1) / 2) * spacing;
          y = Math.sin(t * turns * Math.PI * 2) * r * 0.25;
          rotation = Math.atan2(Math.cos(t * turns * Math.PI * 2), 1) * 0.5;
          break;
        default: { // circle: closed spacing, no doubled endpoint
          const a = (i / count) * Math.PI * 2 - Math.PI / 2;
          x = Math.cos(a) * r;
          y = Math.sin(a) * r;
          rotation = a + Math.PI / 2;
        }
      }
      placements.push({ x, y, rotation, scale: 1, weight: t, index: i });
    }
    return { out: { kind: 'layout', placements } satisfies LayoutValue };
  },
};

export const FilterLayoutNode: NodeDef = {
  type: 'Filter',
  inputs: [{ name: 'layout', type: 'layout' }],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'mode', kind: 'select', options: ['every-nth', 'weight-above', 'weight-below'], default: 'every-nth' },
    { name: 'n', kind: 'number', default: 2, min: 1, max: 32, step: 1 },
    { name: 'threshold', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  cook(inputs, params) {
    const placements = (inputs.layout as LayoutValue).placements.filter((p, i) => {
      switch (params.mode) {
        case 'weight-above': return p.weight >= Number(params.threshold);
        case 'weight-below': return p.weight < Number(params.threshold);
        default: return i % Math.round(Number(params.n)) === 0;
      }
    });
    return { out: { kind: 'layout', placements } satisfies LayoutValue };
  },
};

export const SortLayoutNode: NodeDef = {
  type: 'Sort',
  inputs: [{ name: 'layout', type: 'layout' }],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'by', kind: 'select', options: ['x', 'y', 'weight', 'seeded'], default: 'x' },
    { name: 'reverse', kind: 'select', options: ['no', 'yes'], default: 'no' },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  ],
  cook(inputs, params) {
    const seed = Number(params.seed);
    const placements = [...(inputs.layout as LayoutValue).placements];
    const key = (p: Placement, i: number): number => {
      switch (params.by) {
        case 'y': return p.y;
        case 'weight': return p.weight;
        case 'seeded': return latticeHash(i, 7, seed);
        default: return p.x;
      }
    };
    const decorated = placements.map((p, i) => ({ p, k: key(p, i) }));
    decorated.sort((a, b) => (params.reverse === 'yes' ? b.k - a.k : a.k - b.k));
    // re-index in the new order — Sort's whole point is changing assignment order
    const sorted = decorated.map(({ p }, i) => ({ ...p, index: i }));
    return { out: { kind: 'layout', placements: sorted } satisfies LayoutValue };
  },
};

export const DrawLayoutNode: NodeDef = {
  type: 'DrawLayout',
  inputs: [{ name: 'layout', type: 'layout' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [{ name: 'size', kind: 'number', default: 8, min: 1, max: 64, step: 1 }],
  cook(inputs, params) {
    const size = Number(params.size);
    const paths: PathCmd[][] = [];
    for (const p of (inputs.layout as LayoutValue).placements) {
      const r = size * p.scale * (0.35 + 0.65 * p.weight);
      // circle marker (octagon is plenty at marker size)
      const circle: { x: number; y: number }[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        circle.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r });
      }
      paths.push(...polylinesToPaths([{ points: circle, closed: true }]));
      // rotation tick
      paths.push([
        { type: 'M', x: p.x, y: p.y },
        { type: 'L', x: p.x + Math.cos(p.rotation) * r * 2, y: p.y + Math.sin(p.rotation) * r * 2 },
      ]);
    }
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    return { out: value };
  },
};
