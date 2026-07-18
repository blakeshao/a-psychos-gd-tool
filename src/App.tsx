// Shell: node editor (left, showing the active layer's graph) and the poster
// viewport presenting the composited layer stack (right). A top bar holds the
// frame config, a floating panel the layer stack, and a collapsible cook log.
// Node parameters are edited inline on each node. Any document edit schedules
// a cook on the next animation frame.

import { useCallback, useEffect, useRef, useState } from 'react';
import * as opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import { BLEND_MODES, type Doc, type Graph, type NodeId } from './engine/graph';
import { Evaluator, type CookEvent } from './engine/evaluator';
import { socketTypes, type CookContext } from './engine/registry';
import type { Placement, RasterValue } from './engine/values';
import { GpuContext } from './gpu/device';
import type { PooledTexture } from './gpu/pool';
import { registry } from './nodes';
import { NodeEditor } from './editor/NodeEditor';
import { LayersPanel } from './editor/LayersPanel';
import { loadLocalFontsIfGranted, selectActiveGraph, useApp } from './store';

const FONT_URLS = ['/fonts/Inter-Regular.otf', '/fonts/JetBrainsMono-Regular.ttf', '/fonts/local-fallback.ttf'];

// only show the loading overlay once a cook has run this long — keeps quick
// re-cooks (most param tweaks) from flashing it
const PENDING_DELAY_MS = 250;

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

/**
 * Cook every visible layer (each through its own evaluator, so per-layer
 * caches never collide) and blend the stack bottom-to-top on the GPU. The
 * caller owns the returned texture and releases it after present/readback.
 */
async function renderDoc(
  doc: Doc,
  ctx: CookContext,
  evaluators: Map<string, Evaluator>,
): Promise<{ texture: PooledTexture; events: CookEvent[] }> {
  const gpu = ctx.gpu!;
  const { width, height } = ctx.frame;
  // a deleted layer takes its evaluator — and its cached textures — with it
  for (const [id, evaluator] of evaluators) {
    if (!doc.layers.some((l) => l.id === id)) {
      evaluator.dispose(ctx);
      evaluators.delete(id);
    }
  }
  const events: CookEvent[] = [];
  let acc = gpu.pool.acquire(width, height);
  gpu.clear(acc, { r: 0, g: 0, b: 0, a: 0 });
  try {
    for (const layer of doc.layers) {
      if (!layer.visible) continue;
      const outputId = findOutputNode(layer.graph);
      if (!outputId) throw new Error(`layer "${layer.name}" has no Output node`);
      let evaluator = evaluators.get(layer.id);
      if (!evaluator) {
        evaluator = new Evaluator(registry);
        evaluators.set(layer.id, evaluator);
      }
      const result = await evaluator.evaluate(layer.graph, outputId, ctx);
      events.push(...evaluator.events);
      const raster = result.outputs.out as RasterValue;
      const next = gpu.pool.acquire(width, height);
      gpu.runPass('layerblend', [acc, raster.texture], next, new Float32Array([
        Math.max(0, BLEND_MODES.indexOf(layer.blendMode)),
        layer.opacity,
        0,
        0,
      ]));
      gpu.pool.release(acc);
      acc = next;
    }
  } catch (err) {
    gpu.pool.release(acc);
    throw err;
  }
  return { texture: acc, events };
}

type Status = 'booting' | 'ready' | 'no-webgpu' | 'no-font';

