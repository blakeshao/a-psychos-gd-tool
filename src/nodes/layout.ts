// Layout lane: what slots exist + what signal rides on them.
// Generators (Grid, Sample Path, Function, Random) create slots with honest
// channel defaults. None takes a count: each prescribes structure (lattice,
// arc-length gap, density) and how many slots exist falls out — the element
// lane decides how many get filled (elements.ts). Each takes an optional mask
// that bounds its domain: the prescribed structure holds and the mask trims
// slots to its coverage, born as a clean run (unlike Filter, which prunes a
// run that already exists, by signal rather than area). Weight authors the
// weight channel deliberately; Filter prunes slots (the only lane node that
// deletes existing geometry); Jitter adds seeded slop; Shuffle rearranges
// slots without disturbing the tiling. Every modulator leaves index and
// progress alone — they are slot identity, and Place's by-index join is only
// worth anything because nothing rewrites them.
// Ordering is NOT a lane concern — Place owns the element↔slot
// mapping (elements.ts). Draw Layout renders slots as geometry. Channel
// contract: Placement in values.ts.

import { arcCellOutline, boundsOfPaths, flattenPaths, polylinesToPaths, samplePathEvenly } from '../engine/path';
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
      // track identity, so Shuffle can permute whole columns/rows exactly
      // rather than guessing tracks back out of coordinates
      col: c,
      row: r,
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

const DEG = Math.PI / 180;

/**
 * Radial — Grid in polar coordinates: concentric rings of cells. Same bones as
 * Grid (two weighted axes, gaps, stagger, fill order), with x/y swapped for
 * radius/angle — so `distR: fibonacci` gives rings that thicken outward and
 * `distA: custom` gives uneven sectors, both out of the same `axisWeights`.
 *
 * The rings are the picture and the spokes only cut them up: a cell is an
 * annular sector (`arc`), so any spoke count partitions the same rings — 3
 * spokes or 300, the ring the cells add up to is identical, and only the
 * internal cuts move. That is why there is no angular gutter to pair with
 * gapRadial (gapRadial separates whole rings, which is still concentric
 * rings): a gap between sectors would let the spoke count change the picture.
 * Cells also carry the straightened `w`/`h` — the sector's arc extent at its
 * mid radius and its radial thickness, in the slot's own frame — for the
 * consumers that only know rectangles (Slice's window, Shuffle's congruence).
 *
 * No col/row, deliberately: rings and spokes are tracks, but not the separable
 * cartesian kind Shuffle's tracks mode shifts along an axis — permuting them
 * that way would tear the rings apart. Absent keys make that mode a no-op
 * here; `cells` mode still works and is exactly right, because a ring's cells
 * are congruent to each other and to nothing else.
 */
