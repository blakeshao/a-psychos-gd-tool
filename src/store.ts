// App state: the document — an ordered stack of layers, each one a full node
// graph — is the single source of truth. The xyflow editor renders the active
// layer's graph and writes edits back through these actions; the evaluator
// only ever reads it.

import { create } from 'zustand';
import * as opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import {
  BLEND_MODES,
  DEFAULT_FRAME,
  edgeKey,
  hasPath,
  type Doc,
  type Frame,
  type Graph,
  type Layer,
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

function makeLayer(id: string, name: string, graph: Graph): Layer {
  return { id, name, visible: true, opacity: 1, blendMode: 'normal', graph };
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

// The working document persists to localStorage on every edit, so the current
// set-up IS the default on next load. The factory graph is only the first-run
// (or unreadable-save) fallback. v1 saves held a single graph — they load as
// a one-layer document; v1 is left in place so older builds can still read it.
const STORAGE_KEY = 'gfx.document.v2';
const LEGACY_STORAGE_KEY = 'gfx.document.v1';
const canPersist = typeof localStorage !== 'undefined';

function validGraph(g: Graph | null | undefined): g is Graph {
  if (!g || typeof g !== 'object' || !g.nodes || !Array.isArray(g.edges)) return false;
  // a save referencing node types this build no longer ships can't cook
  for (const n of Object.values(g.nodes)) if (!registry.get(n.type)) return false;
  return true;
}

function loadSavedDoc(): Doc | null {
  if (!canPersist) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Doc;
      if (!d || typeof d !== 'object' || !Array.isArray(d.layers) || d.layers.length === 0) return null;
      const layers: Layer[] = [];
      for (const l of d.layers) {
        if (!l || typeof l.id !== 'string' || !validGraph(l.graph)) return null;
        layers.push({
          id: l.id,
          name: typeof l.name === 'string' ? l.name : `Layer ${layers.length + 1}`,
          visible: l.visible !== false,
          opacity: Math.max(0, Math.min(1, Number(l.opacity ?? 1))),
          blendMode: BLEND_MODES.includes(l.blendMode) ? l.blendMode : 'normal',
          graph: l.graph,
        });
      }
      return { frame: d.frame ?? DEFAULT_FRAME, layers };
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const g = JSON.parse(legacy) as Graph;
      if (!validGraph(g)) return null;
      return { frame: g.frame ?? DEFAULT_FRAME, layers: [makeLayer('layer_1', 'Layer 1', { nodes: g.nodes, edges: g.edges })] };
    }
    return null;
  } catch {
    return null;
  }
}

