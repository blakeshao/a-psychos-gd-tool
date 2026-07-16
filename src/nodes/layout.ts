// Layout lane: what slots exist + what signal rides on them.
// Generators (Grid, Sample Path, Function, Random) create slots with honest
// channel defaults. None takes a count: each prescribes structure (lattice,
// arc-length gap, density) and how many slots exist falls out — the element
// lane decides how many get filled (elements.ts). Each takes an optional mask
// that bounds its domain: the prescribed structure holds and the mask trims
// slots to its coverage, born as a clean run (unlike Filter, which prunes a
// run that already exists, by signal rather than area). Weight authors the
// weight channel deliberately; Filter prunes slots (the only lane node that
// deletes existing geometry). Ordering is NOT a lane concern — Place owns the element↔slot
// mapping (elements.ts). Draw Layout renders slots as geometry. Channel
// contract: Placement in values.ts.

import { boundsOfPaths, flattenPaths, polylinesToPaths, samplePathEvenly } from '../engine/path';
import type { CookContext, NodeDef, SocketSpec } from '../engine/registry';
import { readChannel, type AlphaValue, type LayoutValue, type PathCmd, type Placement, type RasterValue, type VectorValue } from '../engine/values';
import { compileExpr } from '../util/expr';
import { latticeHash } from '../util/noise';

const PHI = (1 + Math.sqrt(5)) / 2;

/** Every generator takes this: an optional area the distribution must stay inside. */
const MASK_INPUT: SocketSpec = { name: 'mask', type: ['raster', 'alpha'], optional: true };

/**
 * The generators' mask: a raster's alpha channel (a Remove Background cutout,
 * a PNG with transparency) or an alpha value's mask (To Alpha writes it to
 * RGB). One readback, then point tests in layout space — layouts are
 * origin-at-center, the mask is sampled center-aligned; in = coverage ≥ 0.5.
 */
async function maskTest(
  mask: RasterValue | AlphaValue | undefined,
  ctx: CookContext,
): Promise<((x: number, y: number) => boolean) | null> {
  if (!mask) return null;
  if (!ctx.gpu) throw new Error('a mask input needs a GPU context');
  const img = await ctx.gpu.readback(mask.texture);
  const ch = mask.kind === 'alpha' ? 0 : 3;
  return (x, y) => {
    const px = Math.min(img.width - 1, Math.max(0, Math.round(x + img.width / 2)));
    const py = Math.min(img.height - 1, Math.max(0, Math.round(y + img.height / 2)));
    return img.data[(py * img.width + px) * 4 + ch] >= 128;
  };
}

// every distribution is a weight generator `(i, n) → w`; the content span is
// split proportionally, fr-style — fibonacci is literally `1fr 1fr 2fr 3fr 5fr`
const DIST_OPTIONS = ['uniform', 'fibonacci', 'golden', 'geometric', 'custom', 'expression'];
const NONUNIFORM = DIST_OPTIONS.slice(1);

/**
 * Per-track weights for one axis. Weights are normalized against their sum, so
 * only ratios matter — an expression never needs to "sum to 12". Degenerate
 * values (NaN, zero, negative) clamp to epsilon; a broken expression or empty
 * custom list falls back to uniform rather than breaking the cook.
 */
