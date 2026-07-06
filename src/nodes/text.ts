// Text — live type. Shapes the string into positioned glyphs (advances +
// kerning applied) so Split can later peel off glyphs that keep their
// kerned positions and index.

import type { NodeDef } from '../engine/registry';
import type { PositionedGlyph, StrokeAlign, Style, TextValue } from '../engine/values';

export const TextNode: NodeDef = {
  type: 'Text',
  inputs: [],
  outputs: [{ name: 'out', type: 'text' }],
  params: [
    { name: 'content', kind: 'string', default: 'PSYCHO' },
    { name: 'fontSize', kind: 'number', default: 160, min: 8, max: 400, step: 1 },
    { name: 'font', kind: 'string', default: 'default' },
    { name: 'weight', kind: 'number', default: 400, min: 100, max: 900, step: 50 },
    { name: 'fill', kind: 'color', default: '#000000' },
    { name: 'stroke', kind: 'toggle', default: false },
    { name: 'strokeColor', kind: 'color', default: '#000000', showIf: { param: 'stroke', in: ['true'] } },
    { name: 'strokeWidth', kind: 'number', default: 4, min: 0, max: 50, step: 0.5, showIf: { param: 'stroke', in: ['true'] } },
    { name: 'strokeAlign', kind: 'select', options: ['center', 'inside', 'outside'], default: 'center', showIf: { param: 'stroke', in: ['true'] } },
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

    // single font file per family — weight is synthetic, baked to a px
    // grow/erode so it keeps working after Outline turns the type to paths
    const weight = Number(params.weight ?? 400);
    const style: Style = {
      fill: String(params.fill ?? '#000000'),
      stroke: String(params.strokeColor ?? '#000000'),
      // the toggle folds into the width — 0 reads as "off" everywhere
      strokeWidth: params.stroke === true ? Number(params.strokeWidth ?? 4) : 0,
      strokeAlign: String(params.strokeAlign ?? 'center') as StrokeAlign,
      grow: ((weight - 400) / 400) * fontSize * 0.03,
    };

    const value: TextValue = { kind: 'text', content, glyphs, fontKey, fontSize, width: x, style };
    return { out: value };
  },
};