const initialDoc: Doc = loadSavedDoc() ?? {
  frame: factoryGraph.frame ?? DEFAULT_FRAME,
  layers: [makeLayer('layer_1', 'Layer 1', factoryGraph)],
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

// Undo history: whole-graph snapshots. Graph edits are immutable updates that
// share structure, so a snapshot is one object reference — cheap to keep.
// Continuous edits (a param scrub, a node drag, typing in a field) coalesce
// into one undo step: repeats of the same edit key inside the window ride on
// the snapshot already pushed.
const HISTORY_LIMIT = 100;
const COALESCE_MS = 1000;
let lastEdit: { key: string; time: number } | null = null;

/** Close the current coalescing run — the next edit starts a fresh undo step.
 * Called on gesture boundaries (pointer-up on a number scrub). */
export function endGesture(): void {
  lastEdit = null;
}

interface AppStore {
  doc: Doc;
  /** the layer whose graph the node editor shows and edits — always a live id */
  activeLayerId: string;
  selectedNodeId: NodeId | null;
  /** undo/redo stacks of document snapshots — selection and fonts stay out of history */
  past: Doc[];
  future: Doc[];
  undo: () => void;
  redo: () => void;
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
  selectLayer: (id: string) => void;
  /** insert a fresh layer (transparent Output, empty otherwise) above the active one */
  addLayer: () => void;
  /** refuses to remove the last layer — the document always has one */
  removeLayer: (id: string) => void;
  /** +1 raises the layer in the stack, -1 lowers it; no-op at the ends */
  moveLayer: (id: string, dir: 1 | -1) => void;
  /** drag-and-drop reorder: place a layer at an absolute stack index (0 = bottom) */
  moveLayerTo: (id: string, to: number) => void;
  updateLayer: (id: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'opacity' | 'blendMode'>>) => void;
  addFont: (key: string, font: Font) => void;
  /** parse a queryable local font (by family) into the cookable fonts map */
  loadLocalFont: (family: string) => Promise<void>;
  /** prompt for local font access and list the available families */
  loadLocalFonts: () => Promise<void>;
}

/** The graph the node editor is looking at — the active layer's. */
export function selectActiveGraph(s: Pick<AppStore, 'doc' | 'activeLayerId'>): Graph {
  return (s.doc.layers.find((l) => l.id === s.activeLayerId) ?? s.doc.layers[s.doc.layers.length - 1]).graph;
}

/** An immutable update of the active layer's graph, leaving the other layers shared. */
function editActiveGraph(s: AppStore, fn: (g: Graph) => Graph): Doc {
  return {
    ...s.doc,
    layers: s.doc.layers.map((l) => (l.id === s.activeLayerId ? { ...l, graph: fn(l.graph) } : l)),
  };
}

/** After swapping in a document (undo/redo), keep active layer + selection pointing at things that exist. */
function revalidate(s: AppStore, doc: Doc): Pick<AppStore, 'activeLayerId' | 'selectedNodeId'> {
  const layer = doc.layers.find((l) => l.id === s.activeLayerId) ?? doc.layers[doc.layers.length - 1];
  return {
    activeLayerId: layer.id,
    selectedNodeId: s.selectedNodeId && layer.graph.nodes[s.selectedNodeId] ? s.selectedNodeId : null,
  };
}

let nextId = 1;
let nextLayerId = 2;

/** The history push that precedes a document edit. A `key` marks the edit as
 * continuous: repeats inside the coalescing window reuse the snapshot already
 * pushed. Discrete edits pass null and always snapshot. */
function pushHistory(s: AppStore, key: string | null): Pick<AppStore, 'past' | 'future'> | undefined {
  const now = Date.now();
  if (key && lastEdit && lastEdit.key === key && now - lastEdit.time < COALESCE_MS) {
    lastEdit.time = now;
    return undefined;
  }
  lastEdit = key ? { key, time: now } : null;
  return { past: [...s.past.slice(1 - HISTORY_LIMIT), s.doc], future: [] };
}

export const useApp = create<AppStore>((set, get) => ({
  doc: initialDoc,
  activeLayerId: initialDoc.layers[initialDoc.layers.length - 1].id,
  selectedNodeId: null,
  past: [],
  future: [],
  fonts: {},
  localFonts: [],

  select: (id) => set({ selectedNodeId: id }),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      endGesture();
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, s.doc],
        doc: prev,
        ...revalidate(s, prev),
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[s.future.length - 1];
      if (!next) return s;
      endGesture();
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, s.doc],
        doc: next,
        ...revalidate(s, next),
      };
    }),

  setFrame: (frame) =>
    set((s) => ({
      ...pushHistory(s, 'frame'),
      doc: {
        ...s.doc,
        frame: {
          width: Math.max(16, Math.min(4096, Math.round(frame.width) || DEFAULT_FRAME.width)),
          height: Math.max(16, Math.min(4096, Math.round(frame.height) || DEFAULT_FRAME.height)),
        },
      },
    })),

  setParam: (nodeId, name, value) =>
    set((s) => ({
      ...pushHistory(s, `param:${s.activeLayerId}:${nodeId}:${name}`),
      doc: editActiveGraph(s, (g) => ({
        ...g,
        nodes: { ...g.nodes, [nodeId]: { ...g.nodes[nodeId], params: { ...g.nodes[nodeId].params, [name]: value } } },
      })),
    })),

  moveNode: (nodeId, position) =>
    set((s) => ({
      ...pushHistory(s, `move:${s.activeLayerId}:${nodeId}`),
      doc: editActiveGraph(s, (g) => ({ ...g, nodes: { ...g.nodes, [nodeId]: { ...g.nodes[nodeId], position } } })),
    })),

  addNode: (type, position) =>
    set((s) => {
      const def = registry.get(type);
      if (!def) return s;
      const graph = selectActiveGraph(s);
      let id = `${type.toLowerCase()}_${nextId++}`;
      while (graph.nodes[id]) id = `${type.toLowerCase()}_${nextId++}`;
      const params = Object.fromEntries(def.params.map((p) => [p.name, p.default]));
      return {
        ...pushHistory(s, null),
        doc: editActiveGraph(s, (g) => ({ ...g, nodes: { ...g.nodes, [id]: { id, type, params, position } } })),
        selectedNodeId: id,
      };
    }),

  removeNodes: (ids) =>
    set((s) => {
      const drop = new Set(ids);
      return {
        ...pushHistory(s, null),
        doc: editActiveGraph(s, (g) => ({
          ...g,
          nodes: Object.fromEntries(Object.entries(g.nodes).filter(([id]) => !drop.has(id))),
          edges: g.edges.filter((e) => !drop.has(e.from.node) && !drop.has(e.to.node)),
        })),
        selectedNodeId: s.selectedNodeId && drop.has(s.selectedNodeId) ? null : s.selectedNodeId,
      };
    }),

  connect: (w) =>
    set((s) => {
      if (!wireIsValid(selectActiveGraph(s), w)) return s;
      return {
        ...pushHistory(s, null),
        doc: editActiveGraph(s, (g) => ({
          ...g,
          // an input socket holds one wire — a new connection replaces the old one
          edges: [
            ...g.edges.filter((e) => !(e.to.node === w.target && e.to.socket === w.targetHandle)),
            { from: { node: w.source, socket: w.sourceHandle }, to: { node: w.target, socket: w.targetHandle } },
          ],
        })),
      };
    }),

  removeEdges: (keys) =>
    set((s) => {
      const drop = new Set(keys);
      return {
        ...pushHistory(s, null),
        doc: editActiveGraph(s, (g) => ({ ...g, edges: g.edges.filter((e) => !drop.has(edgeKey(e))) })),
      };
    }),

  selectLayer: (id) =>
    set((s) => {
      if (s.activeLayerId === id || !s.doc.layers.some((l) => l.id === id)) return s;
      // switching layers is a view change, not a document edit — no history
      return { activeLayerId: id, selectedNodeId: null };
    }),

  addLayer: () =>
    set((s) => {
      let id = `layer_${nextLayerId++}`;
      while (s.doc.layers.some((l) => l.id === id)) id = `layer_${nextLayerId++}`;
      // a fresh layer starts as a transparent Output so the stack shows through
      const graph: Graph = {
        nodes: { out: { id: 'out', type: 'Output', params: { transparent: true }, position: { x: 480, y: 120 } } },
        edges: [],
      };
      const layer = makeLayer(id, `Layer ${s.doc.layers.length + 1}`, graph);
      const at = s.doc.layers.findIndex((l) => l.id === s.activeLayerId) + 1;
      const layers = [...s.doc.layers.slice(0, at), layer, ...s.doc.layers.slice(at)];
      return {
        ...pushHistory(s, null),
        doc: { ...s.doc, layers },
        activeLayerId: id,
        selectedNodeId: null,
      };
    }),

  removeLayer: (id) =>
    set((s) => {
      if (s.doc.layers.length <= 1) return s;
      const at = s.doc.layers.findIndex((l) => l.id === id);
      if (at === -1) return s;
      const layers = s.doc.layers.filter((l) => l.id !== id);
      const active = s.activeLayerId === id ? layers[Math.min(at, layers.length - 1)].id : s.activeLayerId;
      return {
        ...pushHistory(s, null),
        doc: { ...s.doc, layers },
        activeLayerId: active,
        selectedNodeId: s.activeLayerId === id ? null : s.selectedNodeId,
      };
    }),

  moveLayer: (id, dir) =>
    set((s) => {
      const at = s.doc.layers.findIndex((l) => l.id === id);
      const to = at + dir;
      if (at === -1 || to < 0 || to >= s.doc.layers.length) return s;
      const layers = [...s.doc.layers];
      [layers[at], layers[to]] = [layers[to], layers[at]];
      return { ...pushHistory(s, null), doc: { ...s.doc, layers } };
    }),

  moveLayerTo: (id, to) =>
    set((s) => {
      const at = s.doc.layers.findIndex((l) => l.id === id);
      if (at === -1) return s;
      const clamped = Math.max(0, Math.min(s.doc.layers.length - 1, to));
      if (clamped === at) return s;
      const layers = [...s.doc.layers];
      const [layer] = layers.splice(at, 1);
      layers.splice(clamped, 0, layer);
      return { ...pushHistory(s, null), doc: { ...s.doc, layers } };
    }),

  updateLayer: (id, patch) =>
    set((s) => {
      if (!s.doc.layers.some((l) => l.id === id)) return s;
      // opacity scrubs and name typing coalesce into one undo step each
      const key = 'opacity' in patch ? `layer:${id}:opacity` : 'name' in patch ? `layer:${id}:name` : null;
      return {
        ...pushHistory(s, key),
        doc: { ...s.doc, layers: s.doc.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) },
      };
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
    if (s.doc === prev.doc) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s.doc));
    } catch {
      // quota/private-mode failures shouldn't break editing
    }
  });
}

// dev/verify handle — scripts/verify.mjs builds graphs through this
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__app = useApp;
}
