import type { Registry } from '../engine/registry';
import { BlurNode } from './blur';
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
import { TextNode } from './text';

export function buildRegistry(): Registry {
  const registry: Registry = new Map();
  for (const def of [
    TextNode, NoiseNode,
    OutlineNode, RasterizeNode,
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
