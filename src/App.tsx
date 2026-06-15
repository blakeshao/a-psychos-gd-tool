// Shell: node editor (left) and the poster viewport presenting the Output
// node's raster (right). A top bar holds the frame config and a collapsible
// cook log. Node parameters are edited inline on each node. Any document edit
// schedules a cook on the next animation frame.

import { useCallback, useEffect, useRef, useState } from 'react';
import * as opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import { DEFAULT_FRAME, type Graph, type NodeId } from './engine/graph';
import { Evaluator, type CookEvent } from './engine/evaluator';
import { socketTypes, type CookContext } from './engine/registry';
import type { Placement, RasterValue } from './engine/values';
import { GpuContext } from './gpu/device';
import { registry } from './nodes';
import { NodeEditor } from './editor/NodeEditor';
import { useApp } from './store';

const FONT_URLS = ['/fonts/Inter-Regular.otf', '/fonts/JetBrainsMono-Regular.ttf', '/fonts/local-fallback.ttf'];

const FRAME_PRESETS: { label: string; width: number; height: number }[] = [
  { label: 'Phone — 2304×3456', width: 2304, height: 3456 },
  { label: 'Square — 2048×2048', width: 2048, height: 2048 },
  { label: 'HD — 1920×1080', width: 1920, height: 1080 },
  { label: '4K — 3840×2160', width: 3840, height: 2160 },
  { label: 'A4 300dpi — 2480×3508', width: 2480, height: 3508 },
  { label: 'Portrait — 1080×1350', width: 1080, height: 1350 },
];

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

function findOutputNode(graph: Graph): NodeId | null {
  return Object.values(graph.nodes).find((n) => n.type === 'Output')?.id ?? null;
}

type Status = 'booting' | 'ready' | 'no-webgpu' | 'no-font';