export const RadialNode: NodeDef = {
  type: 'Radial',
  inputs: [MASK_INPUT],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'rings', kind: 'number', default: 4, min: 1, max: 64, step: 1 },
    // how many cells each ring is cut into — the rings look the same either way
    { name: 'spokes', kind: 'number', default: 12, min: 1, max: 256, step: 1 },
    // the annulus the rings subdivide; an inner radius punches the hole out
    { name: 'innerRadius', kind: 'number', default: 0, min: 0, max: 2000, step: 1 },
    { name: 'radius', kind: 'number', default: 300, min: 1, max: 2000, step: 1 },
    // where the rings are centered — layout space is origin-at-center, so 0,0
    // is the artboard's middle and this walks the whole target off it
    { name: 'centerX', kind: 'number', default: 0, min: -2000, max: 2000, step: 1 },
    { name: 'centerY', kind: 'number', default: 0, min: -2000, max: 2000, step: 1 },
    // the gutter between whole rings — a band of paper, still concentric rings
    { name: 'gapRadial', kind: 'number', default: 0, min: 0, max: 600, step: 1 },
    // degrees; -90 starts at 12 o'clock, like Function's circle
    { name: 'startAngle', kind: 'number', default: -90, min: -360, max: 360, step: 1 },
    { name: 'sweep', kind: 'number', default: 360, min: 1, max: 360, step: 1 },
    // track distribution per axis — same generators as Grid
    { name: 'distR', kind: 'select', options: DIST_OPTIONS, default: 'uniform' },
    { name: 'distA', kind: 'select', options: DIST_OPTIONS, default: 'uniform' },
    { name: 'ratioR', kind: 'number', default: 1.618, min: 0.1, max: 5, step: 0.01, showIf: { param: 'distR', in: ['geometric'] } },
    { name: 'ratioA', kind: 'number', default: 1.618, min: 0.1, max: 5, step: 0.01, showIf: { param: 'distA', in: ['geometric'] } },
    { name: 'weightsR', kind: 'string', default: '1,1,2,3,5', showIf: { param: 'distR', in: ['custom'] } },
    { name: 'weightsA', kind: 'string', default: '1,1,2,3,5', showIf: { param: 'distA', in: ['custom'] } },
    { name: 'exprR', kind: 'string', default: '1 + sin(t*pi)', showIf: { param: 'distR', in: ['expression'] } },
    { name: 'exprA', kind: 'string', default: '1 + sin(t*pi)', showIf: { param: 'distA', in: ['expression'] } },
    { name: 'reverseR', kind: 'select', options: ['no', 'yes'], default: 'no', showIf: { param: 'distR', in: NONUNIFORM } },
    { name: 'reverseA', kind: 'select', options: ['no', 'yes'], default: 'no', showIf: { param: 'distA', in: NONUNIFORM } },
    // brick offset, polar: turn every other ring by half a sector
    { name: 'stagger', kind: 'select', options: ['none', 'rings'], default: 'none' },
    // what the slot's rotation means — tangent rides the ring, radial points out
    { name: 'orient', kind: 'select', options: ['tangent', 'radial', 'none'], default: 'tangent' },
    { name: 'flow', kind: 'select', options: ['rings', 'spokes', 'serpentine'], default: 'rings' },
  ],
  async cook(inputs, params, ctx) {
    const inMask = await maskTest(inputs.mask as RasterValue | AlphaValue | undefined, ctx);
    const rings = Math.max(1, Math.round(Number(params.rings)));
    const inner = Math.max(0, Number(params.innerRadius));
    const outer = Math.max(inner, Number(params.radius));
    const gapR = Number(params.gapRadial);
    const cx = Number(params.centerX ?? 0), cy = Number(params.centerY ?? 0);
    const start = Number(params.startAngle) * DEG;
    const sweep = Math.max(0, Math.min(360, Number(params.sweep))) * DEG;
    const full = Math.abs(sweep - Math.PI * 2) < 1e-9;

    // the radial axis is Grid's axis, verbatim: weighted tracks over the
    // annulus, gaps taken out of the span first
    const rTracks = axisTracks(
      axisWeights(rings, String(params.distR), {
        ratio: Number(params.ratioR), list: String(params.weightsR ?? ''),
        expr: String(params.exprR ?? ''), reverse: params.reverseR === 'yes',
      }),
      gapR, outer - inner,
    );

    const spokes = Math.max(1, Math.round(Number(params.spokes)));
    // the angular axis: sectors partition the sweep by weight — cells cover it
    // rather than sampling it, so a 180° fan is half a dial, not a run pinned
    // to both ends. Every ring is cut the same way, so the cuts line up across
    // the rings unless stagger says otherwise
    const aTracks = axisTracks(
      axisWeights(spokes, String(params.distA), {
        ratio: Number(params.ratioA), list: String(params.weightsA ?? ''),
        expr: String(params.exprA ?? ''), reverse: params.reverseA === 'yes',
      }),
      0, sweep,
    );

    const cell = (k: number, c: number): Placement => {
      const r0 = inner + rTracks.centers[k] - rTracks.sizes[k] / 2;
      const r1 = r0 + rTracks.sizes[k];
      const r = (r0 + r1) / 2;
      // stagger turns the odd rings by half of the sector the cell sits in
      const half = params.stagger === 'rings' && k % 2 === 1 ? aTracks.sizes[c] / 2 : 0;
      const a0 = start + aTracks.centers[c] - aTracks.sizes[c] / 2 + half;
      const a1 = a0 + aTracks.sizes[c];
      const theta = (a0 + a1) / 2;
      return {
        x: cx + Math.cos(theta) * r,
        y: cy + Math.sin(theta) * r,
        rotation: params.orient === 'none' ? 0 : params.orient === 'radial' ? theta : theta + Math.PI / 2,
        scale: 1,
        progress: 0,
        weight: 0, // normalized against the biggest cell below
        index: 0,
        // the cell as a sector, and the same cell straightened
        arc: { cx, cy, r0, r1, a0, a1 },
        w: aTracks.sizes[c] * r,
        h: rTracks.sizes[k],
      };
    };

    // emit in fill order — rings walks ring by ring (serpentine reverses the
    // odd ones), spokes walks outward along each spoke
    const placementsInOrder: Placement[] = [];
    if (params.flow === 'spokes') {
      for (let c = 0; c < spokes; c++) for (let k = 0; k < rings; k++) placementsInOrder.push(cell(k, c));
    } else {
      for (let k = 0; k < rings; k++)
        for (let c = 0; c < spokes; c++)
          placementsInOrder.push(cell(k, params.flow === 'serpentine' && k % 2 === 1 ? spokes - 1 - c : c));
    }
    let placements = placementsInOrder;

    // the rings are fixed by the params; the mask decides which cells exist.
    // Masking happens before index/progress, so the slots are born a clean run
    const total = placements.length;
    if (inMask) placements = placements.filter((p) => inMask(p.x, p.y));
    // same density signal as Grid: cell area against the biggest cell
    const maxArea = Math.max(...placements.map((p) => p.w! * p.h!), 0);
    placements.forEach((p, i) => {
      p.index = i;
      p.progress = placements.length === 1 ? 0 : i / (placements.length - 1);
      p.weight = maxArea > 0 ? (p.w! * p.h!) / maxArea : 1;
    });
    // one full ring is a loop, like Function's circle — Place's spread wraps
    // across the closing sector. A mask that trimmed anything cut it open
    const closed = rings === 1 && full && placements.length === total ? true : undefined;
    return { out: { kind: 'layout', placements, closed } satisfies LayoutValue };
  },
};