function axisWeights(
  n: number,
  dist: string,
  opts: { ratio: number; list: string; expr: string; reverse: boolean },
): number[] {
  let weights: number[];
  switch (dist) {
    case 'fibonacci': {
      weights = [];
      let a = 1, b = 1;
      for (let i = 0; i < n; i++) { weights.push(a); [a, b] = [b, a + b]; }
      break;
    }
    case 'golden':
      weights = Array.from({ length: n }, (_, i) => Math.pow(PHI, i));
      break;
    case 'geometric': {
      const r = Number.isFinite(opts.ratio) && opts.ratio > 0 ? opts.ratio : PHI;
      weights = Array.from({ length: n }, (_, i) => Math.pow(r, i));
      break;
    }
    case 'custom': {
      const list = opts.list.split(/[\s,]+/).map(Number).filter((w) => Number.isFinite(w) && w > 0);
      weights = list.length
        ? Array.from({ length: n }, (_, i) => list[i % list.length]) // short lists cycle
        : new Array(n).fill(1);
      break;
    }
    case 'expression': {
      try {
        const fn = compileExpr(opts.expr);
        weights = Array.from({ length: n }, (_, i) => fn({ i, n, t: n === 1 ? 0 : i / (n - 1) }));
      } catch {
        weights = new Array(n).fill(1);
      }
      break;
    }
    default:
      weights = new Array(n).fill(1);
  }
  weights = weights.map((w) => (Number.isFinite(w) && w > 1e-6 ? w : 1e-6));
  if (opts.reverse) weights.reverse();
  return weights;
}

/** Distribute the span (minus gaps) across tracks by weight; centers accumulate. */
function axisTracks(weights: number[], gap: number, span: number): { centers: number[]; sizes: number[] } {
  const avail = Math.max(0, span - gap * (weights.length - 1));
  const total = weights.reduce((s, w) => s + w, 0);
  const sizes = weights.map((w) => (avail * w) / total);
  const centers: number[] = [];
  let x = 0;
  for (const s of sizes) { centers.push(x + s / 2); x += s + gap; }
  return { centers, sizes };
}

