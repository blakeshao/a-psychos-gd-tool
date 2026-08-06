// Wire rules + store actions, headless against the real node registry.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FRAME, type Doc, type Graph } from './engine/graph';
import { registry } from './nodes';
import { PRESETS } from './presets';
import { endGesture, migrateJitter, selectActiveGraph, useApp, wireIsValid } from './store';

/** A one-layer document around `graph` — the pre-layers store shape. */
function docWith(graph: Graph): Doc {
  return {
    frame: DEFAULT_FRAME,
    layers: [{ id: 'layer_1', name: 'Layer 1', visible: true, opacity: 1, blendMode: 'normal', graph }],
  };
}

const activeGraph = () => selectActiveGraph(useApp.getState());

function chain(): Graph {
  return {
    nodes: {
      text1: { id: 'text1', type: 'Text', params: {} },
      outline1: { id: 'outline1', type: 'Outline', params: {} },
      raster1: { id: 'raster1', type: 'Rasterize', params: {} },
      blur1: { id: 'blur1', type: 'Blur', params: {} },
      out: { id: 'out', type: 'Output', params: {} },
    },
    edges: [
      { from: { node: 'text1', socket: 'out' }, to: { node: 'outline1', socket: 'text' } },
      { from: { node: 'outline1', socket: 'out' }, to: { node: 'raster1', socket: 'vector' } },
      { from: { node: 'raster1', socket: 'out' }, to: { node: 'blur1', socket: 'in' } },
      { from: { node: 'blur1', socket: 'out' }, to: { node: 'out', socket: 'in' } },
    ],
  };
}

describe('wireIsValid', () => {
  it('accepts matching socket types', () => {
    expect(wireIsValid(chain(), { source: 'raster1', sourceHandle: 'out', target: 'out', targetHandle: 'in' })).toBe(true);
  });

  it('rejects mismatched socket types — never coerced', () => {
    // text output into a raster input
    expect(wireIsValid(chain(), { source: 'text1', sourceHandle: 'out', target: 'blur1', targetHandle: 'in' })).toBe(false);
  });

  it('rejects wires that would create a cycle', () => {
    // out is downstream of blur1; wiring out back into blur1 closes a loop
    expect(wireIsValid(chain(), { source: 'out', sourceHandle: 'out', target: 'blur1', targetHandle: 'in' })).toBe(false);
  });

  it('rejects unknown sockets', () => {
    expect(wireIsValid(chain(), { source: 'raster1', sourceHandle: 'nope', target: 'out', targetHandle: 'in' })).toBe(false);
  });

  it('union inputs accept any member type, reject the rest', () => {
    const g = chain();
    g.nodes.place1 = { id: 'place1', type: 'Place', params: {} };
    g.nodes.grid1 = { id: 'grid1', type: 'Grid', params: {} };
    // vector -> Place.elements (lifted single element)
    expect(wireIsValid(g, { source: 'outline1', sourceHandle: 'out', target: 'place1', targetHandle: 'elements' })).toBe(true);
    // raster -> Place.elements
    expect(wireIsValid(g, { source: 'raster1', sourceHandle: 'out', target: 'place1', targetHandle: 'elements' })).toBe(true);
    // elements -> Output.in (the artboard composites them)
    expect(wireIsValid(g, { source: 'place1', sourceHandle: 'out', target: 'out', targetHandle: 'in' })).toBe(true);
    // layout is NOT a member — still needs Place or DrawLayout first
    expect(wireIsValid(g, { source: 'grid1', sourceHandle: 'out', target: 'out', targetHandle: 'in' })).toBe(false);
    expect(wireIsValid(g, { source: 'grid1', sourceHandle: 'out', target: 'place1', targetHandle: 'layout' })).toBe(true);
  });
});

