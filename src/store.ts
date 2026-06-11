// App state: the document graph is the single source of truth. The xyflow
// editor renders it and writes edits back through these actions; the
// evaluator only ever reads it.

import { create } from 'zustand';
import { edgeKey, hasPath, type Graph, type NodeId, type ParamValue } from './engine/graph';
import { canConnect } from './engine/registry';
import { registry } from './nodes';

const initialGraph: Graph = {
  nodes: {
    text1: { id: 'text1', type: 'Text', params: { content: 'PSYCHO', fontSize: 160, font: 'default' }, position: { x: 30, y: 80 } },
    outline1: { id: 'outline1', type: 'Outline', params: {}, position: { x: 230, y: 80 } },
    raster1: { id: 'raster1', type: 'Rasterize', params: { width: 768, height: 512 }, position: { x: 420, y: 80 } },
    blur1: { id: 'blur1', type: 'Blur', params: { radius: 8 }, position: { x: 620, y: 80 } },
    out: { id: 'out', type: 'Output', params: {}, position: { x: 800, y: 80 } },
  },
  edges: [
    { from: { node: 'text1', socket: 'out' }, to: { node: 'outline1', socket: 'text' } },
    { from: { node: 'outline1', socket: 'out' }, to: { node: 'raster1', socket: 'vector' } },
    { from: { node: 'raster1', socket: 'out' }, to: { node: 'blur1', socket: 'in' } },
    { from: { node: 'blur1', socket: 'out' }, to: { node: 'out', socket: 'in' } },
  ],
};

export interface WireSpec {
  source: NodeId;
  sourceHandle: string;
  target: NodeId;
  targetHandle: string;
}

/** Type equality + acyclicity. Pure — used both for live drag feedback and on connect. */
export function wireIsValid(graph: Graph, w: WireSpec): boolean {
  const fromNode = graph.nodes[w.source];
  const toNode = graph.nodes[w.target];
  if (!fromNode || !toNode) return false;
  const fromSpec = registry.get(fromNode.type)?.outputs.find((s) => s.name === w.sourceHandle);
  const toSpec = registry.get(toNode.type)?.inputs.find((s) => s.name === w.targetHandle);
  if (!fromSpec || !toSpec) return false;
  if (!canConnect(fromSpec, toSpec)) return false; // never coerced (unions are membership, not coercion)
  return !hasPath(graph, w.target, w.source); // no cycles
}

interface AppStore {
  graph: Graph;
  selectedNodeId: NodeId | null;
  select: (id: NodeId | null) => void;
  setParam: (nodeId: NodeId, name: string, value: ParamValue) => void;
  moveNode: (nodeId: NodeId, position: { x: number; y: number }) => void;
  addNode: (type: string, position: { x: number; y: number }) => void;
  removeNodes: (ids: NodeId[]) => void;
  connect: (w: WireSpec) => void;
  removeEdges: (edgeKeys: string[]) => void;
}

let nextId = 1;

export const useApp = create<AppStore>((set) => ({
  graph: initialGraph,
  selectedNodeId: null,

  select: (id) => set({ selectedNodeId: id }),

  setParam: (nodeId, name, value) =>
    set((s) => ({
      graph: {
        ...s.graph,
        nodes: {
          ...s.graph.nodes,
          [nodeId]: { ...s.graph.nodes[nodeId], params: { ...s.graph.nodes[nodeId].params, [name]: value } },
        },
      },
    })),

  moveNode: (nodeId, position) =>
    set((s) => ({
      graph: { ...s.graph, nodes: { ...s.graph.nodes, [nodeId]: { ...s.graph.nodes[nodeId], position } } },
    })),

  addNode: (type, position) =>
    set((s) => {
      const def = registry.get(type);
      if (!def) return s;
      let id = `${type.toLowerCase()}_${nextId++}`;
      while (s.graph.nodes[id]) id = `${type.toLowerCase()}_${nextId++}`;
      const params = Object.fromEntries(def.params.map((p) => [p.name, p.default]));
      return {
        graph: { ...s.graph, nodes: { ...s.graph.nodes, [id]: { id, type, params, position } } },
        selectedNodeId: id,
      };
    }),

  removeNodes: (ids) =>
    set((s) => {
      const drop = new Set(ids);
      const nodes = Object.fromEntries(Object.entries(s.graph.nodes).filter(([id]) => !drop.has(id)));
      const edges = s.graph.edges.filter((e) => !drop.has(e.from.node) && !drop.has(e.to.node));
      return {
        graph: { nodes, edges },
        selectedNodeId: s.selectedNodeId && drop.has(s.selectedNodeId) ? null : s.selectedNodeId,
      };
    }),

  connect: (w) =>
    set((s) => {
      if (!wireIsValid(s.graph, w)) return s;
      // an input socket holds one wire — a new connection replaces the old one
      const edges = s.graph.edges.filter(
        (e) => !(e.to.node === w.target && e.to.socket === w.targetHandle),
      );
      edges.push({
        from: { node: w.source, socket: w.sourceHandle },
        to: { node: w.target, socket: w.targetHandle },
      });
      return { graph: { ...s.graph, edges } };
    }),

  removeEdges: (keys) =>
    set((s) => {
      const drop = new Set(keys);
      return { graph: { ...s.graph, edges: s.graph.edges.filter((e) => !drop.has(edgeKey(e))) } };
    }),
}));

// dev/verify handle — scripts/verify.mjs builds graphs through this
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__app = useApp;
}