export const GridNode: NodeDef = {
  type: 'Grid',
  inputs: [MASK_INPUT],
  outputs: [{ name: 'out', type: 'layout' }],
  usesFrame: true,
  params: [
    { name: 'columns', kind: 'number', default: 6, min: 1, max: 64, step: 1 },
    { name: 'rows', kind: 'number', default: 4, min: 1, max: 64, step: 1 },
    // gutters between cells; the frame (minus padding) fixes the overall span
    { name: 'gapX', kind: 'number', default: 0, min: 0, max: 600, step: 1 },
    { name: 'gapY', kind: 'number', default: 0, min: 0, max: 600, step: 1 },
    { name: 'padding', kind: 'select', options: ['x/y', 'per-side'], default: 'x/y' },
    { name: 'padX', kind: 'number', default: 48, min: 0, max: 1000, step: 1, showIf: { param: 'padding', in: ['x/y'] } },
    { name: 'padY', kind: 'number', default: 48, min: 0, max: 1000, step: 1, showIf: { param: 'padding', in: ['x/y'] } },
    { name: 'padTop', kind: 'number', default: 48, min: 0, max: 1000, step: 1, showIf: { param: 'padding', in: ['per-side'] } },
    { name: 'padRight', kind: 'number', default: 48, min: 0, max: 1000, step: 1, showIf: { param: 'padding', in: ['per-side'] } },
    { name: 'padBottom', kind: 'number', default: 48, min: 0, max: 1000, step: 1, showIf: { param: 'padding', in: ['per-side'] } },
    { name: 'padLeft', kind: 'number', default: 48, min: 0, max: 1000, step: 1, showIf: { param: 'padding', in: ['per-side'] } },
    // track distribution per axis (subsumes the old skew params: geometric
    // with a ratio is the monotone bias, now with honest cell sizes)
    { name: 'distX', kind: 'select', options: DIST_OPTIONS, default: 'uniform' },
    { name: 'distY', kind: 'select', options: DIST_OPTIONS, default: 'uniform' },
    { name: 'ratioX', kind: 'number', default: 1.618, min: 0.1, max: 5, step: 0.01, showIf: { param: 'distX', in: ['geometric'] } },
    { name: 'ratioY', kind: 'number', default: 1.618, min: 0.1, max: 5, step: 0.01, showIf: { param: 'distY', in: ['geometric'] } },
    { name: 'weightsX', kind: 'string', default: '1,1,2,3,5', showIf: { param: 'distX', in: ['custom'] } },
    { name: 'weightsY', kind: 'string', default: '1,1,2,3,5', showIf: { param: 'distY', in: ['custom'] } },
    // vars: t (0..1 across tracks), i (track index), n (track count);
    // consts pi, tau, e, phi — scale-free, only ratios between tracks matter
    { name: 'exprX', kind: 'string', default: '1 + sin(t*pi)', showIf: { param: 'distX', in: ['expression'] } },
    { name: 'exprY', kind: 'string', default: '1 + sin(t*pi)', showIf: { param: 'distY', in: ['expression'] } },
    { name: 'reverseX', kind: 'select', options: ['no', 'yes'], default: 'no', showIf: { param: 'distX', in: NONUNIFORM } },
    { name: 'reverseY', kind: 'select', options: ['no', 'yes'], default: 'no', showIf: { param: 'distY', in: NONUNIFORM } },
    // brick offset: shift every other row (or column) by half a pitch
    { name: 'stagger', kind: 'select', options: ['none', 'rows', 'columns'], default: 'none' },
    // fill order — Place assigns elements by placement order, so this is layout
    { name: 'flow', kind: 'select', options: ['rows', 'columns', 'serpentine'], default: 'rows' },
  ],
  async cook(inputs, params, ctx) {
    const inMask = await maskTest(inputs.mask as RasterValue | AlphaValue | undefined, ctx);
    const cols = Math.max(1, Math.round(Number(params.columns)));
    const rows = Math.max(1, Math.round(Number(params.rows)));
    const gapX = Number(params.gapX), gapY = Number(params.gapY);
    const perSide = params.padding === 'per-side';
    const padL = Number(perSide ? params.padLeft : params.padX);
    const padR = Number(perSide ? params.padRight : params.padX);
    const padT = Number(perSide ? params.padTop : params.padY);
    const padB = Number(perSide ? params.padBottom : params.padY);

    // subdivide the frame's content box (frame minus padding) into weighted
    // tracks — uniform grids are just the all-ones weight case
    const { width: fw, height: fh } = ctx.frame;
    const contentW = Math.max(0, fw - padL - padR);
    const contentH = Math.max(0, fh - padT - padB);
    const tx = axisTracks(
      axisWeights(cols, String(params.distX), {
        ratio: Number(params.ratioX), list: String(params.weightsX ?? ''),
        expr: String(params.exprX ?? ''), reverse: params.reverseX === 'yes',
      }),
      gapX, contentW,
    );
    const ty = axisTracks(
      axisWeights(rows, String(params.distY), {
        ratio: Number(params.ratioY), list: String(params.weightsY ?? ''),
        expr: String(params.exprY ?? ''), reverse: params.reverseY === 'yes',
      }),
      gapY, contentH,
    );

    // layouts are origin-at-center; the content box is anchored in frame space
    const originX = -fw / 2 + padL;
    const originY = -fh / 2 + padT;
    // weight = cell area normalized to the biggest cell, so uniform grids keep
    // weight 1 everywhere and Filter/Sort/Place get a real density signal on
    // non-uniform ones ("keep only the big cells", "biggest element first")
    const maxArea = Math.max(...tx.sizes) * Math.max(...ty.sizes);
    const cell = (c: number, r: number): Placement => ({
      x: originX + tx.centers[c] + (params.stagger === 'rows' && r % 2 === 1 ? (tx.sizes[c] + gapX) / 2 : 0),
      y: originY + ty.centers[r] + (params.stagger === 'columns' && c % 2 === 1 ? (ty.sizes[r] + gapY) / 2 : 0),
      rotation: 0,
      scale: 1,
      progress: 0,
      weight: maxArea > 0 ? (tx.sizes[c] * ty.sizes[r]) / maxArea : 1,
      index: 0,
      w: tx.sizes[c],
      h: ty.sizes[r],
    });

    // emit in fill order; index = slot identity, progress = position along that order
    let placements: Placement[] = [];
    if (params.flow === 'columns') {
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) placements.push(cell(c, r));
    } else {
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          placements.push(cell(params.flow === 'serpentine' && r % 2 === 1 ? cols - 1 - c : c, r));
    }
    // the lattice is fixed by columns/rows; the mask decides which cells exist.
    // Masking happens before index/progress, so the slots are born a clean run
    if (inMask) placements = placements.filter((p) => inMask(p.x, p.y));
    placements.forEach((p, i) => {
      p.index = i;
      p.progress = placements.length === 1 ? 0 : i / (placements.length - 1);
    });
    return { out: { kind: 'layout', placements } satisfies LayoutValue };
  },
};