describe('store actions', () => {
  beforeEach(() => useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeIds: [] }));

  it('connect replaces the existing wire on an input socket', () => {
    useApp.getState().connect({ source: 'raster1', sourceHandle: 'out', target: 'out', targetHandle: 'in' });
    const edges = activeGraph().edges;
    const intoOut = edges.filter((e) => e.to.node === 'out');
    expect(intoOut).toHaveLength(1);
    expect(intoOut[0].from.node).toBe('raster1'); // blur1 -> out was replaced
  });

  it('connect silently refuses an invalid wire', () => {
    const before = activeGraph().edges.length;
    useApp.getState().connect({ source: 'text1', sourceHandle: 'out', target: 'blur1', targetHandle: 'in' });
    expect(activeGraph().edges).toHaveLength(before);
  });

  it('removeNodes drops the node and all its wires', () => {
    useApp.getState().removeNodes(['blur1']);
    const g = activeGraph();
    expect(g.nodes.blur1).toBeUndefined();
    expect(g.edges.some((e) => e.from.node === 'blur1' || e.to.node === 'blur1')).toBe(false);
  });

  it('addNode seeds params from the registry defaults', () => {
    useApp.getState().addNode('Blur', { x: 0, y: 0 });
    const g = activeGraph();
    const added = Object.values(g.nodes).find((n) => n.type === 'Blur' && n.id !== 'blur1')!;
    expect(added.params.radius).toBe(8);
  });
});

describe('undo/redo', () => {
  beforeEach(() => {
    useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeIds: [], past: [], future: [] });
    endGesture();
  });

  it('undo restores a removed node and its wires; redo removes it again', () => {
    useApp.getState().removeNodes(['blur1']);
    useApp.getState().undo();
    let g = activeGraph();
    expect(g.nodes.blur1).toBeDefined();
    expect(g.edges.filter((e) => e.from.node === 'blur1' || e.to.node === 'blur1')).toHaveLength(2);
    useApp.getState().redo();
    g = activeGraph();
    expect(g.nodes.blur1).toBeUndefined();
  });

  it('a new edit clears the redo stack', () => {
    useApp.getState().removeNodes(['blur1']);
    useApp.getState().undo();
    useApp.getState().addNode('Blur', { x: 0, y: 0 });
    expect(useApp.getState().future).toHaveLength(0);
  });

  it('a param scrub coalesces into one undo step, split at gesture boundaries', () => {
    useApp.getState().setParam('blur1', 'radius', 1);
    useApp.getState().setParam('blur1', 'radius', 2);
    useApp.getState().setParam('blur1', 'radius', 3);
    endGesture(); // pointer-up
    useApp.getState().setParam('blur1', 'radius', 9);
    expect(useApp.getState().past).toHaveLength(2);
    useApp.getState().undo();
    expect(activeGraph().nodes.blur1.params.radius).toBe(3);
    useApp.getState().undo();
    expect(activeGraph().nodes.blur1.params.radius).toBeUndefined();
  });

  it('endGesture splits two drags of the same node into two undo steps', () => {
    useApp.getState().moveNodes({ blur1: { x: 1, y: 0 } });
    useApp.getState().moveNodes({ blur1: { x: 2, y: 0 } }); // same drag — coalesces
    endGesture(); // drag end
    useApp.getState().moveNodes({ blur1: { x: 9, y: 0 } });
    expect(useApp.getState().past).toHaveLength(2);
  });

  it('a group drag is one undo step that restores every node', () => {
    useApp.getState().moveNodes({ blur1: { x: 1, y: 0 }, raster1: { x: 1, y: 1 } });
    useApp.getState().moveNodes({ blur1: { x: 2, y: 0 }, raster1: { x: 2, y: 1 } }); // same drag — coalesces
    endGesture();
    expect(useApp.getState().past).toHaveLength(1);
    useApp.getState().undo();
    const g = activeGraph();
    expect(g.nodes.blur1.position).toBeUndefined();
    expect(g.nodes.raster1.position).toBeUndefined();
  });

  it('edits to different params do not coalesce', () => {
    useApp.getState().setParam('blur1', 'radius', 1);
    useApp.getState().setParam('text1', 'content', 'A');
    expect(useApp.getState().past).toHaveLength(2);
  });

  it('an invalid connect leaves no history entry', () => {
    useApp.getState().connect({ source: 'text1', sourceHandle: 'out', target: 'blur1', targetHandle: 'in' });
    expect(useApp.getState().past).toHaveLength(0);
  });

  it('undo with an empty stack is a no-op', () => {
    const before = useApp.getState().doc;
    useApp.getState().undo();
    expect(useApp.getState().doc).toBe(before);
  });

  it('selected nodes that vanish on undo are dropped from the selection', () => {
    useApp.getState().select(['text1']);
    useApp.getState().addNode('Blur', { x: 0, y: 0 });
    expect(useApp.getState().selectedNodeIds).toHaveLength(1);
    useApp.getState().select([...useApp.getState().selectedNodeIds, 'text1']);
    useApp.getState().undo();
    // the added node is gone; the surviving node stays selected
    expect(useApp.getState().selectedNodeIds).toEqual(['text1']);
  });

  it('removeNodes drops the removed ids from a multi-selection', () => {
    useApp.getState().select(['blur1', 'raster1', 'text1']);
    useApp.getState().removeNodes(['blur1', 'raster1']);
    expect(useApp.getState().selectedNodeIds).toEqual(['text1']);
  });
});

