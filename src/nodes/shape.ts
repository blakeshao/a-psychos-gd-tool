// Shape — parametric vector source: rect, ellipse, polygon. Centered on the
// origin; downstream ops and Rasterize's centering handle placement for now.

import { boundsOfPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { PathCmd, StrokeAlign, Style, VectorValue } from '../engine/values';

const KAPPA = 0.5522847498; // cubic approximation of a quarter arc

export const ShapeNode: NodeDef = {
  type: 'Shape',
  inputs: [],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [
    { name: 'kind', kind: 'select', options: ['rect', 'ellipse', 'polygon'], default: 'ellipse' },
    { name: 'width', kind: 'number', default: 300, min: 1, max: 2000, step: 1 },
    { name: 'height', kind: 'number', default: 300, min: 1, max: 2000, step: 1 },
    { name: 'sides', kind: 'number', default: 6, min: 3, max: 24, step: 1 },
    { name: 'fill', kind: 'color', default: '#000000' },
    { name: 'stroke', kind: 'toggle', default: false },
    { name: 'strokeColor', kind: 'color', default: '#000000', showIf: { param: 'stroke', in: ['true'] } },
    { name: 'strokeWidth', kind: 'number', default: 4, min: 0, max: 100, step: 0.5, showIf: { param: 'stroke', in: ['true'] } },
    { name: 'strokeAlign', kind: 'select', options: ['center', 'inside', 'outside'], default: 'center', showIf: { param: 'stroke', in: ['true'] } },
  ],
  cook(_inputs, params) {
    const w = Number(params.width) / 2;
    const h = Number(params.height) / 2;
    let cmds: PathCmd[];
    switch (params.kind) {
      case 'rect':
        cmds = [
          { type: 'M', x: -w, y: -h },
          { type: 'L', x: w, y: -h },
          { type: 'L', x: w, y: h },
          { type: 'L', x: -w, y: h },
          { type: 'Z' },
        ];
        break;
      case 'polygon': {
        const n = Math.round(Number(params.sides));
        cmds = [];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(a) * w, y = Math.sin(a) * h;
          cmds.push(i === 0 ? { type: 'M', x, y } : { type: 'L', x, y });
        }
        cmds.push({ type: 'Z' });
        break;
      }
      default: { // ellipse: four cubic arcs
        const kx = w * KAPPA, ky = h * KAPPA;
        cmds = [
          { type: 'M', x: 0, y: -h },
          { type: 'C', x1: kx, y1: -h, x2: w, y2: -ky, x: w, y: 0 },
          { type: 'C', x1: w, y1: ky, x2: kx, y2: h, x: 0, y: h },
          { type: 'C', x1: -kx, y1: h, x2: -w, y2: ky, x: -w, y: 0 },
          { type: 'C', x1: -w, y1: -ky, x2: -kx, y2: -h, x: 0, y: -h },
          { type: 'Z' },
        ];
      }
    }
    const style: Style = {
      fill: String(params.fill ?? '#000000'),
      stroke: String(params.strokeColor ?? '#000000'),
      // the toggle folds into the width — 0 reads as "off" everywhere
      strokeWidth: params.stroke === true ? Number(params.strokeWidth ?? 4) : 0,
      strokeAlign: String(params.strokeAlign ?? 'center') as StrokeAlign,
      grow: 0,
    };
    const paths = [cmds];
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths), style };
    return { out: value };
  },
};
