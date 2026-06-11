import type { Registry } from '../engine/registry';
import { BlurNode } from './blur';
import { OutlineNode } from './outline';
import { OutputNode } from './output';
import { RasterizeNode } from './rasterize';
import { TextNode } from './text';

export function buildRegistry(): Registry {
  const registry: Registry = new Map();
  for (const def of [TextNode, OutlineNode, RasterizeNode, BlurNode, OutputNode]) {
    registry.set(def.type, def);
  }
  return registry;
}

/** The app-wide registry singleton. Tests build their own via buildRegistry/stubs. */
export const registry = buildRegistry();