describe('layers', () => {
  beforeEach(() => {
    useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeIds: [], past: [], future: [] });
    endGesture();
  });

  it('addLayer inserts above the active layer, transparent by default, and activates it', () => {
    useApp.getState().addLayer();
    const { doc, activeLayerId } = useApp.getState();
    expect(doc.layers).toHaveLength(2);
    expect(doc.layers[1].id).toBe(activeLayerId); // above layer_1
    expect(doc.layers[1].opacity).toBe(1);
    expect(doc.layers[1].blendMode).toBe('normal');
    const out = Object.values(doc.layers[1].graph.nodes).find((n) => n.type === 'Output')!;
    expect(out.params.transparent).toBe(true);
  });

  it('graph edits land on the active layer only', () => {
    useApp.getState().addLayer();
    useApp.getState().addNode('Shape', { x: 0, y: 0 });
    const { doc } = useApp.getState();
    expect(Object.values(doc.layers[1].graph.nodes).some((n) => n.type === 'Shape')).toBe(true);
    expect(Object.values(doc.layers[0].graph.nodes).some((n) => n.type === 'Shape')).toBe(false);
  });

  it('moveLayer reorders the stack and clamps at the ends', () => {
    useApp.getState().addLayer();
    const top = useApp.getState().activeLayerId;
    useApp.getState().moveLayer(top, 1); // already topmost — no-op, no history
    expect(useApp.getState().doc.layers[1].id).toBe(top);
    const before = useApp.getState().past.length;
    useApp.getState().moveLayer(top, -1);
    expect(useApp.getState().doc.layers[0].id).toBe(top);
    expect(useApp.getState().past.length).toBe(before + 1);
  });

  it('moveLayerTo places a layer at an absolute index, clamped, no-op in place', () => {
    useApp.getState().addLayer();
    useApp.getState().addLayer();
    const [a, b, c] = useApp.getState().doc.layers.map((l) => l.id);
    useApp.getState().moveLayerTo(c, 0);
    expect(useApp.getState().doc.layers.map((l) => l.id)).toEqual([c, a, b]);
    const before = useApp.getState().past.length;
    useApp.getState().moveLayerTo(c, 0); // already there — no-op, no history
    expect(useApp.getState().past.length).toBe(before);
    useApp.getState().moveLayerTo(c, 99); // clamps to the top
    expect(useApp.getState().doc.layers.map((l) => l.id)).toEqual([a, b, c]);
  });

  it('duplicateLayer copies the graph and settings in above the source', () => {
    useApp.getState().updateLayer('layer_1', { blendMode: 'multiply', opacity: 0.4, visible: false });
    useApp.getState().addLayer(); // a second layer, so "above the source" is a real claim
    useApp.getState().duplicateLayer('layer_1');

    const { doc, activeLayerId } = useApp.getState();
    expect(doc.layers).toHaveLength(3);
    const copy = doc.layers[1]; // directly above layer_1, not on top of the stack
    expect(copy.id).toBe(activeLayerId);
    expect(copy.id).not.toBe('layer_1');
    expect(copy.name).toBe('Layer 1 copy');
    expect(copy.blendMode).toBe('multiply');
    expect(copy.opacity).toBe(0.4);
    expect(copy.visible).toBe(false);
    expect(copy.graph).toEqual(doc.layers[0].graph); // same graph, node ids and all
  });

  it('duplicateLayer shares nothing mutable with the source', () => {
    useApp.getState().duplicateLayer('layer_1');
    const copyId = useApp.getState().activeLayerId;
    useApp.getState().addNode('Shape', { x: 0, y: 0 });
    useApp.getState().setParam('text1', 'content', 'edited');

    const layers = useApp.getState().doc.layers;
    const original = layers.find((l) => l.id === 'layer_1')!;
    const copy = layers.find((l) => l.id === copyId)!;
    expect(Object.values(copy.graph.nodes).some((n) => n.type === 'Shape')).toBe(true);
    expect(Object.values(original.graph.nodes).some((n) => n.type === 'Shape')).toBe(false);
    expect(original.graph.nodes.text1.params.content).not.toBe('edited');
  });

  it('duplicateLayer counts up instead of stuttering, and undoes in one step', () => {
    useApp.getState().duplicateLayer('layer_1');
    const first = useApp.getState().activeLayerId;
    useApp.getState().duplicateLayer(first);
    expect(useApp.getState().doc.layers.map((l) => l.name))
      .toEqual(['Layer 1', 'Layer 1 copy', 'Layer 1 copy 2']);

    useApp.getState().undo();
    expect(useApp.getState().doc.layers).toHaveLength(2);
    useApp.getState().undo();
    expect(useApp.getState().doc.layers).toHaveLength(1);
    expect(useApp.getState().activeLayerId).toBe('layer_1');
  });

  it('removeLayer refuses to drop the last layer and re-targets the active one', () => {
    useApp.getState().removeLayer('layer_1');
    expect(useApp.getState().doc.layers).toHaveLength(1); // refused
    useApp.getState().addLayer();
    const added = useApp.getState().activeLayerId;
    useApp.getState().removeLayer(added);
    expect(useApp.getState().doc.layers).toHaveLength(1);
    expect(useApp.getState().activeLayerId).toBe('layer_1');
  });

  it('updateLayer sets blend mode and visibility discretely, coalesces opacity scrubs', () => {
    useApp.getState().updateLayer('layer_1', { blendMode: 'multiply' });
    useApp.getState().updateLayer('layer_1', { visible: false });
    useApp.getState().updateLayer('layer_1', { opacity: 0.5 });
    useApp.getState().updateLayer('layer_1', { opacity: 0.3 }); // same scrub — coalesces
    const layer = useApp.getState().doc.layers[0];
    expect(layer.blendMode).toBe('multiply');
    expect(layer.visible).toBe(false);
    expect(layer.opacity).toBe(0.3);
    expect(useApp.getState().past).toHaveLength(3);
  });

  it('undoing a layer delete restores it; the active id survives revalidation', () => {
    useApp.getState().addLayer();
    const added = useApp.getState().activeLayerId;
    useApp.getState().removeLayer(added);
    useApp.getState().undo();
    expect(useApp.getState().doc.layers).toHaveLength(2);
    // the active layer had vanished from the restored doc's perspective — it
    // must land on a layer that exists
    const { doc, activeLayerId } = useApp.getState();
    expect(doc.layers.some((l) => l.id === activeLayerId)).toBe(true);
  });

  it('selectLayer switches the editing target without touching history', () => {
    useApp.getState().addLayer();
    const before = useApp.getState().past.length;
    useApp.getState().selectLayer('layer_1');
    expect(useApp.getState().activeLayerId).toBe('layer_1');
    expect(useApp.getState().past.length).toBe(before);
    expect(activeGraph().nodes.text1).toBeDefined();
  });
});

