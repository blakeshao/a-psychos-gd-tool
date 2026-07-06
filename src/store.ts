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
import { extractFace, faceCount } from './util/sfnt';

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
// families whose font file failed to parse — remembered so re-cooks don't
// refetch and refail the same file on every graph edit
const failedFonts = new Set<string>();
export function getLocalFontData(family: string): FontData | undefined {
  return localFontData.get(family);
}
export const localFontsSupported = typeof window !== 'undefined' && 'queryLocalFonts' in window;

/** Load local fonts at startup when access was granted in a previous session.
 * queryLocalFonts only needs a user gesture for the initial permission prompt,
 * so once granted the list can be rebuilt silently on every launch. */
export async function loadLocalFontsIfGranted(): Promise<void> {
  if (!localFontsSupported) return;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    if (status.state !== 'granted') return;
    await useApp.getState().loadLocalFonts();
  } catch {
    // permission not queryable or access revoked mid-flight — the font
    // picker's ⤓ button still prompts on demand
  }
}

const factoryGraph: Graph = {
  frame: { width: 2304, height: 3456 },
  nodes: {
    text1: {
      id: 'text1',
      type: 'Text',
      params: {
        content: 'PSYCHO', fontSize: 400, font: 'default', fill: '#ffffff', weight: 400,
        stroke: true, strokeColor: '#00b395', strokeWidth: 45, strokeAlign: 'outside',
      },
      position: { x: -131, y: 68 },
    },
    outline1: { id: 'outline1', type: 'Outline', params: {}, position: { x: 124, y: 74 } },
    displace_3: { id: 'displace_3', type: 'Displace', params: { amount: 31.5, scale: 357, seed: 0 }, position: { x: 374, y: 58 } },
    raster1: { id: 'raster1', type: 'Rasterize', params: {}, position: { x: 636, y: 73 } },
    blur1: { id: 'blur1', type: 'Blur', params: { radius: 0 }, position: { x: 891, y: 45 } },
    duplicator_1: { id: 'duplicator_1', type: 'Duplicator', params: { count: 499 }, position: { x: 1179, y: 78 } },
    grid_3: {
      id: 'grid_3',
      type: 'Grid',
      params: {
        columns: 63, rows: 4, gapX: 0, gapY: 0,
        padding: 'x/y', padX: 370, padY: 217, padTop: 48, padRight: 48, padBottom: 48, padLeft: 48,
        distX: 'golden', distY: 'golden', ratioX: 1.618, ratioY: 1.618,
        weightsX: '1,1,2,3,5', weightsY: '1,1,2,3,5', exprX: '', exprY: '1 + sin(t*pi)',
        reverseX: 'yes', reverseY: 'yes', stagger: 'none', flow: 'rows',
      },
      position: { x: 828, y: 288 },
    },
    weight_4: { id: 'weight_4', type: 'Weight', params: { source: 'area', seed: 1, expr: '1 - progress' }, position: { x: 1147, y: 249 } },
    place_4: {
      id: 'place_4',
      type: 'Place',
      params: {
        distribute: 'spread', offsetX: 167, offsetY: -20, order: 'source', reverse: 'yes', seed: 0,
        binds: '[{"channel":"area","target":"scale","amount":0.88,"invert":false,"offset":0},{"channel":"area","target":"rotation","amount":1,"invert":false,"offset":-0.34}]',
      },
      position: { x: 1438, y: 127 },
    },
    out: { id: 'out', type: 'Output', params: { background: '#7300a8' }, position: { x: 1794, y: 290 } },
  },
  edges: [
    { from: { node: 'text1', socket: 'out' }, to: { node: 'outline1', socket: 'text' } },
    { from: { node: 'outline1', socket: 'out' }, to: { node: 'displace_3', socket: 'in' } },
    { from: { node: 'displace_3', socket: 'out' }, to: { node: 'raster1', socket: 'vector' } },
    { from: { node: 'raster1', socket: 'out' }, to: { node: 'blur1', socket: 'in' } },
    { from: { node: 'blur1', socket: 'out' }, to: { node: 'duplicator_1', socket: 'in' } },
    { from: { node: 'grid_3', socket: 'out' }, to: { node: 'weight_4', socket: 'layout' } },
    { from: { node: 'duplicator_1', socket: 'out' }, to: { node: 'place_4', socket: 'elements' } },
    { from: { node: 'weight_4', socket: 'out' }, to: { node: 'place_4', socket: 'layout' } },
    { from: { node: 'place_4', socket: 'out' }, to: { node: 'out', socket: 'in' } },
  ],
};

// The working document persists to localStorage on every graph edit, so the
// current set-up IS the default on next load. The factory graph is only the
// first-run (or unreadable-save) fallback.
const STORAGE_KEY = 'gfx.document.v1';
const canPersist = typeof localStorage !== 'undefined';

function loadSavedGraph(): Graph | null {
  if (!canPersist) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as Graph;
    if (!g || typeof g !== 'object' || !g.nodes || !Array.isArray(g.edges)) return null;
    // a save referencing node types this build no longer ships can't cook
    for (const n of Object.values(g.nodes)) if (!registry.get(n.type)) return null;
    return g;
  } catch {
    return null;
  }
}

const initialGraph: Graph = loadSavedGraph() ?? factoryGraph;

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
    if (get().fonts[family] || failedFonts.has(family)) return;
    const fd = localFontData.get(family);
    if (!fd) return;
    try {
      // many macOS families ship as .ttc collections — pick the face whose
      // postscript name matches the queried one, else the first that parses
      const buf = await (await fd.blob()).arrayBuffer();
      let font: Font | null = null;
      for (let i = 0; i < faceCount(buf); i++) {
        try {
          const face = opentype.parse(extractFace(buf, i));
          font ??= face;
          const names = face.names.postScriptName ?? {};
          if (Object.values(names).includes(fd.postscriptName)) {
            font = face;
            break;
          }
        } catch {
          // a broken face shouldn't sink the whole collection
        }
      }
      if (!font) throw new Error('no parseable face in font file');
      set((s) => ({ fonts: { ...s.fonts, [family]: font as Font } }));
    } catch (err) {
      failedFonts.add(family);
      console.error(`local font "${family}" failed to load:`, err);
    }
  },

  loadLocalFonts: async () => {
    if (!window.queryLocalFonts) return;
    const data = await window.queryLocalFonts();
    const map = new Map<string, FontData>();
    // one entry per family; the Regular style wins over whichever came first
    for (const fd of data) {
      const cur = map.get(fd.family);
      if (!cur || (cur.style !== 'Regular' && fd.style === 'Regular')) map.set(fd.family, fd);
    }
    localFontData = map;
    set({ localFonts: [...map.keys()].sort((a, b) => a.localeCompare(b)) });
  },
}));

if (canPersist) {
  useApp.subscribe((s, prev) => {
    if (s.graph === prev.graph) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s.graph));
    } catch {
      // quota/private-mode failures shouldn't break editing
    }
  });
}

// dev/verify handle — scripts/verify.mjs builds graphs through this
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__app = useApp;
}
