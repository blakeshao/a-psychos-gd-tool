// Wire rules + store actions, headless against the real node registry.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FRAME, type Doc, type Graph } from './engine/graph';
import { endGesture, selectActiveGraph, useApp, wireIsValid } from './store';

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
  beforeEach(() => useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeId: null }));

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
    useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeId: null, past: [], future: [] });
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
    useApp.getState().moveNode('blur1', { x: 1, y: 0 });
    useApp.getState().moveNode('blur1', { x: 2, y: 0 }); // same drag — coalesces
    endGesture(); // drag end
    useApp.getState().moveNode('blur1', { x: 9, y: 0 });
    expect(useApp.getState().past).toHaveLength(2);
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

  it('the selection is dropped when the selected node vanishes on undo', () => {
    useApp.getState().addNode('Blur', { x: 0, y: 0 });
    expect(useApp.getState().selectedNodeId).not.toBeNull();
    useApp.getState().undo();
    expect(useApp.getState().selectedNodeId).toBeNull();
  });
});

describe('layers', () => {
  beforeEach(() => {
    useApp.setState({ doc: docWith(chain()), activeLayerId: 'layer_1', selectedNodeId: null, past: [], future: [] });
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
