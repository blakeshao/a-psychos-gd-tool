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
  /** the source string — Split needs it to find word boundaries */
  content: string;
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

/** translate ∘ rotate ∘ scale — applied scale-first when mapping points */
export interface Transform2D {
  x: number;
  y: number;
  rotation: number; // radians
  scale: number;
}

export const IDENTITY: Transform2D = { x: 0, y: 0, rotation: 0, scale: 1 };

/** One live sub-graphic: content + its own placement. Stays editable until Flatten. */
export interface Element {
  content: TextValue | VectorValue | RasterValue;
  transform: Transform2D;
  /** position in the source (glyph #, copy #) — survives Split/Duplicator, drives by-index Place */
  index: number;
  weight: number;
}

export interface ElementsValue {
  kind: 'elements';
  items: Element[];
}

/** A slot something can be placed into — position + tangent rotation + density weight. */
export interface Placement {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  weight: number;
  index: number;
}

export interface LayoutValue {
  kind: 'layout';
  placements: Placement[];
}

export type Value = TextValue | VectorValue | RasterValue | AlphaValue | ElementsValue | LayoutValue;

export type OutputValues = Record<string, Value>;
