// The document graph — what the user edits and what gets serialized.
// Pure JSON-safe data: no textures, no functions, no GPU handles.

export type NodeId = string;
export type ParamValue = string | number | boolean;

export interface NodeInstance {
  id: NodeId;
  type: string; // keys into the registry
  params: Record<string, ParamValue>;
}

export interface Edge {
  from: { node: NodeId; socket: string }; // an output socket name
  to: { node: NodeId; socket: string }; // an input socket name
}

export interface Graph {
  nodes: Record<NodeId, NodeInstance>;
  edges: Edge[];
}
