import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as opentype from 'opentype.js';
import { extractFace, faceCount, isCollection } from './sfnt';

const ttfBuf = (() => {
  const b = readFileSync(join(__dirname, '../../public/fonts/JetBrainsMono-Regular.ttf'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
})();

/** Wrap a single .ttf into a one-face .ttc container (offsets shifted by the header). */
function wrapInCollection(sfnt: ArrayBuffer): ArrayBuffer {
  const headerLen = 16; // tag, version, numFonts, offset[0]
  const out = new ArrayBuffer(headerLen + sfnt.byteLength);
  const dst = new Uint8Array(out);
  const dv = new DataView(out);
  dv.setUint32(0, 0x74746366); // 'ttcf'
  dv.setUint32(4, 0x00010000);
  dv.setUint32(8, 1);
  dv.setUint32(12, headerLen);
  dst.set(new Uint8Array(sfnt), headerLen);
  // table offsets are absolute — shift each by the prepended header
  const src = new DataView(sfnt);
  const numTables = src.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = headerLen + 12 + i * 16;
    dv.setUint32(rec + 8, src.getUint32(12 + i * 16 + 8) + headerLen);
  }
  return out;
}

describe('sfnt', () => {
  it('passes a plain .ttf through untouched', () => {
    expect(isCollection(ttfBuf)).toBe(false);
    expect(faceCount(ttfBuf)).toBe(1);
    expect(extractFace(ttfBuf, 0)).toBe(ttfBuf);
  });

  it('extracts a parseable face from a collection', () => {
    const ttc = wrapInCollection(ttfBuf);
    expect(isCollection(ttc)).toBe(true);
    expect(faceCount(ttc)).toBe(1);
    const font = opentype.parse(extractFace(ttc, 0));
    expect(font.unitsPerEm).toBeGreaterThan(0);
    expect(font.stringToGlyphs('AB').length).toBe(2);
  });

  it('rejects an out-of-range face index', () => {
    expect(() => extractFace(wrapInCollection(ttfBuf), 1)).toThrow(/out of range/);
    expect(() => extractFace(ttfBuf, 1)).toThrow(/not a collection/);
  });

  // real-world check when the machine has one (macOS ships Helvetica as a .ttc)
  const helvetica = '/System/Library/Fonts/Helvetica.ttc';
  it.skipIf(!existsSync(helvetica))('parses every face of a real macOS .ttc', () => {
    const b = readFileSync(helvetica);
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    expect(isCollection(buf)).toBe(true);
    for (let i = 0; i < faceCount(buf); i++) {
      const font = opentype.parse(extractFace(buf, i));
      expect(font.unitsPerEm).toBeGreaterThan(0);
    }
  });
});
