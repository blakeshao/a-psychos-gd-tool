// Starting documents, offered in the node editor's presets panel. A preset is
// just a Doc — loading one replaces the working document wholesale (one undo
// step, so a misclick is ⌘Z away).
//
// The list is deliberately short: one graph per thing the tool is for. Multi
// layer is the first-run factory document — the worked example of the whole
// pipeline. Image grid collage is the other end: one layer, six nodes, the
// Slice → Shuffle → Place loop that cuts a picture up and puts it back down
// wrong on purpose.
//
// Presets are sparse by design: params left out cook at their def's default
// (the evaluator fills them in), so only the numbers that carry the look are
// written down here.

import type { Doc, Graph } from './engine/graph';
import { factoryDoc } from './factoryDoc';

/**
 * Image grid collage: one Grid feeds both sides of the cut. Slice windows the
 * picture along its cells, Shuffle permutes those same cells among the cells
 * congruent to them (on a uniform grid, all of them), and Place's by-index
 * join lands tile k on slot k's new home. Because tiles and slots come from
 * one layout, every tile is exactly the size of the hole it drops into.
 */
const collageGraph: Graph = {
  nodes: {
    image_1: {
      id: 'image_1',
      type: 'Image',
      params: { src: '/factory-image.jpg', fit: 'cover' },
      position: { x: -60, y: 60 },
    },
    grid_1: {
      id: 'grid_1',
      type: 'Grid',
      // square frame, square cells: equal gutters on both axes and 6x6 tracks
      params: { columns: 6, rows: 6, gapX: 16, gapY: 16, padX: 64, padY: 64 },
      position: { x: -60, y: 320 },
    },
    slice_1: {
      id: 'slice_1',
      type: 'Slice',
      params: {},
      position: { x: 260, y: 120 },
    },
    shuffle_1: {
      id: 'shuffle_1',
      type: 'Shuffle',
      // cells rather than tracks: the grid is uniform, so every cell is
      // congruent to every other and the permutation is a full scatter
      params: { mode: 'cells', seed: 7 },
      position: { x: 260, y: 360 },
    },
    place_1: {
      id: 'place_1',
      type: 'Place',
      // by-index, not by-order: Shuffle moved the slots but left their
      // identity alone, which is the whole join
      params: { distribute: 'by-index', binds: '[]' },
      position: { x: 560, y: 200 },
    },
    out: {
      id: 'out',
      type: 'Output',
      params: { transparent: false, background: '#ffffff' },
      position: { x: 860, y: 200 },
    },
  },
  edges: [
    { from: { node: 'image_1', socket: 'out' }, to: { node: 'slice_1', socket: 'image' } },
    { from: { node: 'grid_1', socket: 'out' }, to: { node: 'slice_1', socket: 'layout' } },
    { from: { node: 'grid_1', socket: 'out' }, to: { node: 'shuffle_1', socket: 'layout' } },
    { from: { node: 'slice_1', socket: 'out' }, to: { node: 'place_1', socket: 'elements' } },
    { from: { node: 'shuffle_1', socket: 'out' }, to: { node: 'place_1', socket: 'layout' } },
    { from: { node: 'place_1', socket: 'out' }, to: { node: 'out', socket: 'in' } },
  ],
};

export const collageDoc: Doc = {
  frame: { width: 2048, height: 2048 },
  layers: [
    { id: 'layer_1', name: 'Collage', visible: true, opacity: 1, blendMode: 'normal', graph: collageGraph },
  ],
};

export interface Preset {
  id: string;
  /** what the panel button says */
  name: string;
  /** the button's tooltip — one line on what the graph does */
  hint: string;
  doc: Doc;
}

export const PRESETS: Preset[] = [
  {
    id: 'multi-layer',
    name: 'multi-layer',
    hint: 'four layers: image treatments, scatter layouts, and text on a masked grid',
    doc: factoryDoc,
  },
  {
    id: 'image-grid-collage',
    name: 'image grid collage',
    hint: 'one image cut along a grid and shuffled back into it — Slice → Shuffle → Place',
    doc: collageDoc,
  },
];
