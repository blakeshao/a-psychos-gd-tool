// Wire rules + store actions, headless against the real node registry.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Graph } from './engine/graph';
import { useApp, wireIsValid } from './store';

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
  beforeEach(() => useApp.setState({ graph: chain(), selectedNodeId: null }));

  it('connect replaces the existing wire on an input socket', () => {
    useApp.getState().connect({ source: 'raster1', sourceHandle: 'out', target: 'out', targetHandle: 'in' });
    const edges = useApp.getState().graph.edges;
    const intoOut = edges.filter((e) => e.to.node === 'out');
    expect(intoOut).toHaveLength(1);
    expect(intoOut[0].from.node).toBe('raster1'); // blur1 -> out was replaced
  });

  it('connect silently refuses an invalid wire', () => {
    const before = useApp.getState().graph.edges.length;
    useApp.getState().connect({ source: 'text1', sourceHandle: 'out', target: 'blur1', targetHandle: 'in' });
    expect(useApp.getState().graph.edges).toHaveLength(before);
  });

  it('removeNodes drops the node and all its wires', () => {
    useApp.getState().removeNodes(['blur1']);
    const g = useApp.getState().graph;
    expect(g.nodes.blur1).toBeUndefined();
    expect(g.edges.some((e) => e.from.node === 'blur1' || e.to.node === 'blur1')).toBe(false);
  });

  it('addNode seeds params from the registry defaults', () => {
    useApp.getState().addNode('Blur', { x: 0, y: 0 });
    const g = useApp.getState().graph;
    const added = Object.values(g.nodes).find((n) => n.type === 'Blur' && n.id !== 'blur1')!;
    expect(added.params.radius).toBe(8);
  });
});