describe('migrateJitter', () => {
  const graph = (edges: Graph['edges']): Graph => ({
    nodes: {
      grid1: { id: 'grid1', type: 'Grid', params: {} },
      rand1: { id: 'rand1', type: 'Random', params: { offset: 40, seed: 3 } },
      place1: { id: 'place1', type: 'Place', params: {} },
    },
    edges,
  });

  it('retypes a wired Random to Jitter, keeping its params and wiring', () => {
    const before = graph([
      { from: { node: 'grid1', socket: 'out' }, to: { node: 'rand1', socket: 'layout' } },
      { from: { node: 'rand1', socket: 'out' }, to: { node: 'place1', socket: 'layout' } },
    ]);
    const after = migrateJitter(before);
    expect(after.nodes.rand1.type).toBe('Jitter');
    expect(after.nodes.rand1.params).toEqual({ offset: 40, seed: 3 });
    expect(after.edges).toEqual(before.edges); // the wires were always valid
    expect(before.nodes.rand1.type).toBe('Random'); // the saved doc isn't mutated
  });

  it('leaves a generating Random alone', () => {
    // nothing wired into `layout` — it was a generator before the split too
    const before = graph([{ from: { node: 'rand1', socket: 'out' }, to: { node: 'place1', socket: 'layout' } }]);
    expect(migrateJitter(before)).toBe(before);
  });
});

