import type { NodeDef, Registry } from '../engine/registry';
import { BlurNode } from './blur';
import { BooleanNode } from './boolean';
import { DuplicatorNode, FlattenNode, PlaceNode, SplitNode } from './elements';
import { ImageNode } from './image';
import {
  DrawLayoutNode,
  FilterLayoutNode,
  FunctionLayoutNode,
  GridNode,
  RandomLayoutNode,
  SamplePathNode,
  SortLayoutNode,
} from './layout';
import { NoiseNode } from './noise';
import { OutlineNode } from './outline';
import { OutputNode } from './output';
import { RasterizeNode } from './rasterize';
import {
  AsciiNode,
  ChromaKeyNode,
  CompositeNode,
  DitherNode,
  RecolorNode,
  ToAlphaNode,
} from './rasterOps';
import { ShapeNode } from './shape';
import { TextNode } from './text';
import { TraceNode } from './trace';
import { OutlineImageNode } from './outlineImage';
import { RemoveBackgroundNode } from './removeBackground';
import { DisplaceNode, WarpNode } from './vectorOps';

/** A palette section: a category heading and the nodes filed under it. */
export interface NodeCategory {
  category: string;
  nodes: NodeDef[];
}

/**
 * The node palette, grouped and ordered as proposed. This is the single source
 * of truth for what nodes exist — the registry is derived from it, and the
 * editor palette renders these sections in order. Categories whose nodes aren't
 * built yet (Fit to Box, Slice, Extraction, Alpha Map, Align/Distribute) are
 * intentionally absent until their nodes land.
 */
export const PALETTE: NodeCategory[] = [
  { category: 'Assets', nodes: [TextNode, ShapeNode, ImageNode, NoiseNode] },
  { category: 'Text ops', nodes: [SplitNode] },
  { category: 'Vector ops', nodes: [DisplaceNode, WarpNode, BooleanNode] },
  { category: 'Raster ops', nodes: [BlurNode, DitherNode, AsciiNode, RecolorNode, ChromaKeyNode] },
  {
    category: 'Layout',
    nodes: [GridNode, SamplePathNode, FunctionLayoutNode, RandomLayoutNode, FilterLayoutNode, SortLayoutNode],
  },
  { category: 'Placement', nodes: [DuplicatorNode, PlaceNode] },
  // Flatten is Conversion's elements => vector step down the type ladder.
  {
    category: 'Conversion',
    nodes: [OutlineNode, RasterizeNode, TraceNode, RemoveBackgroundNode, OutlineImageNode, ToAlphaNode, DrawLayoutNode, FlattenNode],
  },
  { category: 'Composition', nodes: [CompositeNode] },
  { category: 'Output', nodes: [OutputNode] },
];

export function buildRegistry(): Registry {
  const registry: Registry = new Map();
  for (const { nodes } of PALETTE) {
    for (const def of nodes) registry.set(def.type, def);
  }
  return registry;
}

/** The app-wide registry singleton. Tests build their own via buildRegistry/stubs. */
export const registry = buildRegistry();
