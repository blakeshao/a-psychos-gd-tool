// Headless engine tests — the Phase 1 gate, provable without a GPU:
// change one param → only that node and its descendants re-cook.

import { describe, expect, it } from 'vitest';
import type { Graph } from './graph';
import { Evaluator } from './evaluator';
import type { CookContext, NodeDef, Registry } from './registry';

// numeric stub values stand in for real Values; the evaluator never inspects
// them beyond raster disposal (skipped when ctx.gpu is null)
const num = (v: number) => ({ kind: 'num', v }) as never;

function stubRegistry(cookCounts: Record<string, number>): Registry {
  const count = (type: string) => { cookCounts[type] = (cookCounts[type] ?? 0) + 1; };
  const defs: NodeDef[] = [
    {
      type: 'Const',
      inputs: [],
      outputs: [{ name: 'out', type: 'raster' }],
      params: [{ name: 'v', kind: 'number', default: 0 }],
      cook: (_i, p) => { count('Const'); return { out: num(Number(p.v)) }; },
    },
    {
      type: 'Add',
      inputs: [{ name: 'in', type: 'raster' }],
      outputs: [{ name: 'out', type: 'raster' }],
      params: [{ name: 'k', kind: 'number', default: 0 }],
      cook: (i, p) => { count('Add'); return { out: num((i.in as never as { v: number }).v + Number(p.k)) }; },
    },
    {
      type: 'Sum2',
      inputs: [{ name: 'a', type: 'raster' }, { name: 'b', type: 'raster' }],
      outputs: [{ name: 'out', type: 'raster' }],
      params: [],
      cook: (i) => {
        count('Sum2');
        return { out: num((i.a as never as { v: number }).v + (i.b as never as { v: number }).v) };
      },
    },
    {
      type: 'AsyncAdd',
      inputs: [{ name: 'in', type: 'raster' }],
      outputs: [{ name: 'out', type: 'raster' }],
      params: [{ name: 'k', kind: 'number', default: 0 }],
      cook: async (i, p) => {
        count('AsyncAdd');
        await new Promise((r) => setTimeout(r, 1));
        return { out: num((i.in as never as { v: number }).v + Number(p.k)) };
      },
    },
  ];
  return new Map(defs.map((d) => [d.type, d]));
}

const ctx: CookContext = { gpu: null, fonts: new Map(), frame: { width: 768, height: 512 } };

function chainGraph(): Graph {
  // a(Const) -> b(Add) -> c(Add)
  return {
    nodes: {
      a: { id: 'a', type: 'Const', params: { v: 1 } },
      b: { id: 'b', type: 'Add', params: { k: 10 } },
      c: { id: 'c', type: 'Add', params: { k: 100 } },
    },
    edges: [
      { from: { node: 'a', socket: 'out' }, to: { node: 'b', socket: 'in' } },
      { from: { node: 'b', socket: 'out' }, to: { node: 'c', socket: 'in' } },
    ],
  };
}

function statuses(ev: Evaluator): Record<string, 'hit' | 'miss'> {
  return Object.fromEntries(ev.events.map((e) => [e.nodeId, e.status]));
}