export default function App() {
  const doc = useApp((s) => s.doc);
  const activeGraph = useApp(selectActiveGraph);
  const selectedNodeIds = useApp((s) => s.selectedNodeIds);
  // the layout guide only makes sense for one node — hide it for a marquee'd group
  const selectedNodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null;
  const fonts = useApp((s) => s.fonts);
  const localFonts = useApp((s) => s.localFonts);
  const setFrame = useApp((s) => s.setFrame);

  const [status, setStatus] = useState<Status>('booting');
  const [events, setEvents] = useState<CookEvent[]>([]);
  const [poolStats, setPoolStats] = useState({ allocated: 0, free: 0, live: 0 });
  const [cookError, setCookError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [guide, setGuide] = useState<{
    placements: Placement[];
    /** generator's coverage rect (Random's area params), artboard-centered */
    area?: { width: number; height: number };
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const guideRef = useRef<HTMLCanvasElement>(null);
  const gpuRef = useRef<GpuContext | null>(null);
  const evaluatorsRef = useRef(new Map<string, Evaluator>()); // one cache per layer
  const busyRef = useRef(false);
  const queuedRef = useRef<Doc | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLocalFontsIfGranted(); // fire-and-forget; boot doesn't wait on the list
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

  const runCook = useCallback(async (d: Doc) => {
    const gpu = gpuRef.current;
    const canvas = canvasRef.current;
    if (!gpu || !canvas) return;
    if (busyRef.current) { queuedRef.current = d; return; }
    busyRef.current = true;
    // lax loading: most cooks are instant, so only reveal the overlay once a cook
    // has been running long enough to actually feel like a wait. fast cooks clear
    // the timer before it fires and never flash the overlay.
    const showTimer = setTimeout(() => setPending(true), PENDING_DELAY_MS);
    const ctx: CookContext = {
      gpu,
      fonts: new Map(Object.entries(useApp.getState().fonts)),
      frame: d.frame,
    };
    try {
      const { texture, events } = await renderDoc(d, ctx, evaluatorsRef.current);
      canvas.width = texture.width;
      canvas.height = texture.height;
      gpu.present(texture, canvas);
      gpu.pool.release(texture);
      setEvents(events);
      setPoolStats(gpu.pool.stats());
      setCookError(null);
    } catch (err) {
      setCookError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(showTimer);
      busyRef.current = false;
      const queued = queuedRef.current;
      queuedRef.current = null;
      // keep the overlay up if another cook is already queued behind this one
      if (queued) runCook(queued);
      else setPending(false);
    }
  }, []);

  // Export re-evaluates through the caches (all HITs unless the doc changed
  // mid-click), composites the stack, reads it back to the CPU, and downloads
  // a PNG — transparency in the stack survives into the file. Shares busyRef
  // with runCook: cache eviction only happens inside evaluate(), so serializing
  // against cooks keeps the layer textures alive through the composite.
  const exportPng = useCallback(async () => {
    const gpu = gpuRef.current;
    if (!gpu || busyRef.current) return;
    busyRef.current = true;
    setExporting(true);
    try {
      const d = useApp.getState().doc;
      const ctx: CookContext = {
        gpu,
        fonts: new Map(Object.entries(useApp.getState().fonts)),
        frame: d.frame,
      };
      const { texture } = await renderDoc(d, ctx, evaluatorsRef.current);
      const image = await gpu.readback(texture);
      gpu.pool.release(texture);
      const off = document.createElement('canvas');
      off.width = image.width;
      off.height = image.height;
      off.getContext('2d')!.putImageData(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => off.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG encoding failed');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `poster-${image.width}x${image.height}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setCookError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setExporting(false);
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued) runCook(queued);
    }
  }, [runCook]);

  useEffect(() => {
    if (status !== 'ready') return;
    const id = requestAnimationFrame(() => runCook(doc));
    return () => cancelAnimationFrame(id);
  }, [doc, status, runCook, fonts]);

  // Parse any local font a Text node (on any layer) references but that isn't
  // loaded yet; addFont then bumps `fonts`, which re-cooks via the effect
  // above. Also runs when `localFonts` arrives so a saved document's fonts
  // load right at startup.
  useEffect(() => {
    const { fonts: loaded, loadLocalFont } = useApp.getState();
    for (const layer of doc.layers) {
      for (const node of Object.values(layer.graph.nodes)) {
        if (node.type !== 'Text') continue;
        const key = String(node.params.font ?? 'default');
        if (key !== 'default' && !loaded[key]) loadLocalFont(key);
      }
    }
  }, [doc, fonts, localFonts]);

  // Selecting a node that produces a layout shows its placements as a guide
  // over the artboard. Cooked with a throwaway CPU-only evaluator so the main
  // cook cache is untouched; chains that need the GPU just skip the guide.
  useEffect(() => {
    const node = selectedNodeId ? activeGraph.nodes[selectedNodeId] : null;
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
          frame: doc.frame,
        };
        const result = await new Evaluator(registry).evaluate(activeGraph, node.id, ctx);
        const value = result.outputs[layoutSocket.name];
        // a generating Random (no upstream layout) also shows the area its
        // points are drawn from — params fall back to the def's defaults
        const generates = node.type === 'Random'
          && !activeGraph.edges.some((e) => e.to.node === node.id && e.to.socket === 'layout');
        const area = generates
          ? {
              width: Number(node.params.areaWidth ?? 600),
              height: Number(node.params.areaHeight ?? 400),
            }
          : undefined;
        if (!cancelled) setGuide(value?.kind === 'layout' ? { placements: value.placements, area } : null);
      } catch {
        if (!cancelled) setGuide(null); // half-wired or GPU-dependent chain — no guide
      }
    })();
    return () => { cancelled = true; };
  }, [doc.frame, activeGraph, selectedNodeId, status]);

  // draw the guide, artboard-centered: placements with cell extents (Grid) draw
  // their actual rect; point placements keep the circle + rotation tick marker
  useEffect(() => {
    const canvas = guideRef.current;
    if (!canvas || !guide) return;
    const { width, height } = doc.frame;
    canvas.width = width;
    canvas.height = height;
    const c = canvas.getContext('2d')!;
    c.clearRect(0, 0, width, height);
    c.strokeStyle = '#ff1493'; // layout socket color
    c.fillStyle = '#ff1493';
    c.lineWidth = Math.max(1, width / 512);
    if (guide.area) {
      // the generator's coverage rect, dashed so it reads as a bound, not a cell
      c.save();
      c.setLineDash([c.lineWidth * 6, c.lineWidth * 4]);
      c.strokeRect(
        width / 2 - guide.area.width / 2,
        height / 2 - guide.area.height / 2,
        guide.area.width,
        guide.area.height,
      );
      c.restore();
    }
    for (const p of guide.placements) {
      const x = width / 2 + p.x;
      const y = height / 2 + p.y;
      if (p.w != null && p.h != null) {
        c.save();
        c.translate(x, y);
        c.rotate(p.rotation);
        c.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
        c.restore();
        c.beginPath();
        c.arc(x, y, c.lineWidth * 1.5, 0, Math.PI * 2);
        c.fill();
        continue;
      }
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
  }, [guide, doc.frame]);

  if (status === 'no-webgpu') return <div className="boot-msg">WebGPU is not available in this browser. Try Chrome/Edge 113+, or Safari 18+.</div>;
  if (status === 'no-font') return <div className="boot-msg">No font found — run <code>scripts/get-font.sh</code> to fetch one into <code>public/fonts/</code>.</div>;

  const frame = doc.frame;

  return (
    <div className="app">
      <div className="editor">
        <NodeEditor />
        <LayersPanel />
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
          <button
            type="button"
            className="export-btn"
            title="download the poster as a PNG"
            disabled={status !== 'ready' || exporting}
            onClick={exportPng}
          >
            {exporting ? 'exporting…' : 'export png'}
          </button>
        </div>
        <div className="stage">
          {status === 'booting' ? (
            <div className="boot-msg">initializing WebGPU…</div>
          ) : (
            <>
              <canvas ref={canvasRef} />
              {guide && <canvas ref={guideRef} className="guide-overlay" />}
              {pending && <div className="cook-pending" role="status" aria-label="rendering" />}
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