export const RandomLayoutNode: NodeDef = {
  type: 'Random',
  inputs: [{ name: 'layout', type: 'layout', optional: true }, MASK_INPUT],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    // generate mode (no input): random placements in an area. spacing is the
    // density knob — how many fit follows from area / spacing² (poisson-disk
    // reads it as the min distance and packs until the stream runs dry)
    { name: 'distribution', kind: 'select', options: ['uniform', 'poisson-disk', 'gaussian'], default: 'uniform' },
    { name: 'spacing', kind: 'number', default: 100, min: 10, max: 500, step: 1 },
    { name: 'areaWidth', kind: 'number', default: 600, min: 10, max: 4096, step: 1 },
    { name: 'areaHeight', kind: 'number', default: 400, min: 10, max: 4096, step: 1 },
    // modulate mode (input wired): seeded jitter on existing placements
    { name: 'offset', kind: 'number', default: 0, min: 0, max: 300, step: 1 },
    { name: 'rotate', kind: 'number', default: 0, min: 0, max: 3.14, step: 0.01 },
    { name: 'scaleJitter', kind: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  ],
  async cook(inputs, params, ctx) {
    const seed = Number(params.seed);
    const upstream = inputs.layout as LayoutValue | undefined;
    const inMask = await maskTest(inputs.mask as RasterValue | AlphaValue | undefined, ctx);

    if (!upstream) {
      const w = Number(params.areaWidth), h = Number(params.areaHeight);
      const spacing = Math.max(1, Number(params.spacing ?? 100));
      const gaussian = params.distribution === 'gaussian';
      const poisson = params.distribution === 'poisson-disk';
      // how many fit follows from the density: one point per spacing² of area
      // (capped — a tiny spacing over a huge area shouldn't melt the cook)
      const target = Math.max(1, Math.min(1000, Math.round((w * h) / (spacing * spacing))));
      // walk a deterministic candidate stream until the area's quota fills:
      // gaussian redraws its out-of-area tail, poisson-disk drops candidates
      // closer than `spacing` to an accepted point (dart throwing — it stops
      // early once the stream runs dry). Uniform accepts every candidate
      const accepted: { x: number; y: number }[] = [];
      const maxTries = target * 16 + 64;
      for (let j = 0; accepted.length < target && j < maxTries; j++) {
        let x: number, y: number;
        if (gaussian) {
          // Box–Muller on the stream; σ = extent/4 keeps ~95% inside the area
          const m = Math.sqrt(-2 * Math.log(Math.max(latticeHash(j, 1, seed), 1e-9)));
          const a = latticeHash(j, 2, seed) * Math.PI * 2;
          x = m * Math.cos(a) * (w / 4);
          y = m * Math.sin(a) * (h / 4);
          if (Math.abs(x) > w / 2 || Math.abs(y) > h / 2) continue;
        } else {
          x = (latticeHash(j, 1, seed) - 0.5) * w;
          y = (latticeHash(j, 2, seed) - 0.5) * h;
        }
        if (poisson && accepted.some((p) => Math.hypot(p.x - x, p.y - y) < spacing)) continue;
        accepted.push({ x, y });
      }
      // the mask trims the finished set, so the prescribed spacing holds
      // inside it and points that were already in-mask stay put when one is
      // wired — survivors are renumbered as a clean run
      const kept = inMask ? accepted.filter((p) => inMask(p.x, p.y)) : accepted;
      const placements: Placement[] = kept.map((p, i) => ({
        x: p.x,
        y: p.y,
        rotation: 0,
        scale: 1,
        progress: kept.length === 1 ? 0 : i / (kept.length - 1),
        weight: 1,
        index: i,
      }));
      return { out: { kind: 'layout', placements } satisfies LayoutValue };
    }

    const off = Number(params.offset), rot = Number(params.rotate), sj = Number(params.scaleJitter);
    const placements = upstream.placements.map((p, i) => {
      // masked jitter constrains movement, not existence: take the first
      // offset that stays inside, else stay put. Try 0 matches the unmasked
      // roll, so wiring a mask never moves a point that was already legal
      let x = p.x, y = p.y;
      for (let k = 0; k < 8; k++) {
        const nx = p.x + (latticeHash(i, 11 + 30 * k, seed) - 0.5) * 2 * off;
        const ny = p.y + (latticeHash(i, 12 + 30 * k, seed) - 0.5) * 2 * off;
        if (!inMask || inMask(nx, ny)) { x = nx; y = ny; break; }
      }
      return {
        ...p,
        x,
        y,
        rotation: p.rotation + (latticeHash(i, 13, seed) - 0.5) * 2 * rot,
        scale: p.scale * (1 + (latticeHash(i, 14, seed) - 0.5) * 2 * sj),
      };
    });
    // jitter moves points; a ring is still a ring
    return { out: { kind: 'layout', placements, closed: upstream.closed } satisfies LayoutValue };
  },
};