export const RandomLayoutNode: NodeDef = {
  type: 'Random',
  inputs: [MASK_INPUT],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    // random placements in an area. spacing is the density knob — how many fit
    // follows from area / spacing² (poisson-disk reads it as the min distance
    // and packs until the stream runs dry)
    { name: 'distribution', kind: 'select', options: ['uniform', 'poisson-disk', 'gaussian'], default: 'uniform' },
    { name: 'spacing', kind: 'number', default: 100, min: 10, max: 500, step: 1 },
    { name: 'areaWidth', kind: 'number', default: 600, min: 10, max: 4096, step: 1 },
    { name: 'areaHeight', kind: 'number', default: 400, min: 10, max: 4096, step: 1 },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  ],
  async cook(inputs, params, ctx) {
    const seed = Number(params.seed);
    const inMask = await maskTest(inputs.mask as RasterValue | AlphaValue | undefined, ctx);

    {
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
  },
};

/**
 * Jitter: seeded slop on an existing layout — the modulator half of what used
 * to be Random's wired mode. Split out because a node whose meaning flipped on
 * whether an optional input happened to be wired hid half its behaviour from
 * the palette, and because the two halves compose: Grid → Shuffle → Jitter is
 * a scrambled mosaic with a little slop on top, which one dual-mode node could
 * never express.
 *
 * rotate/scaleJitter overlap Weight(noise) → Place bind, deliberately: these
 * write the SLOT, so Draw Layout shows them and downstream lane nodes see
 * them, where a bind writes the element at the very end. offset has no
 * equivalent at all — position is not a bind target (BIND_TARGETS in
 * elements.ts), and nothing else in the lane is mask-aware while moving.
 */
