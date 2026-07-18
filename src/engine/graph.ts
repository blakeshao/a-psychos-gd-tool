// The document graph — what the user edits and what gets serialized.
// Pure JSON-safe data: no textures, no functions, no GPU handles.

export type NodeId = string;
export type ParamValue = string | number | boolean;

export interface NodeInstance {
  id: NodeId;
  type: string; // keys into the registry
  params: Record<string, ParamValue>;
  /** editor canvas position — excluded from content hashing, so moving a node never re-cooks */
  position?: { x: number; y: number };
}

export interface Edge {
  from: { node: NodeId; socket: string }; // an output socket name
  to: { node: NodeId; socket: string }; // an input socket name
}

export interface Frame {
  width: number;
  height: number;
}

export const DEFAULT_FRAME: Frame = { width: 2304, height: 3456 };

export interface Graph {
  nodes: Record<NodeId, NodeInstance>;
  edges: Edge[];
  /** the artboard/canvas size — every frame-aware operator (Rasterize, Noise, Output) cooks at this */
  frame?: Frame;
}

/**
 * How a layer's pixels combine with everything below it. Grouped the way
 * layer panels traditionally do; the flat BLEND_MODES order is the shader's
 * mode index, so entries must never be reordered — only appended.
 */
export const BLEND_MODE_GROUPS: { group: string; modes: string[] }[] = [
  { group: 'normal', modes: ['normal'] },
  { group: 'darken', modes: ['darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color'] },
  { group: 'lighten', modes: ['lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color'] },
  { group: 'contrast', modes: ['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix'] },
  { group: 'comparative', modes: ['difference', 'exclusion', 'subtract', 'divide'] },
  { group: 'component', modes: ['hue', 'saturation', 'color', 'luminosity'] },
];

export const BLEND_MODES = BLEND_MODE_GROUPS.flatMap((g) => g.modes);

export type BlendMode = (typeof BLEND_MODES)[number];

/** A layer: one full node graph plus how its result composites into the stack. */
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 — multiplies the layer's own alpha at composite time */
  opacity: number;
  blendMode: BlendMode;
  graph: Graph;
}

/** The document: an ordered stack of layers over one frame. Index 0 is the
 * bottom layer; painting walks the array in order. */
export interface Doc {
  frame: Frame;
  layers: Layer[];
}

/** Is `to` reachable downstream of `from`? Used to reject wires that would create a cycle. */
export function hasPath(graph: Graph, from: NodeId, to: NodeId): boolean {
  if (from === to) return true;
  const queue = [from];
  const seen = new Set<NodeId>([from]);
  while (queue.length) {
    const id = queue.pop()!;
    for (const e of graph.edges) {
      if (e.from.node !== id || seen.has(e.to.node)) continue;
      if (e.to.node === to) return true;
      seen.add(e.to.node);
      queue.push(e.to.node);
    }
  }
  return false;
}

export function edgeKey(e: Edge): string {
  return `${e.from.node}.${e.from.socket}->${e.to.node}.${e.to.socket}`;
}