export const SamplePathNode: NodeDef = {
  type: 'SamplePath',
  label: 'Sample Path',
  inputs: [{ name: 'path', type: 'vector' }, MASK_INPUT],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    // gap (arc-length spacing) decides how many points fit; the element lane
    // (via Place) then decides how many of them get filled
    { name: 'gap', kind: 'number', default: 40, min: 1, max: 2000, step: 1 },
    { name: 'offset', kind: 'number', default: 0, min: 0, max: 2000, step: 1 },
    { name: 'tangent', kind: 'select', options: ['rotate', 'upright'], default: 'rotate' },
  ],
  async cook(inputs, params, ctx) {
    const vector = inputs.path as VectorValue;
    const inMask = await maskTest(inputs.mask as RasterValue | AlphaValue | undefined, ctx);
    const polys = flattenPaths(vector.paths);
    const samples = samplePathEvenly(polys, Number(params.gap), Number(params.offset));
    // The path lives in its source space (a traced image is in top-left frame
    // pixels), but layouts are origin-at-center like Grid/Function/Random — and
    // the element renderer treats (0,0) as the artboard center. Recenter on the
    // path's bounds center (as Rasterize does for vectors) so the arrangement
    // sits where the shape sits instead of being pushed off the artboard.
    const b = vector.bounds;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // spacing is gap-driven, so the mask trims samples rather than re-spacing
    // them; progress keeps the true arc position on the source path
    const kept = samples
      .map((s) => ({ ...s, x: s.x - cx, y: s.y - cy }))
      .filter((s) => !inMask || inMask(s.x, s.y));
    // a loop layout (every contour closed, like a silhouette outline) lets Place
    // spread elements across the closing segment too, with no seam. A mask that
    // trimmed anything cut the loop open.
    const closed = polys.length > 0 && polys.every((p) => p.closed) && kept.length === samples.length;
    const placements: Placement[] = kept.map((s, i) => ({
      x: s.x,
      y: s.y,
      rotation: params.tangent === 'rotate' ? s.rotation : 0,
      scale: 1,
      progress: s.t, // arc-length position
      weight: 1,
      index: i,
    }));
    return { out: { kind: 'layout', placements, closed } satisfies LayoutValue };
  },
};

