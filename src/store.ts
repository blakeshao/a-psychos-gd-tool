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
  type Edge,
  type Frame,
  type Graph,
  type Layer,
  type NodeId,
  type NodeInstance,
  type ParamValue,
} from './engine/graph';
import { canConnect } from './engine/registry';
import { factoryDoc } from './factoryDoc';
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

// The working document persists to localStorage on every edit, so the current
// set-up IS the default on next load. The factory document is only the first-run
// (or unreadable-save) fallback. v1 saves held a single graph — they load as
// a one-layer document; v1 is left in place so older builds can still read it.
const STORAGE_KEY = 'gfx.document.v2';
const LEGACY_STORAGE_KEY = 'gfx.document.v1';
const canPersist = typeof localStorage !== 'undefined';

/**
 * Random used to be two nodes in one: a generator with nothing wired, a jitter
 * modulator with a layout wired in. The halves are separate node types now, so
 * a save from before the split has Random nodes whose meaning lived in an edge.
 * Retype those, in place: the param names carried over unchanged, and Jitter
 * takes the same mask, so the wiring and the look survive. Without this the
 * node would quietly fall back to generating a scatter and the layout it was
 * jittering would go missing.
 */
export function migrateJitter(g: Graph): Graph {
  const jittering = new Set(
    g.edges.filter((e) => e.to.socket === 'layout' && g.nodes[e.to.node]?.type === 'Random')
      .map((e) => e.to.node),
  );
  if (jittering.size === 0) return g;
  const nodes = { ...g.nodes };
  for (const id of jittering) nodes[id] = { ...nodes[id], type: 'Jitter' };
  return { ...g, nodes };
}

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
          graph: migrateJitter(l.graph),
        });
      }
      return { frame: d.frame ?? DEFAULT_FRAME, layers };
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const g = JSON.parse(legacy) as Graph;
      if (!validGraph(g)) return null;
      const migrated = migrateJitter(g);
      return { frame: g.frame ?? DEFAULT_FRAME, layers: [makeLayer('layer_1', 'Layer 1', { nodes: migrated.nodes, edges: migrated.edges })] };
    }
    return null;
  } catch {
    return null;
  }
}

const initialDoc: Doc = loadSavedDoc() ?? factoryDoc;

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
  /** the selected nodes, in selection order — one entry for a plain click, many for a marquee */
  selectedNodeIds: NodeId[];
  /** undo/redo stacks of document snapshots — selection and fonts stay out of history */
  past: Doc[];
  future: Doc[];
  undo: () => void;
  redo: () => void;
  /** parsed fonts ready to cook, keyed by font key ('default' + local families) */
  fonts: Record<string, Font>;
  /** family names of the user's local fonts, available to load on demand */
  localFonts: string[];
  select: (ids: NodeId[]) => void;
  setFrame: (frame: Frame) => void;
  setParam: (nodeId: NodeId, name: string, value: ParamValue) => void;
  /** one call moves the whole dragged set, so a group drag is a single undo step */
  moveNodes: (positions: Record<NodeId, { x: number; y: number }>) => void;
  addNode: (type: string, position: { x: number; y: number }) => void;
  removeNodes: (ids: NodeId[]) => void;
  /** ⌘/Ctrl C — snapshot the selected nodes and the wires among them */
  copySelection: () => void;
  /** ⌘/Ctrl V — drop the snapshot into the active layer, offset and selected */
  pasteClipboard: () => void;
  connect: (w: WireSpec) => void;
  removeEdges: (edgeKeys: string[]) => void;
  /** replace the whole document with a starting graph — one undo step */
  loadPreset: (doc: Doc) => void;
  selectLayer: (id: string) => void;
  /** insert a fresh layer (transparent Output, empty otherwise) above the active one */
  addLayer: () => void;
  /** copy a layer — graph, blend mode, opacity and all — directly above itself */
  duplicateLayer: (id: string) => void;
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
function revalidate(s: AppStore, doc: Doc): Pick<AppStore, 'activeLayerId' | 'selectedNodeIds'> {
  const layer = doc.layers.find((l) => l.id === s.activeLayerId) ?? doc.layers[doc.layers.length - 1];
  return {
    activeLayerId: layer.id,
    selectedNodeIds: s.selectedNodeIds.filter((id) => layer.graph.nodes[id]),
  };
}

/**
 * A copy of a layer's graph that shares nothing mutable with the original.
 * Structural rather than a JSON round trip on purpose: an Image node's `src`
 * holds a whole picture as a data URI, and copying the params object keeps
 * that string shared (strings are immutable) where re-parsing would allocate
 * a second copy of every byte.
 *
 * Node ids are copied verbatim — they are scoped to their graph, not the
 * document (every layer's Output is `out`), so there is nothing to renumber.
 */
function cloneGraph(g: Graph): Graph {
  const nodes: Record<NodeId, NodeInstance> = {};
  for (const [id, n] of Object.entries(g.nodes)) {
    nodes[id] = { ...n, params: { ...n.params }, ...(n.position ? { position: { ...n.position } } : {}) };
  }
  return { ...g, nodes, edges: g.edges.map((e) => ({ from: { ...e.from }, to: { ...e.to } })) };
}

/** The same copy, a whole document deep — what a preset is loaded through, so
 * editing the loaded document never writes back into the preset constant. */
function cloneDoc(d: Doc): Doc {
  return { frame: { ...d.frame }, layers: d.layers.map((l) => ({ ...l, graph: cloneGraph(l.graph) })) };
}

/** "Layer 2" -> "Layer 2 copy" -> "Layer 2 copy 2": duplicating a duplicate
 * counts up instead of stuttering, and never collides with a name in use. */