describe('Evaluator', () => {
  it('cooks a chain and produces the right value', async () => {
    const ev = new Evaluator(stubRegistry({}));
    const { outputs } = await ev.evaluate(chainGraph(), 'c', ctx);
    expect((outputs.out as never as { v: number }).v).toBe(111);
    expect(statuses(ev)).toEqual({ a: 'miss', b: 'miss', c: 'miss' });
  });

  it('hits cache on a second identical evaluate — zero re-cooks', async () => {
    const counts: Record<string, number> = {};
    const ev = new Evaluator(stubRegistry(counts));
    const g = chainGraph();
    await ev.evaluate(g, 'c', ctx);
    await ev.evaluate(g, 'c', ctx);
    expect(statuses(ev)).toEqual({ a: 'hit', b: 'hit', c: 'hit' });
    expect(counts).toEqual({ Const: 1, Add: 2 }); // nothing cooked twice
  });

  it('re-cooks only descendants when a mid-chain param changes', async () => {
    const ev = new Evaluator(stubRegistry({}));
    const g = chainGraph();
    await ev.evaluate(g, 'c', ctx);
    g.nodes.b.params.k = 20; // change the middle node
    const { outputs } = await ev.evaluate(g, 'c', ctx);
    expect(statuses(ev)).toEqual({ a: 'hit', b: 'miss', c: 'miss' });
    expect((outputs.out as never as { v: number }).v).toBe(121);
  });

  it('re-cooks everything when the leaf changes', async () => {
    const ev = new Evaluator(stubRegistry({}));
    const g = chainGraph();
    await ev.evaluate(g, 'c', ctx);
    g.nodes.a.params.v = 2;
    await ev.evaluate(g, 'c', ctx);
    expect(statuses(ev)).toEqual({ a: 'miss', b: 'miss', c: 'miss' });
  });

  it('cooks a diamond dependency once per node', async () => {
    const counts: Record<string, number> = {};
    const ev = new Evaluator(stubRegistry(counts));
    // a -> b, a -> c, (b,c) -> d
    const g: Graph = {
      nodes: {
        a: { id: 'a', type: 'Const', params: { v: 1 } },
        b: { id: 'b', type: 'Add', params: { k: 10 } },
        c: { id: 'c', type: 'Add', params: { k: 100 } },
        d: { id: 'd', type: 'Sum2', params: {} },
      },
      edges: [
        { from: { node: 'a', socket: 'out' }, to: { node: 'b', socket: 'in' } },
        { from: { node: 'a', socket: 'out' }, to: { node: 'c', socket: 'in' } },
        { from: { node: 'b', socket: 'out' }, to: { node: 'd', socket: 'a' } },
        { from: { node: 'c', socket: 'out' }, to: { node: 'd', socket: 'b' } },
      ],
    };
    const { outputs } = await ev.evaluate(g, 'd', ctx);
    expect((outputs.out as never as { v: number }).v).toBe(112);
    expect(counts.Const).toBe(1); // shared upstream cooked once, not twice
  });

  it('allows optional inputs to stay unwired, requires the rest', async () => {
    const counts: Record<string, number> = {};
    const registry = stubRegistry(counts);
    registry.set('Opt', {
      type: 'Opt',
      inputs: [
        { name: 'in', type: 'raster' },
        { name: 'extra', type: 'raster', optional: true },
      ],
      outputs: [{ name: 'out', type: 'raster' }],
      params: [],
      cook: (i) => ({ out: num((i.in as never as { v: number }).v + (i.extra ? 1000 : 0)) }),
    });
    const ev = new Evaluator(registry);
    const g: Graph = {
      nodes: {
        a: { id: 'a', type: 'Const', params: { v: 3 } },
        o: { id: 'o', type: 'Opt', params: {} },
      },
      edges: [{ from: { node: 'a', socket: 'out' }, to: { node: 'o', socket: 'in' } }],
    };
    const { outputs } = await ev.evaluate(g, 'o', ctx);
    expect((outputs.out as never as { v: number }).v).toBe(3); // cooked without 'extra'

    g.edges = []; // now even the required input is gone
    await expect(ev.evaluate(g, 'o', ctx)).rejects.toThrow(/input "in" is not connected/);
  });

  it('fills missing params with registry defaults, hashing them identically', async () => {
    const counts: Record<string, number> = {};
    const registry = stubRegistry(counts);
    registry.set('Sized', {
      type: 'Sized',
      inputs: [],
      outputs: [{ name: 'out', type: 'raster' }],
      params: [{ name: 'size', kind: 'number', default: 64 }],
      cook: (_i, p) => {
        if (typeof p.size !== 'number' || Number.isNaN(p.size)) throw new Error('size missing');
        return { out: num(Number(p.size)) };
      },
    });
    const ev = new Evaluator(registry);
    // instance predates the param — params is empty (the createTexture NaN bug)
    const bare: Graph = { nodes: { s: { id: 's', type: 'Sized', params: {} } }, edges: [] };
    const first = await ev.evaluate(bare, 's', ctx);
    expect((first.outputs.out as never as { v: number }).v).toBe(64); // cooked with the default

    // an instance with the default written out is the SAME content → cache hit
    const explicit: Graph = { nodes: { s: { id: 's', type: 'Sized', params: { size: 64 } } }, edges: [] };
    await ev.evaluate(explicit, 's', ctx);
    expect(statuses(ev)).toEqual({ s: 'hit' });
  });

  it('re-cooks only frame-aware nodes when the frame changes', async () => {
    const counts: Record<string, number> = {};
    const registry = stubRegistry(counts);
    registry.set('Framed', {
      type: 'Framed',
      inputs: [{ name: 'in', type: 'raster' }],
      outputs: [{ name: 'out', type: 'raster' }],
      params: [],
      usesFrame: true,
      cook: (i, _p, c) => {
        counts.Framed = (counts.Framed ?? 0) + 1;
        return { out: num((i.in as never as { v: number }).v + c.frame.width) };
      },
    });
    const ev = new Evaluator(registry);
    const g: Graph = {
      nodes: {
        a: { id: 'a', type: 'Const', params: { v: 1 } }, // frame-unaware
        f: { id: 'f', type: 'Framed', params: {} },
      },
      edges: [{ from: { node: 'a', socket: 'out' }, to: { node: 'f', socket: 'in' } }],
    };
    const first = await ev.evaluate(g, 'f', { ...ctx, frame: { width: 100, height: 100 } });
    expect((first.outputs.out as never as { v: number }).v).toBe(101);

    const second = await ev.evaluate(g, 'f', { ...ctx, frame: { width: 200, height: 100 } });
    expect(statuses(ev)).toEqual({ a: 'hit', f: 'miss' }); // only the frame-aware node re-cooked
    expect((second.outputs.out as never as { v: number }).v).toBe(201);
  });

  it('awaits async nodes with no special casing', async () => {
    const ev = new Evaluator(stubRegistry({}));
    const g: Graph = {
      nodes: {
        a: { id: 'a', type: 'Const', params: { v: 5 } },
        b: { id: 'b', type: 'AsyncAdd', params: { k: 7 } },
      },
      edges: [{ from: { node: 'a', socket: 'out' }, to: { node: 'b', socket: 'in' } }],
    };
    const first = await ev.evaluate(g, 'b', ctx);
    expect((first.outputs.out as never as { v: number }).v).toBe(12);
    await ev.evaluate(g, 'b', ctx);
    expect(statuses(ev)).toEqual({ a: 'hit', b: 'hit' }); // async result cached like any other
  });
});