export const FunctionLayoutNode: NodeDef = {
  type: 'Function',
  label: 'Math Function',
  inputs: [MASK_INPUT],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'fn', kind: 'select', options: ['circle', 'spiral', 'wave'], default: 'circle' },
    // arc-length spacing between slots — the curve's own geometry (radius,
    // turns, width) fixes its length, the gap decides how many slots fit
    { name: 'gap', kind: 'number', default: 40, min: 1, max: 2000, step: 1 },
    { name: 'radius', kind: 'number', default: 200, min: 1, max: 1000, step: 1 },
    { name: 'turns', kind: 'number', default: 3, min: 0.25, max: 12, step: 0.25 },
    { name: 'width', kind: 'number', default: 600, min: 10, max: 4096, step: 1, showIf: { param: 'fn', in: ['wave'] } },
  ],
  async cook(inputs, params, ctx) {
    const gap = Number(params.gap ?? 40);
    const r = Number(params.radius), turns = Number(params.turns), width = Number(params.width ?? 600);
    const inMask = await maskTest(inputs.mask as RasterValue | AlphaValue | undefined, ctx);
    const circle = params.fn === 'circle';

    // the curve as a function of u ∈ [0,1]
    const pointAt = (u: number): { x: number; y: number } => {
      switch (params.fn) {
        case 'spiral': {
          const a = turns * Math.PI * 2 * u;
          return { x: Math.cos(a) * r * u, y: Math.sin(a) * r * u };
        }
        case 'wave':
          return { x: (u - 0.5) * width, y: Math.sin(u * turns * Math.PI * 2) * r * 0.25 };
        default: {
          const a = u * Math.PI * 2 - Math.PI / 2;
          return { x: Math.cos(a) * r, y: Math.sin(a) * r };
        }
      }
    };

    // flatten the curve and reuse the path sampler — same contract as Sample
    // Path (gap decides how many fit, rotation is the tangent, progress the
    // arc position), this node just supplies its own path
    const M = 4096; // ≤ ~10px segments even on a 12-turn spiral at max radius
    const points = Array.from({ length: circle ? M : M + 1 }, (_, j) => pointAt(j / M));
    const samples = samplePathEvenly([{ points, closed: circle }], gap);
    // spacing is gap-driven, so the mask trims samples rather than re-spacing
    // them; progress keeps the true arc position on the curve
    const kept = samples.filter((s) => !inMask || inMask(s.x, s.y));
    const placements: Placement[] = kept.map((s, i) => ({
      x: s.x,
      y: s.y,
      rotation: s.rotation,
      scale: 1,
      progress: s.t, // arc-length position
      weight: 1,
      index: i,
    }));
    // a circle is a loop by construction — spread should wrap, not seam.
    // A mask that trimmed any of it cut the loop open
    const closed = circle && kept.length === samples.length ? true : undefined;
    return { out: { kind: 'layout', placements, closed } satisfies LayoutValue };
  },
};

/**
 * Weight — the deliberate author of the signal channels. Computes one signal
 * per slot and writes it to the channel *named after its source* — a
 * Weight(noise) writes `channels.noise`, Weight(image luma) writes
 * `channels['image luma']` — so wiring several Weights in a row stacks several
 * independent signals on the same slots, no naming step needed. Two Weights
 * with the same source overwrite each other (nearest author wins). Geometry,
 * progress, index, and the generator's built-in weight are never touched.
 */
