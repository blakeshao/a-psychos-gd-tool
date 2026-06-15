// App state: the document graph is the single source of truth. The xyflow
// editor renders it and writes edits back through these actions; the
// evaluator only ever reads it.

import { create } from 'zustand';
import * as opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import {
  DEFAULT_FRAME,
  edgeKey,
  hasPath,
  type Frame,
  type Graph,
  type NodeId,
  type ParamValue,
} from './engine/graph';
import { canConnect } from './engine/registry';
import { registry } from './nodes';

// Local Font Access API (Chromium) — not in the default TS lib.
interface FontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}
declare global {
  interface Window {
    queryLocalFonts?: () => Promise<FontData[]>;
  }
}

// raw queryable font files, keyed by family — kept out of reactive state since
// FontData isn't serializable and is only needed to parse a font on demand
let localFontData = new Map<string, FontData>();
export function getLocalFontData(family: string): FontData | undefined {
  return localFontData.get(family);
}
export const localFontsSupported = typeof window !== 'undefined' && 'queryLocalFonts' in window;

const initialGraph: Graph = {
  frame: { ...DEFAULT_FRAME },
  nodes: {
    text1: { id: 'text1', type: 'Text', params: { content: 'PSYCHO', fontSize: 160, font: 'default' }, position: { x: 40, y: 80 } },
    outline1: { id: 'outline1', type: 'Outline', params: {}, position: { x: 240, y: 80 } },
    raster1: { id: 'raster1', type: 'Rasterize', params: {}, position: { x: 440, y: 80 } },
    blur1: { id: 'blur1', type: 'Blur', params: { radius: 8 }, position: { x: 640, y: 80 } },
    out: { id: 'out', type: 'Output', params: { background: '#ffffff' }, position: { x: 840, y: 80 } },
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
  /** parsed fonts ready to cook, keyed by font key ('default' + local families) */
  fonts: Record<string, Font>;
  /** family names of the user's local fonts, available to load on demand */
  localFonts: string[];
  select: (id: NodeId | null) => void;
  setFrame: (frame: Frame) => void;
  setParam: (nodeId: NodeId, name: string, value: ParamValue) => void;
  moveNode: (nodeId: NodeId, position: { x: number; y: number }) => void;
  addNode: (type: string, position: { x: number; y: number }) => void;
  removeNodes: (ids: NodeId[]) => void;
  connect: (w: WireSpec) => void;
  removeEdges: (edgeKeys: string[]) => void;
  addFont: (key: string, font: Font) => void;
  /** parse a queryable local font (by family) into the cookable fonts map */
  loadLocalFont: (family: string) => Promise<void>;
  /** prompt for local font access and list the available families */
  loadLocalFonts: () => Promise<void>;
}

let nextId = 1;

export const useApp = create<AppStore>((set, get) => ({
  graph: initialGraph,
  selectedNodeId: null,
  fonts: {},
  localFonts: [],

  select: (id) => set({ selectedNodeId: id }),

  setFrame: (frame) =>
    set((s) => ({
      graph: {
        ...s.graph,
        frame: {
          width: Math.max(16, Math.min(4096, Math.round(frame.width) || DEFAULT_FRAME.width)),
          height: Math.max(16, Math.min(4096, Math.round(frame.height) || DEFAULT_FRAME.height)),
        },
      },
    })),

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
        graph: { ...s.graph, nodes, edges },
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

  addFont: (key, font) => set((s) => ({ fonts: { ...s.fonts, [key]: font } })),

  loadLocalFont: async (family) => {
    if (get().fonts[family]) return;
    const fd = localFontData.get(family);
    if (!fd) return;
    const font = opentype.parse(await (await fd.blob()).arrayBuffer());
    set((s) => ({ fonts: { ...s.fonts, [family]: font } }));
  },

  loadLocalFonts: async () => {
    if (!window.queryLocalFonts) return;
    const data = await window.queryLocalFonts();
    const map = new Map<string, FontData>();
    for (const fd of data) if (!map.has(fd.family)) map.set(fd.family, fd);
    localFontData = map;
    set({ localFonts: [...map.keys()].sort((a, b) => a.localeCompare(b)) });
  },
}));

// dev/verify handle — scripts/verify.mjs builds graphs through this
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__app = useApp;
}