export default function App() {
  const graph = useApp((s) => s.graph);
  const selectedNodeId = useApp((s) => s.selectedNodeId);
  const fonts = useApp((s) => s.fonts);
  const setFrame = useApp((s) => s.setFrame);

  const [status, setStatus] = useState<Status>('booting');
  const [events, setEvents] = useState<CookEvent[]>([]);
  const [poolStats, setPoolStats] = useState({ allocated: 0, free: 0, live: 0 });
  const [cookError, setCookError] = useState<string | null>(null);
  const [guide, setGuide] = useState<Placement[] | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const guideRef = useRef<HTMLCanvasElement>(null);
  const gpuRef = useRef<GpuContext | null>(null);
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
      gpuRef.current = gpu;
      useApp.getState().addFont('default', font);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  const runCook = useCallback(async (g: Graph) => {
    const gpu = gpuRef.current;
    const canvas = canvasRef.current;
    if (!gpu || !canvas) return;
    if (busyRef.current) { queuedRef.current = g; return; }
    busyRef.current = true;
    const ctx: CookContext = {
      gpu,
      fonts: new Map(Object.entries(useApp.getState().fonts)),
      frame: g.frame ?? DEFAULT_FRAME,
    };
    try {
      const outputId = findOutputNode(g);
      if (!outputId) { setCookError('add an Output node to cook the graph'); return; }
      const result = await evaluatorRef.current.evaluate(g, outputId, ctx);
      const raster = result.outputs.out as RasterValue;
      canvas.width = raster.width;
      canvas.height = raster.height;
      gpu.present(raster.texture, canvas);
      setEvents([...evaluatorRef.current.events]);
      setPoolStats(gpu.pool.stats());
      setCookError(null);
    } catch (err) {
      setCookError(err instanceof Error ? err.message : String(err));
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
  }, [graph, status, runCook, fonts]);

  // Parse any local font a Text node references but that isn't loaded yet;
  // addFont then bumps `fonts`, which re-cooks via the effect above.
  useEffect(() => {
    const { fonts: loaded, loadLocalFont } = useApp.getState();
    for (const node of Object.values(graph.nodes)) {
      if (node.type !== 'Text') continue;
      const key = String(node.params.font ?? 'default');
      if (key !== 'default' && !loaded[key]) loadLocalFont(key);
    }
  }, [graph, fonts]);

  // Selecting a node that produces a layout shows its placements as a guide
  // over the artboard. Cooked with a throwaway CPU-only evaluator so the main
  // cook cache is untouched; chains that need the GPU just skip the guide.
  useEffect(() => {
    const node = selectedNodeId ? graph.nodes[selectedNodeId] : null;
    const def = node ? registry.get(node.type) : null;
    const layoutSocket = def?.outputs.find((s) => socketTypes(s).includes('layout'));
    if (status !== 'ready' || !node || !layoutSocket) {
      setGuide(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ctx: CookContext = {
          gpu: null,
          fonts: new Map(Object.entries(useApp.getState().fonts)),
          frame: graph.frame ?? DEFAULT_FRAME,
        };
        const result = await new Evaluator(registry).evaluate(graph, node.id, ctx);
        const value = result.outputs[layoutSocket.name];
        if (!cancelled) setGuide(value?.kind === 'layout' ? value.placements : null);
      } catch {
        if (!cancelled) setGuide(null); // half-wired or GPU-dependent chain — no guide
      }
    })();
    return () => { cancelled = true; };
  }, [graph, selectedNodeId, status]);

  // draw the guide markers: position circle + rotation tick, artboard-centered
  useEffect(() => {
    const canvas = guideRef.current;
    if (!canvas || !guide) return;
    const { width, height } = graph.frame ?? DEFAULT_FRAME;
    canvas.width = width;
    canvas.height = height;
    const c = canvas.getContext('2d')!;
    c.clearRect(0, 0, width, height);
    c.strokeStyle = '#ff1493'; // layout socket color
    c.fillStyle = '#ff1493';
    c.lineWidth = Math.max(1, width / 512);
    for (const p of guide) {
      const x = width / 2 + p.x;
      const y = height / 2 + p.y;
      const r = 7 * p.scale;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(p.rotation) * r * 2, y + Math.sin(p.rotation) * r * 2);
      c.stroke();
      c.beginPath();
      c.arc(x, y, c.lineWidth, 0, Math.PI * 2);
      c.fill();
    }
  }, [guide, graph.frame]);

  if (status === 'no-webgpu') return <div className="boot-msg">WebGPU is not available in this browser. Try Chrome/Edge 113+, or Safari 18+.</div>;
  if (status === 'no-font') return <div className="boot-msg">No font found — run <code>scripts/get-font.sh</code> to fetch one into <code>public/fonts/</code>.</div>;

  const frame = graph.frame ?? DEFAULT_FRAME;

  return (
    <div className="app">
      <div className="editor">
        <NodeEditor />
      </div>
      <div className="viewport">
        <div className="frame-config">
          <div className="preset-icons">
            {FRAME_PRESETS.map((p) => {
              const ar = p.width / p.height;
              const w = ar >= 1 ? 22 : Math.round(22 * ar);
              const h = ar >= 1 ? Math.round(22 / ar) : 22;
              return { ...p, w, h };
            })
              .sort((a, b) => a.h - b.h || a.w - b.w)
              .map((p) => {
                const active = p.width === frame.width && p.height === frame.height;
                return (
                  <button
                    key={p.label}
                    type="button"
                    title={p.label}
                    className={`preset-icon${active ? ' active' : ''}`}
                    onClick={() => setFrame({ width: p.width, height: p.height })}
                  >
                    <span className="preset-glyph" style={{ width: p.w, height: p.h }} />
                  </button>
                );
              })}
          </div>
          <label className="param inline">
            <span>w</span>
            <input
              type="number"
              min={16}
              max={4096}
              value={frame.width}
              onChange={(e) => setFrame({ ...frame, width: Number(e.target.value) })}
            />
          </label>
          <button
            type="button"
            className="swap-btn"
            title="swap width & height"
            onClick={() => setFrame({ width: frame.height, height: frame.width })}
          >
            ⇄
          </button>
          <label className="param inline">
            <span>h</span>
            <input
              type="number"
              min={16}
              max={4096}
              value={frame.height}
              onChange={(e) => setFrame({ ...frame, height: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="stage">
          {status === 'booting' ? (
            <div className="boot-msg">initializing WebGPU…</div>
          ) : (
            <>
              <canvas ref={canvasRef} />
              {guide && <canvas ref={guideRef} className="guide-overlay" />}
            </>
          )}
        </div>
      </div>
      <details className="cook-log">
        <summary>
          cook log
          <span className="pool">pool: {poolStats.live} live / {poolStats.allocated} allocated</span>
          {cookError && <span className="cook-error-dot" title={cookError}>●</span>}
        </summary>
        <div className="cook-log-body">
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
        </div>
      </details>
    </div>
  );
}
