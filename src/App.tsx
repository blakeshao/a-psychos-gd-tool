// Phase 1 harness: a hardcoded Text → Outline → Rasterize → Blur → Output
// graph, an inspector generated from each node's ParamSpec, and a loud
// HIT/MISS cook log. No node editor yet — that's Phase 2.

import { useCallback, useEffect, useRef, useState } from 'react';
import * as opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import type { Graph, NodeId, ParamValue } from './engine/graph';
import { Evaluator, type CookEvent } from './engine/evaluator';
import type { CookContext, ParamSpec } from './engine/registry';
import type { RasterValue } from './engine/values';
import { GpuContext } from './gpu/device';
import { buildRegistry } from './nodes';

const registry = buildRegistry();

const initialGraph: Graph = {
  nodes: {
    text1: { id: 'text1', type: 'Text', params: { content: 'PSYCHO', fontSize: 160, font: 'default' } },
    outline1: { id: 'outline1', type: 'Outline', params: {} },
    raster1: { id: 'raster1', type: 'Rasterize', params: { width: 768, height: 512 } },
    blur1: { id: 'blur1', type: 'Blur', params: { radius: 8 } },
    out: { id: 'out', type: 'Output', params: {} },
  },
  edges: [
    { from: { node: 'text1', socket: 'out' }, to: { node: 'outline1', socket: 'text' } },
    { from: { node: 'outline1', socket: 'out' }, to: { node: 'raster1', socket: 'vector' } },
    { from: { node: 'raster1', socket: 'out' }, to: { node: 'blur1', socket: 'in' } },
    { from: { node: 'blur1', socket: 'out' }, to: { node: 'out', socket: 'in' } },
  ],
};

const FONT_URLS = ['/fonts/Inter-Regular.otf', '/fonts/JetBrainsMono-Regular.ttf', '/fonts/local-fallback.ttf'];

async function loadFirstFont(): Promise<Font | null> {
  for (const url of FONT_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      return opentype.parse(await res.arrayBuffer());
    } catch {
      // try the next candidate
    }
  }
  return null;
}

type Status = 'booting' | 'ready' | 'no-webgpu' | 'no-font';

export default function App() {
  const [graph, setGraph] = useState(initialGraph);
  const [status, setStatus] = useState<Status>('booting');
  const [events, setEvents] = useState<CookEvent[]>([]);
  const [poolStats, setPoolStats] = useState({ allocated: 0, free: 0, live: 0 });
  const [cookError, setCookError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CookContext | null>(null);
  const evaluatorRef = useRef(new Evaluator(registry));
  const busyRef = useRef(false);
  const queuedRef = useRef<Graph | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const gpu = await GpuContext.init();
      if (cancelled) return;
      if (!gpu) { setStatus('no-webgpu'); return; }
      const font = await loadFirstFont();
      if (cancelled) return;
      if (!font) { setStatus('no-font'); return; }
      ctxRef.current = { gpu, fonts: new Map([['default', font]]) };
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  const runCook = useCallback(async (g: Graph) => {
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (!ctx?.gpu || !canvas) return;
    if (busyRef.current) { queuedRef.current = g; return; }
    busyRef.current = true;
    try {
      const result = await evaluatorRef.current.evaluate(g, 'out', ctx);
      const raster = result.outputs.out as RasterValue;
      canvas.width = raster.width;
      canvas.height = raster.height;
      ctx.gpu.present(raster.texture, canvas);
      setEvents([...evaluatorRef.current.events]);
      setPoolStats(ctx.gpu.pool.stats());
      setCookError(null);
    } catch (err) {
      setCookError(String(err));
    } finally {
      busyRef.current = false;
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued) runCook(queued);
    }
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    const id = requestAnimationFrame(() => runCook(graph));
    return () => cancelAnimationFrame(id);
  }, [graph, status, runCook]);

  const setParam = (nodeId: NodeId, name: string, value: ParamValue) => {
    setGraph((g) => ({
      ...g,
      nodes: {
        ...g.nodes,
        [nodeId]: { ...g.nodes[nodeId], params: { ...g.nodes[nodeId].params, [name]: value } },
      },
    }));
  };

  if (status === 'no-webgpu') return <div className="boot-msg">WebGPU is not available in this browser. Try Chrome/Edge 113+, or Safari 18+.</div>;
  if (status === 'no-font') return <div className="boot-msg">No font found — run <code>scripts/get-font.sh</code> to fetch one into <code>public/fonts/</code>.</div>;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>nodegfx <span className="phase">phase 1</span></h1>
        {Object.values(graph.nodes).map((node) => {
          const def = registry.get(node.type)!;
          if (def.params.length === 0) return null;
          return (
            <section key={node.id} className="node-panel">
              <h2>{node.type} <span className="node-id">{node.id}</span></h2>
              {def.params.map((spec) => (
                <ParamControl
                  key={spec.name}
                  spec={spec}
                  value={node.params[spec.name] ?? spec.default}
                  onChange={(v) => setParam(node.id, spec.name, v)}
                />
              ))}
            </section>
          );
        })}
        <section className="cook-log">
          <h2>cook log <span className="pool">pool: {poolStats.live} live / {poolStats.allocated} allocated</span></h2>
          {cookError && <div className="cook-error">{cookError}</div>}
          <ul>
            {events.map((e, i) => (
              <li key={i} className={e.status}>
                <span className="badge">{e.status.toUpperCase()}</span>
                <span className="ev-node">{e.type}</span>
                <span className="ev-id">{e.nodeId}</span>
                <span className="ev-ms">{e.status === 'miss' ? `${e.ms.toFixed(1)}ms` : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
      <main className="viewport">
        {status === 'booting' ? <div className="boot-msg">initializing WebGPU…</div> : <canvas ref={canvasRef} />}
      </main>
    </div>
  );
}

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
}) {
  if (spec.kind === 'number') {
    return (
      <label className="param">
        <span>{spec.name}</span>
        <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={Number(value)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="param-value">{String(value)}</span>
      </label>
    );
  }
  return (
    <label className="param">
      <span>{spec.name}</span>
      <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
