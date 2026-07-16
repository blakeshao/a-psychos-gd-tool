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

/**
 * Paint attributes riding on text/vector values. Producers (Text, Shape) set
 * it from params; pass-through ops carry it unchanged; painters fall back to
 * DEFAULT_STYLE when absent (Trace & friends emit bare geometry).
 */
/** Where the stroke sits relative to the path edge. */
export type StrokeAlign = 'center' | 'inside' | 'outside';

export interface Style {
  fill: string; // '#rrggbb'
  stroke: string; // '#rrggbb' — drawn only when strokeWidth > 0
  strokeWidth: number; // px — 0 means the stroke is off
  strokeAlign: StrokeAlign;
  /** synthetic weight, px per side: >0 fattens the ink, <0 erodes it. Text
   * bakes its weight param to px here so the effect survives Outline. */
  grow: number;
}

export const DEFAULT_STYLE: Style = {
  fill: '#000000',
  stroke: '#000000',
  strokeWidth: 0,
  strokeAlign: 'center',
  grow: 0,
};

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
  style?: Style;
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
  style?: Style;
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
  /** stable identity in the source (glyph #, copy #) — drives by-index Place */
  index: number;
  /** WHERE in the source run, 0→1 (glyph position, copy fraction) */
  progress: number;
  /** HOW MUCH — density/importance, 1 = neutral; composes multiplicatively through Place */
  weight: number;
  /** blur radius in px, written by Place's blur bind. Applied by the element
   * renderer to vector/text content; raster elements ignore it for now, and
   * Flatten drops it (blur is a raster-space effect). */
  blur?: number;
}

export interface ElementsValue {
  kind: 'elements';
  items: Element[];
}

/**
 * A slot something can be placed into. Three channels ride on every slot,
 * each answering a different question:
 *  - `progress` — WHERE: 0→1 along the generator's natural traversal (fill
 *    order, arc length). Structural: generators write it, spread interpolates
 *    it, modulators never rewrite it — so a Filter survivor still knows where
 *    it sat on the original run.
 *  - `weight` — HOW MUCH: density/importance; 1 is neutral (uniform layouts
 *    emit all 1s). Generators emit honest defaults (Grid: cell area ratio);
 *    the Weight node is the deliberate author (noise/image/area/expression).
 *  - `index` — WHO: stable slot identity from birth; no node rewrites it.
 *    Place's by-index mode joins elements to it.
 * Beyond the built-ins, `channels` holds extra named signals authored by
 * Weight nodes — each channel is named after its Weight's source (noise,
 * image luma, area, …), so several independent weights can ride the same
 * slots: scale bound to `image luma`, rotation to `noise`. Consumers read
 * channels-first
 * (an authored channel shadows a built-in of the same name); an absent name
 * reads as neutral 1.
 */
export interface Placement {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  progress: number;
  weight: number;
  channels?: Record<string, number>;
  index: number;
  /** Cell extents — present when the layout partitions space (Grid), absent for
   * point layouts (SamplePath, Function, Random-generate). Cell-aware consumers
   * (Draw Layout, the artboard guide) draw the rect; everything else keeps
   * treating placements as points. */
  w?: number;
  h?: number;
}

/**
 * A slot signal, channels-first: an authored channel (named after its Weight
 * source) shadows a built-in of the same name; an unknown name reads as
 * neutral 1, so a dangling reference bends nothing instead of breaking.
 * The one read used by every channel consumer (Place binds, Filter threshold).
 */
export function readChannel(p: Placement, channel: string): number {
  const name = channel.trim();
  return p.channels?.[name]
    ?? (name === 'weight' ? p.weight : name === 'progress' ? p.progress : 1);
}

export interface LayoutValue {
  kind: 'layout';
  placements: Placement[];
  /** placements trace a closed loop (Sample Path on a ring, Function circle) —
   * lets Place's spread mode wrap evenly across the closing segment instead of
   * stopping at the last sample. Absent/false means an open run. Modulators
   * (Weight, Filter, Random-jitter) pass it through unchanged. */
  closed?: boolean;
}

export type Value = TextValue | VectorValue | RasterValue | AlphaValue | ElementsValue | LayoutValue;

export type OutputValues = Record<string, Value>;