export const WeightNode: NodeDef = {
  type: 'Weight',
  inputs: [
    { name: 'layout', type: 'layout' },
    // sampled under each slot by the `image` source
    { name: 'map', type: 'raster', optional: true },
  ],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'source', kind: 'select', options: ['noise', 'image luma', 'image alpha', 'image sat', 'progress', 'area', 'distance', 'expression'], default: 'noise' },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1, showIf: { param: 'source', in: ['noise'] } },
    // vars: i (slot), n (count), progress (alias t), x, y, w (the built-in
    // weight — the generator's density signal); consts pi, tau, e, phi
    { name: 'expr', kind: 'string', default: '1 - progress', showIf: { param: 'source', in: ['expression'] } },
  ],
  async cook(inputs, params, ctx) {
    const layout = inputs.layout as LayoutValue;
    const src = layout.placements;
    const seed = Number(params.seed);
    const n = src.length;
    // the channel is named after the source — no naming step
    const target = String(params.source ?? 'noise');
    // the channel's incoming value (error fallback; 1 when unwritten)
    const current = (p: Placement) => p.channels?.[target] ?? 1;

    let weightOf: (p: Placement, i: number) => number;
    switch (params.source) {
      case 'image': // legacy documents — 'image' predates the split, means luma
      case 'image luma':
      case 'image alpha':
      case 'image sat': {
        const map = inputs.map as RasterValue | undefined;
        if (!map) throw new Error('Weight: the image sources need a map input');
        if (!ctx.gpu) throw new Error('Weight: the image sources need a GPU context');
        const img = await ctx.gpu.readback(map.texture);
        // layouts are origin-at-center; the map is sampled center-aligned
        const sample = (p: Placement): number => {
          const px = Math.min(img.width - 1, Math.max(0, Math.round(p.x + img.width / 2)));
          const py = Math.min(img.height - 1, Math.max(0, Math.round(p.y + img.height / 2)));
          return (py * img.width + px) * 4;
        };
        if (params.source === 'image alpha') {
          // coverage — behind Remove Background this is the subject silhouette
          weightOf = (p) => img.data[sample(p) + 3] / 255;
        } else if (params.source === 'image sat') {
          // HSV saturation: colorfulness, independent of brightness
          weightOf = (p) => {
            const o = sample(p);
            const mx = Math.max(img.data[o], img.data[o + 1], img.data[o + 2]);
            const mn = Math.min(img.data[o], img.data[o + 1], img.data[o + 2]);
            return mx === 0 ? 0 : (mx - mn) / mx;
          };
        } else {
          // Rec. 709 luminance — white 1, black 0
          weightOf = (p) => {
            const o = sample(p);
            return (0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]) / 255;
          };
        }
        break;
      }
      case 'progress':
        weightOf = (p) => p.progress;
        break;
      case 'area': {
        // cell area normalized to the biggest cell; point layouts have no
        // area signal and stay neutral
        const amax = Math.max(...src.map((p) => (p.w ?? 0) * (p.h ?? 0)));
        weightOf = (p) => (amax > 0 ? ((p.w ?? 0) * (p.h ?? 0)) / amax : 1);
        break;
      }
      case 'distance': {
        // radial falloff from the layout origin (= artboard center), scale-free:
        // normalized by the farthest slot, so 1 at center, 0 at the rim
        const dmax = Math.max(...src.map((p) => Math.hypot(p.x, p.y)), 1e-6);
        weightOf = (p) => 1 - Math.hypot(p.x, p.y) / dmax;
        break;
      }
      case 'expression': {
        try {
          const fn = compileExpr(String(params.expr ?? ''), ['i', 'n', 'progress', 't', 'x', 'y', 'w']);
          weightOf = (p, i) => {
            const v = fn({ i, n, progress: p.progress, t: p.progress, x: p.x, y: p.y, w: p.weight });
            return Number.isFinite(v) ? v : current(p);
          };
        } catch {
          weightOf = current; // broken expression: leave the channel alone
        }
        break;
      }
      default: // noise
        weightOf = (_p, i) => latticeHash(i, 9, seed);
    }

    // no shaping here — inverting/biasing the signal is Place's job (per bind)
    const placements = src.map((p, i) => (
      { ...p, channels: { ...p.channels, [target]: weightOf(p, i) } }
    ));
    return { out: { kind: 'layout', placements, closed: layout.closed } satisfies LayoutValue };
  },
};