export const JitterNode: NodeDef = {
  type: 'Jitter',
  inputs: [{ name: 'layout', type: 'layout' }, MASK_INPUT],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    { name: 'offset', kind: 'number', default: 0, min: 0, max: 300, step: 1 },
    { name: 'rotate', kind: 'number', default: 0, min: 0, max: 3.14, step: 0.01 },
    { name: 'scaleJitter', kind: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  ],
  async cook(inputs, params, ctx) {
    const seed = Number(params.seed);
    const upstream = inputs.layout as LayoutValue;
    const inMask = await maskTest(inputs.mask as RasterValue | AlphaValue | undefined, ctx);
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

/** Seeded Fisher-Yates over 0..n-1. salt decorrelates the two axes' draws. */
function permutation(n: number, seed: number, salt: number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(latticeHash(i, salt, seed) * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/**
 * Permute one axis' tracks: each track keeps its size and moves to another
 * track's position. Returns a per-track shift, so a cell's stagger offset
 * (a delta from its track's edge) survives the move untouched.
 *
 * Seamlessness is the point. A flat permutation of non-uniform CELLS is not
 * seamless — under fibonacci or geometric no two cells are congruent, so
 * swapping any two leaves an overlap and a hole. Permuting whole tracks always
 * tiles exactly, because the widths being summed are the same multiset in a
 * different order: the run still ends where it started. The gap sequence stays
 * with the positions rather than the tracks, for the same reason.
 */
function shiftTracks(
  placements: Placement[],
  key: (p: Placement) => number | undefined,
  extent: (p: Placement) => number | undefined,
  pos: (p: Placement) => number,
  seed: number,
  salt: number,
): Map<number, number> | null {
  const tracks = new Map<number, { left: number; size: number }>();
  for (const p of placements) {
    const k = key(p), e = extent(p);
    if (k === undefined || e === undefined) return null; // not a lattice: leave it alone
    const left = pos(p) - e / 2;
    const seen = tracks.get(k);
    // a staggered row shifts its cells off the track edge; the track is the
    // leftmost variant, and every cell keeps its offset from it
    if (!seen) tracks.set(k, { left, size: e });
    else if (left < seen.left) seen.left = left;
  }
  if (tracks.size < 2) return null;

  const order = [...tracks.keys()].sort((a, b) => tracks.get(a)!.left - tracks.get(b)!.left);
  const gaps: number[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    const cur = tracks.get(order[i])!, next = tracks.get(order[i + 1])!;
    gaps.push(next.left - (cur.left + cur.size));
  }

  const perm = permutation(order.length, seed, salt);
  const shift = new Map<number, number>();
  let cursor = tracks.get(order[0])!.left;
  perm.forEach((from, at) => {
    const k = order[from];
    const t = tracks.get(k)!;
    shift.set(k, cursor - t.left);
    cursor += t.size + (gaps[at] ?? 0);
  });
  return shift;
}

/**
 * Shuffle: rearrange a layout's slots without disturbing the tiling.
 *
 * A modulator, like Filter and Jitter — index and progress are slot identity
 * and no node here rewrites them, so a Place in by-index mode still lands
 * element k on slot k, at its new home. That join is what makes Slice's tiles
 * follow the shuffle while staying exactly the size of the cell they land in.
 */
export const ShuffleNode: NodeDef = {
  type: 'Shuffle',
  inputs: [{ name: 'layout', type: 'layout' }],
  outputs: [{ name: 'out', type: 'layout' }],
  params: [
    // tracks: permute whole columns/rows — always seamless, any distribution.
    // cells: permute cells among the cells CONGRUENT to them, which is the
    //   only flat permutation that tiles. On a uniform grid that is every
    //   cell (a full scatter); on a fibonacci one it is only the repeats, so
    //   a strictly-increasing distribution barely moves — use tracks there.
    { name: 'mode', kind: 'select', options: ['tracks', 'cells'], default: 'tracks' },
    { name: 'axes', kind: 'select', options: ['both', 'x', 'y'], default: 'both', showIf: { param: 'mode', in: ['tracks'] } },
    { name: 'seed', kind: 'number', default: 1, min: 0, max: 9999, step: 1 },
  ],
  cook(inputs, params) {
    const upstream = inputs.layout as LayoutValue;
    const seed = Number(params.seed);
    const src = upstream.placements;
    if (src.length < 2) return { out: upstream };

    if (params.mode === 'cells') {
      // congruence classes: same extent, so any permutation within one is an
      // exact swap. Point slots (no extent) form their own class.
      const groups = new Map<string, number[]>();
      src.forEach((p, i) => {
        const k = p.w === undefined || p.h === undefined
          ? 'point'
          : `${Math.round(p.w * 1e3)}x${Math.round(p.h * 1e3)}`;
        const g = groups.get(k);
        if (g) g.push(i); else groups.set(k, [i]);
      });
      const placements = src.map((p) => ({ ...p }));
      let salt = 17;
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const perm = permutation(members.length, seed, salt++);
        // positions move, identity stays: slot i takes the coordinates of the
        // congruent slot the permutation points it at — rotation and cell shape
        // travel with them, because both are properties of where a slot sits (a
        // Radial ring's cells are congruent but each turned to its own sector,
        // and a tangent on a curve is the curve's, not the slot's). On a grid
        // every rotation is 0 and there are no sectors, so this is a no-op there.
        perm.forEach((from, at) => {
          placements[members[at]].x = src[members[from]].x;
          placements[members[at]].y = src[members[from]].y;
          placements[members[at]].rotation = src[members[from]].rotation;
          if (src[members[from]].arc) placements[members[at]].arc = src[members[from]].arc;
        });
      }
      return { out: { kind: 'layout', placements, closed: upstream.closed } satisfies LayoutValue };
    }

    const axes = String(params.axes);
    const dx = axes === 'y' ? null : shiftTracks(src, (p) => p.col, (p) => p.w, (p) => p.x, seed, 31);
    const dy = axes === 'x' ? null : shiftTracks(src, (p) => p.row, (p) => p.h, (p) => p.y, seed, 71);
    if (!dx && !dy) return { out: upstream };

    const placements = src.map((p) => ({
      ...p,
      x: p.x + (dx && p.col !== undefined ? dx.get(p.col) ?? 0 : 0),
      y: p.y + (dy && p.row !== undefined ? dy.get(p.row) ?? 0 : 0),
    }));
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
      if (p.arc) {
        // a polar cell draws as its actual sector, so a ring's cells add back
        // up to the ring however many spokes cut it
        paths.push(...polylinesToPaths([{ points: arcCellOutline(p), closed: true }]));
        dot(p.x, p.y, size * 0.35);
        continue;
      }
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