describe('copy / paste', () => {
  beforeEach(() => {
    useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeIds: [], past: [], future: [] });
    endGesture();
  });

  const graph = () => selectActiveGraph(useApp.getState());
  const idsOfType = (type: string) =>
    Object.values(graph().nodes).filter((n) => n.type === type).map((n) => n.id);

  it('pastes fresh nodes, offset, selected, and wired to each other', () => {
    useApp.getState().setParam('text1', 'content', 'hello');
    useApp.getState().moveNodes({ text1: { x: 100, y: 50 }, outline1: { x: 300, y: 50 } });
    useApp.getState().select(['text1', 'outline1']);
    useApp.getState().copySelection();
    useApp.getState().pasteClipboard();

    const g = graph();
    expect(Object.keys(g.nodes)).toHaveLength(7); // the 5 originals + 2
    const [pastedText] = idsOfType('Text').filter((id) => id !== 'text1');
    const [pastedOutline] = idsOfType('Outline').filter((id) => id !== 'outline1');
    expect(useApp.getState().selectedNodeIds.sort()).toEqual([pastedText, pastedOutline].sort());
    // params come along, position steps clear of the original
    expect(g.nodes[pastedText].params.content).toBe('hello');
    expect(g.nodes[pastedText].position).toEqual({ x: 128, y: 78 });
    // the wire between the two copied nodes is remapped onto the copies
    expect(g.edges).toContainEqual({
      from: { node: pastedText, socket: 'out' }, to: { node: pastedOutline, socket: 'text' },
    });
    // ...and the original wiring is untouched
    expect(g.edges).toContainEqual({
      from: { node: 'text1', socket: 'out' }, to: { node: 'outline1', socket: 'text' },
    });
  });

  it('drops wires that leave the selection', () => {
    useApp.getState().select(['outline1']); // its input and output both leave
    useApp.getState().copySelection();
    const before = graph().edges.length;
    useApp.getState().pasteClipboard();
    // a lone node arrives unwired rather than stealing the original's wires
    expect(graph().edges).toHaveLength(before);
    expect(idsOfType('Outline')).toHaveLength(2);
  });

  it('cascades repeat pastes instead of stacking them', () => {
    useApp.getState().moveNodes({ blur1: { x: 0, y: 0 } });
    useApp.getState().select(['blur1']);
    useApp.getState().copySelection();
    useApp.getState().pasteClipboard();
    useApp.getState().pasteClipboard();

    const copies = idsOfType('Blur').filter((id) => id !== 'blur1').map((id) => graph().nodes[id].position);
    expect(copies).toHaveLength(2);
    expect(copies.map((p) => p!.x).sort((a, b) => a - b)).toEqual([28, 56]);
  });

  it('pastes into whichever layer is active', () => {
    useApp.getState().select(['blur1']);
    useApp.getState().copySelection();
    useApp.getState().addLayer(); // a fresh layer, now active
    useApp.getState().pasteClipboard();

    const { doc } = useApp.getState();
    expect(Object.values(doc.layers[1].graph.nodes).some((n) => n.type === 'Blur')).toBe(true);
    expect(Object.values(doc.layers[0].graph.nodes).filter((n) => n.type === 'Blur')).toHaveLength(1);
  });

  it('undoes a paste in one step', () => {
    useApp.getState().select(['text1', 'outline1']);
    useApp.getState().copySelection();
    useApp.getState().pasteClipboard();
    expect(Object.keys(graph().nodes)).toHaveLength(7);
    useApp.getState().undo();
    expect(Object.keys(graph().nodes)).toHaveLength(5);
  });

  it('copying nothing leaves the buffer alone', () => {
    useApp.getState().select(['blur1']);
    useApp.getState().copySelection();
    useApp.getState().select([]);
    useApp.getState().copySelection(); // no selection — must not clear the buffer
    useApp.getState().pasteClipboard();
    expect(idsOfType('Blur')).toHaveLength(2);
  });
});

