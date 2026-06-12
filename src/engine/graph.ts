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

export const DEFAULT_FRAME: Frame = { width: 768, height: 512 };

export interface Graph {
  nodes: Record<NodeId, NodeInstance>;
  edges: Edge[];
  /** the artboard/canvas size — every frame-aware operator (Rasterize, Noise, Output) cooks at this */
  frame?: Frame;
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
