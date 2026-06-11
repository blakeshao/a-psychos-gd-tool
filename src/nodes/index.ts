import type { Registry } from '../engine/registry';
import { BlurNode } from './blur';
import { BooleanNode } from './boolean';
import { DuplicatorNode, FlattenNode, PlaceNode, SplitNode } from './elements';
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
import { DisplaceNode, WarpNode } from './vectorOps';

export function buildRegistry(): Registry {
  const registry: Registry = new Map();
  for (const def of [
    TextNode, ShapeNode, NoiseNode,
    OutlineNode, RasterizeNode, TraceNode,
    DisplaceNode, WarpNode, BooleanNode,
    SplitNode, DuplicatorNode, PlaceNode, FlattenNode,
    GridNode, RandomLayoutNode, SamplePathNode, FunctionLayoutNode,
    FilterLayoutNode, SortLayoutNode, DrawLayoutNode,
    BlurNode, DitherNode, RecolorNode, ChromaKeyNode, AsciiNode,
    ToAlphaNode, CompositeNode,
    OutputNode,
  ]) {
    registry.set(def.type, def);
  }
  return registry;
}

/** The app-wide registry singleton. Tests build their own via buildRegistry/stubs. */
export const registry = buildRegistry();
