// Text — live type. Shapes the string into positioned glyphs (advances +
// kerning applied) so Split can later peel off glyphs that keep their
// kerned positions and index.

import type { NodeDef } from '../engine/registry';
import type { PositionedGlyph, TextValue } from '../engine/values';

export const TextNode: NodeDef = {
  type: 'Text',
  inputs: [],
  outputs: [{ name: 'out', type: 'text' }],
  params: [
    { name: 'content', kind: 'string', default: 'PSYCHO' },
    { name: 'fontSize', kind: 'number', default: 160, min: 8, max: 400, step: 1 },
    { name: 'font', kind: 'string', default: 'default' },
  ],
  cook(_inputs, params, ctx) {
    const fontKey = String(params.font);
    const font = ctx.fonts.get(fontKey);
    if (!font) throw new Error(`font not loaded: ${fontKey}`);
    const content = String(params.content);
    const fontSize = Number(params.fontSize);
    const scale = fontSize / font.unitsPerEm;

    const glyphs: PositionedGlyph[] = [];
    const shaped = font.stringToGlyphs(content);
    let x = 0;
    for (let i = 0; i < shaped.length; i++) {
      const glyph = shaped[i];
      glyphs.push({ glyphId: glyph.index, x, y: 0, index: i });
      x += (glyph.advanceWidth ?? 0) * scale;
      if (i + 1 < shaped.length) {
        x += font.getKerningValue(glyph, shaped[i + 1]) * scale;
      }
    }

    const value: TextValue = { kind: 'text', content, glyphs, fontKey, fontSize, width: x };
    return { out: value };
  },
};