function copyName(name: string, taken: Set<string>): string {
  const base = name.replace(/ copy(?: \d+)?$/, '');
  let candidate = `${base} copy`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} copy ${n}`;
  return candidate;
}

let nextId = 1;
let nextLayerId = 2;

/**
 * The node clipboard. Deliberately neither document state nor React state: it
 * survives undo (copying is not an edit), never reaches localStorage, and a
 * copy shouldn't re-render the canvas. `pastes` counts repeats so a second
 * paste cascades past the first instead of landing on top of it.
 */
let clipboard: { nodes: NodeInstance[]; edges: Edge[]; pastes: number } | null = null;

/** each repeat paste steps this much further down-right of the original */
const PASTE_OFFSET = 28;

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
  selectedNodeIds: [],
  past: [],
  future: [],
  fonts: {},
  localFonts: [],

  select: (ids) => set({ selectedNodeIds: ids }),

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

  moveNodes: (positions) =>
    set((s) => {
      const ids = Object.keys(positions);
      if (!ids.length) return s;
      // the dragged set is stable for the whole gesture, so keying on it
      // coalesces every step of a group drag into one undo snapshot
      return {
        ...pushHistory(s, `move:${s.activeLayerId}:${ids.sort().join(',')}`),
        doc: editActiveGraph(s, (g) => {
          const nodes = { ...g.nodes };
          for (const id of ids) if (nodes[id]) nodes[id] = { ...nodes[id], position: positions[id] };
          return { ...g, nodes };
        }),
      };
    }),

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
        selectedNodeIds: [id],
      };
    }),

  copySelection: () => {
    const s = get();
    const graph = selectActiveGraph(s);
    const ids = new Set(s.selectedNodeIds.filter((id) => graph.nodes[id]));
    if (ids.size === 0) return; // nothing selected leaves the buffer alone
    clipboard = {
      nodes: [...ids].map((id) => ({ ...graph.nodes[id], params: { ...graph.nodes[id].params } })),
      // only wires wholly inside the selection: a dangling half-wire would
      // have nothing to reconnect to on paste
      edges: graph.edges
        .filter((e) => ids.has(e.from.node) && ids.has(e.to.node))
        .map((e) => ({ from: { ...e.from }, to: { ...e.to } })),
      pastes: 0,
    };
  },

  pasteClipboard: () => {
    if (!clipboard || clipboard.nodes.length === 0) return;
    const buf = clipboard;
    buf.pastes += 1;
    const shift = PASTE_OFFSET * buf.pastes;
    set((s) => {
      const graph = selectActiveGraph(s);
      // ids are minted against the graph being pasted INTO — pasting into
      // another layer is normal, and its ids are its own namespace
      const nodes = { ...graph.nodes };
      const remap = new Map<NodeId, NodeId>();
      for (const n of buf.nodes) {
        let id = `${n.type.toLowerCase()}_${nextId++}`;
        while (nodes[id]) id = `${n.type.toLowerCase()}_${nextId++}`;
        remap.set(n.id, id);
        nodes[id] = {
          ...n,
          id,
          params: { ...n.params },
          position: { x: (n.position?.x ?? 0) + shift, y: (n.position?.y ?? 0) + shift },
        };
      }
      const edges = [
        ...graph.edges,
        ...buf.edges.map((e) => ({
          from: { node: remap.get(e.from.node)!, socket: e.from.socket },
          to: { node: remap.get(e.to.node)!, socket: e.to.socket },
        })),
      ];
      return {
        ...pushHistory(s, null),
        doc: editActiveGraph(s, (g) => ({ ...g, nodes, edges })),
        selectedNodeIds: [...remap.values()],
      };
    });
  },

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
        selectedNodeIds: s.selectedNodeIds.filter((id) => !drop.has(id)),
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

  loadPreset: (preset) =>
    set((s) => {
      if (preset.layers.length === 0) return s;
      // deep-copied on the way in: the preset constants are module state shared
      // by every load, and the document that lands here is about to be edited
      const doc = cloneDoc(preset);
      return {
        // a discrete edit (null key): a load never coalesces with the scrub or
        // drag that came before it, so one ⌘Z always puts the old document back
        ...pushHistory(s, null),
        doc,
        // the top layer, matching where a fresh document starts
        activeLayerId: doc.layers[doc.layers.length - 1].id,
        selectedNodeIds: [],
      };
    }),

  selectLayer: (id) =>
    set((s) => {
      if (s.activeLayerId === id || !s.doc.layers.some((l) => l.id === id)) return s;
      // switching layers is a view change, not a document edit — no history
      return { activeLayerId: id, selectedNodeIds: [] };
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
        selectedNodeIds: [],
      };
    }),

  duplicateLayer: (id) =>
    set((s) => {
      const at = s.doc.layers.findIndex((l) => l.id === id);
      if (at === -1) return s;
      const src = s.doc.layers[at];
      let newId = `layer_${nextLayerId++}`;
      while (s.doc.layers.some((l) => l.id === newId)) newId = `layer_${nextLayerId++}`;
      const copy: Layer = {
        ...src,
        id: newId,
        name: copyName(src.name, new Set(s.doc.layers.map((l) => l.name))),
        graph: cloneGraph(src.graph),
      };
      // straight above the source, the way every layer panel does it — not
      // above the active layer, since the row you clicked is the subject here
      const layers = [...s.doc.layers.slice(0, at + 1), copy, ...s.doc.layers.slice(at + 1)];
      return {
        ...pushHistory(s, null),
        doc: { ...s.doc, layers },
        activeLayerId: newId,
        selectedNodeIds: [],
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
        selectedNodeIds: s.activeLayerId === id ? [] : s.selectedNodeIds,
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
