// Boolean (vector, vector => vector) — union / subtract / intersect via
// Paper.js. Inputs are pre-flattened to polygons (winding preserved), so the
// boolean runs on robust polygon geometry; curve fidelity is set by the
// flatten step, which is far below raster resolution.

import paper from 'paper';
import { flattenPaths, boundsOfPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { PathCmd, VectorValue } from '../engine/values';

let paperReady = false;
function getPaper(): typeof paper {
  if (!paperReady) {
    paper.setup(new paper.Size(1, 1)); // headless scope — we only use the geometry engine
    paperReady = true;
  }
  return paper;
}

function toPaperItem(v: VectorValue): paper.PathItem {
  const P = getPaper();
  const children = flattenPaths(v.paths, 1.5).map(
    (poly) =>
      new P.Path({
        segments: poly.points.map((p) => [p.x, p.y]),
        closed: true,
        insert: false,
      }),
  );
  if (children.length === 1) return children[0];
  return new P.CompoundPath({ children, insert: false });
}

function fromPaperItem(item: paper.PathItem): PathCmd[][] {
  const paths = item instanceof paper.CompoundPath ? (item.children as paper.Path[]) : [item as paper.Path];
  const out: PathCmd[][] = [];
  for (const path of paths) {
    if (path.segments.length < 2) continue;
    const cmds: PathCmd[] = [{ type: 'M', x: path.segments[0].point.x, y: path.segments[0].point.y }];
    for (let i = 1; i < path.segments.length; i++) {
      cmds.push({ type: 'L', x: path.segments[i].point.x, y: path.segments[i].point.y });
    }
    cmds.push({ type: 'Z' });
    out.push(cmds);
  }
  return out;
}

export const BooleanNode: NodeDef = {
  type: 'Boolean',
  inputs: [
    { name: 'a', type: 'vector' },
    { name: 'b', type: 'vector' },
  ],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [{ name: 'op', kind: 'select', options: ['union', 'subtract', 'intersect'], default: 'subtract' }],
  cook(inputs, params) {
    const srcA = inputs.a as VectorValue;
    const a = toPaperItem(srcA);
    const b = toPaperItem(inputs.b as VectorValue);
    let result: paper.PathItem;
    switch (params.op) {
      case 'union': result = a.unite(b, { insert: false }); break;
      case 'intersect': result = a.intersect(b, { insert: false }); break;
      default: result = a.subtract(b, { insert: false });
    }
    const paths = fromPaperItem(result);
    // the a-side is the operand being carved/kept — its style wins
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths), style: srcA.style };
    return { out: value };
  },
};
