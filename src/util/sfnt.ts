// TrueType Collection (.ttc) unpacking. macOS serves many system families as
// collections (Helvetica, Times, Menlo…) and opentype.js only reads a single
// sfnt, so each face is re-packed into a standalone buffer: sfnt header +
// table directory copied as-is, table data appended with offsets rewritten.

const TTCF = 0x74746366; // 'ttcf'

/** Whether the buffer is a TrueType Collection rather than a single font. */
export function isCollection(buf: ArrayBuffer): boolean {
  return buf.byteLength >= 4 && new DataView(buf).getUint32(0) === TTCF;
}

/** Number of faces in the buffer — 1 for a plain .ttf/.otf. */
export function faceCount(buf: ArrayBuffer): number {
  return isCollection(buf) ? new DataView(buf).getUint32(8) : 1;
}

/**
 * Extract face `index` as a standalone sfnt buffer. A non-collection buffer
 * passes through untouched (only index 0 exists).
 */
export function extractFace(buf: ArrayBuffer, index: number): ArrayBuffer {
  if (!isCollection(buf)) {
    if (index !== 0) throw new Error(`not a collection: face ${index} does not exist`);
    return buf;
  }
  const view = new DataView(buf);
  const count = view.getUint32(8);
  if (index < 0 || index >= count) throw new Error(`face ${index} out of range (collection has ${count})`);
  const fontOffset = view.getUint32(12 + index * 4);

  const numTables = view.getUint16(fontOffset + 4);
  const headerLen = 12 + numTables * 16;
  let dataLen = 0;
  for (let i = 0; i < numTables; i++) {
    const len = view.getUint32(fontOffset + 12 + i * 16 + 12);
    dataLen += (len + 3) & ~3; // tables stay 4-byte aligned
  }

  const out = new ArrayBuffer(headerLen + dataLen);
  const src = new Uint8Array(buf);
  const dst = new Uint8Array(out);
  const dv = new DataView(out);
  dst.set(src.subarray(fontOffset, fontOffset + headerLen), 0);
  let cursor = headerLen;
  for (let i = 0; i < numTables; i++) {
    const rec = fontOffset + 12 + i * 16;
    const off = view.getUint32(rec + 8);
    const len = view.getUint32(rec + 12);
    dst.set(src.subarray(off, off + len), cursor);
    dv.setUint32(12 + i * 16 + 8, cursor); // table offsets are absolute — repoint into this buffer
    cursor += (len + 3) & ~3;
  }
  return out;
}