describe('presets', () => {
  beforeEach(() => {
    useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeIds: [], past: [], future: [] });
    endGesture();
  });

  // a preset that doesn't cook is worse than no preset — these are the same
  // checks loadSavedDoc makes on a saved document, run on the constants
  it('every preset is a wireable document', () => {
    for (const preset of PRESETS) {
      expect(preset.doc.layers.length).toBeGreaterThan(0);
      for (const layer of preset.doc.layers) {
        const outputs = Object.values(layer.graph.nodes).filter((n) => n.type === 'Output');
        expect(outputs).toHaveLength(1);
        for (const node of Object.values(layer.graph.nodes)) {
          expect(registry.get(node.type), `${preset.id}: unknown node type ${node.type}`).toBeDefined();
        }
        for (const e of layer.graph.edges) {
          expect(
            wireIsValid(layer.graph, {
              source: e.from.node,
              sourceHandle: e.from.socket,
              target: e.to.node,
              targetHandle: e.to.socket,
            }),
            `${preset.id}: bad wire ${e.from.node}.${e.from.socket} -> ${e.to.node}.${e.to.socket}`,
          ).toBe(true);
        }
      }
    }
  });

  it('loadPreset replaces the document, frame and all, and selects the top layer', () => {
    const preset = PRESETS.find((p) => p.id === 'image-grid-collage')!;
    useApp.getState().select(['blur1']);
    useApp.getState().loadPreset(preset.doc);
    const s = useApp.getState();
    expect(s.doc.frame).toEqual(preset.doc.frame);
    expect(s.doc.layers.map((l) => l.id)).toEqual(preset.doc.layers.map((l) => l.id));
    expect(s.activeLayerId).toBe(preset.doc.layers[preset.doc.layers.length - 1].id);
    expect(s.selectedNodeIds).toEqual([]);
    expect(activeGraph().nodes.slice_1.type).toBe('Slice');
  });

  it('loading a preset is one undo step', () => {
    useApp.getState().loadPreset(PRESETS[1].doc);
    useApp.getState().undo();
    expect(Object.keys(activeGraph().nodes)).toContain('blur1');
    useApp.getState().redo();
    expect(Object.keys(activeGraph().nodes)).toContain('slice_1');
  });

  it('editing a loaded preset never writes back into the constant', () => {
    const preset = PRESETS.find((p) => p.id === 'image-grid-collage')!;
    const before = preset.doc.layers[0].graph.nodes.grid_1.params.columns;
    useApp.getState().loadPreset(preset.doc);
    useApp.getState().setParam('grid_1', 'columns', 12);
    expect(activeGraph().nodes.grid_1.params.columns).toBe(12);
    expect(preset.doc.layers[0].graph.nodes.grid_1.params.columns).toBe(before);
    // and the second load is unaffected by the first one's edits
    useApp.getState().loadPreset(preset.doc);
    expect(activeGraph().nodes.grid_1.params.columns).toBe(before);
  });
});
