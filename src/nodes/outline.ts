// Outline (text => vector) — glyphs become paths. The explicit step down the
// ladder: after this the text is geometry, no longer live type.

import { boundsOfPaths } from '../engine/path';
import type { NodeDef } from '../engine/registry';
import type { PathCmd, TextValue, VectorValue } from '../engine/values';

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

    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    return { out: value };
  },
};