/**
 * Filter — the only lane node that deletes slots. Reads the channels, never
 * writes them: survivors keep their index (identity), progress, and weight,
 * so downstream by-index Place and channel binds still see the original run.
 */
export const FilterLayoutNode: NodeDef = {
  type: 'Filter',
  inputs: [{ name: 'layout', type: 'layout' }],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'mode', kind: 'select', options: ['every-nth', 'threshold', 'random'], default: 'every-nth' },
    { name: 'n', kind: 'number', default: 2, min: 1, max: 32, step: 1, showIf: { param: 'mode', in: ['every-nth'] } },
    // same mechanism as Place's binds: the editor offers the built-ins plus
    // the channels this document's Weights write; an unwritten name reads 1
    { name: 'channel', kind: 'channel', default: 'weight', showIf: { param: 'mode', in: ['threshold'] } },
    { name: 'comparison', kind: 'select', options: ['above', 'below'], default: 'above', showIf: { param: 'mode', in: ['threshold'] } },
    { name: 'threshold', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01, showIf: { param: 'mode', in: ['threshold'] } },
    { name: 'keep', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01, showIf: { param: 'mode', in: ['random'] } },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1, showIf: { param: 'mode', in: ['random'] } },
  ],
  cook(inputs, params) {
    const layout = inputs.layout as LayoutValue;
    const placements = layout.placements.filter((p, i) => {
      switch (params.mode) {
        case 'threshold': {
          const v = readChannel(p, String(params.channel));
          return params.comparison === 'below' ? v < Number(params.threshold) : v >= Number(params.threshold);
        }
        case 'random':
          return latticeHash(i, 5, Number(params.seed)) < Number(params.keep);
        default:
          return i % Math.round(Number(params.n)) === 0;
      }
    });
    return { out: { kind: 'layout', placements, closed: layout.closed } satisfies LayoutValue };
  },
};

export const DrawLayoutNode: NodeDef = {
  type: 'DrawLayout',
  label: 'Draw Layout',
  inputs: [{ name: 'layout', type: 'layout' }],
  outputs: [{ name: 'out', type: 'vector' }],
  params: [{ name: 'size', kind: 'number', default: 8, min: 1, max: 64, step: 1 }],
  cook(inputs, params) {
    const size = Number(params.size);
    const paths: PathCmd[][] = [];
    const dot = (x: number, y: number, r: number) => {
      const circle: { x: number; y: number }[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        circle.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
      }
      paths.push(...polylinesToPaths([{ points: circle, closed: true }]));
    };
    for (const p of (inputs.layout as LayoutValue).placements) {
      if (p.w != null && p.h != null) {
        // cell placements draw as their actual rect (rotated with the
        // placement) plus a small center dot — the grid, not dot indicators
        const cos = Math.cos(p.rotation), sin = Math.sin(p.rotation);
        const corners = [[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2]]
          .map(([dx, dy]) => ({ x: p.x + dx * cos - dy * sin, y: p.y + dx * sin + dy * cos }));
        paths.push(...polylinesToPaths([{ points: corners, closed: true }]));
        dot(p.x, p.y, size * 0.35);
        continue;
      }
      const r = size * p.scale * (0.35 + 0.65 * p.weight);
      // circle marker (octagon is plenty at marker size)
      dot(p.x, p.y, r);
      // rotation tick
      paths.push([
        { type: 'M', x: p.x, y: p.y },
        { type: 'L', x: p.x + Math.cos(p.rotation) * r * 2, y: p.y + Math.sin(p.rotation) * r * 2 },
      ]);
    }
    const value: VectorValue = { kind: 'vector', paths, bounds: boundsOfPaths(paths) };
    return { out: value };
  },
};
