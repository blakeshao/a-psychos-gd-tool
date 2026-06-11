// The values that flow on the wires during a cook. Transient — never serialized.
// CPU types (text/vector) are plain data; raster is a handle to a pooled GPU texture.

import type { PooledTexture } from '../gpu/pool';

export type SocketType = 'text' | 'vector' | 'raster' | 'alpha' | 'elements' | 'layout';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One shaped glyph: id into the font, pen position in px (kerning applied). */
export interface PositionedGlyph {
  glyphId: number;
  x: number;
  y: number;
  /** index within the original string — survives Split later */
  index: number;
}

export interface TextValue {
  kind: 'text';
  glyphs: PositionedGlyph[];
  fontKey: string;
  fontSize: number;
  /** total advance width in px */
  width: number;
}

/** Path commands, same shape opentype.js emits — M/L/C/Q/Z with absolute coords. */
export type PathCmd =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' };

export interface VectorValue {
  kind: 'vector';
  /** one PathCmd[] per subpath/glyph */
  paths: PathCmd[][];
  bounds: Rect;
}

export interface RasterValue {
  kind: 'raster';
  texture: PooledTexture;
  width: number;
  height: number;
}

export interface AlphaValue {
  kind: 'alpha';
  texture: PooledTexture;
  width: number;
  height: number;
}

export type Value = TextValue | VectorValue | RasterValue | AlphaValue;

export type OutputValues = Record<string, Value>;
