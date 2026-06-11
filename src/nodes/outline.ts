// Outline (text => vector) — glyphs become paths. The explicit step down the
// ladder: after this the text is geometry, no longer live type.

import type { NodeDef } from '../engine/registry';
import type { PathCmd, Rect, TextValue, VectorValue } from '../engine/values';

export const OutlineNode: NodeDef = {
  type: 'Outline',
  inputs: [{ name: 'text', type: 'text' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [],
  cook(inputs, _params, ctx) {
    const text = inputs.text as TextValue;
    const font = ctx.fonts.get(text.fontKey);
    if (!font) throw new Error(`font not loaded: ${text.fontKey}`);

    const paths: PathCmd[][] = [];
    for (const g of text.glyphs) {
      const glyph = font.glyphs.get(g.glyphId);
      const path = glyph.getPath(g.x, g.y, text.fontSize);
      paths.push(path.commands as PathCmd[]);
    }

    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOf(paths) };
    return { out: value };
  },
};

function boundsOf(paths: PathCmd[][]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const path of paths) {
    for (const cmd of path) {
      if (cmd.type === 'Z') continue;
      visit(cmd.x, cmd.y);
      // control points overestimate slightly; fine for a scaffold bound
      if (cmd.type === 'C') { visit(cmd.x1, cmd.y1); visit(cmd.x2, cmd.y2); }
      if (cmd.type === 'Q') visit(cmd.x1, cmd.y1);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
