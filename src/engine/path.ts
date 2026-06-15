// Path geometry utilities shared by the vector ops. The vector ops that bend
// geometry (Displace, Warp, Boolean) flatten curves to polylines first —
// per-point operations on cubics would distort unevenly along the curve.

import type { PathCmd, Rect, Transform2D } from './values';

export interface Pt {
  x: number;
  y: number;
}

export interface Polyline {
  points: Pt[];
  closed: boolean;
}

/** Flatten command lists to polylines. `step` is the target px between samples. */
export function flattenPaths(paths: PathCmd[][], step = 2.5): Polyline[] {
  const out: Polyline[] = [];
  for (const cmds of paths) {
    let cur: Pt[] | null = null;
    let pen: Pt = { x: 0, y: 0 };
    const finish = (closed: boolean) => {
      if (cur && cur.length > 1) out.push({ points: cur, closed });
      cur = null;
    };
    for (const cmd of cmds) {
      switch (cmd.type) {
        case 'M':
          finish(false);
          pen = { x: cmd.x, y: cmd.y };
          cur = [pen];
          break;
        case 'L': {
          pen = { x: cmd.x, y: cmd.y };
          cur?.push(pen);
          break;
        }
        case 'C': {
          const n = sampleCount([pen, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }, { x: cmd.x, y: cmd.y }], step);
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            cur?.push(cubicAt(pen, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }, { x: cmd.x, y: cmd.y }, t));
          }
          pen = { x: cmd.x, y: cmd.y };
          break;
        }
        case 'Q': {
          const n = sampleCount([pen, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x, y: cmd.y }], step);
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            cur?.push(quadAt(pen, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x, y: cmd.y }, t));
          }
          pen = { x: cmd.x, y: cmd.y };
          break;
        }
        case 'Z':
          finish(true);
          break;
      }
    }
    finish(false);
  }
  return out;
}

/** Polylines back to M/L/Z command lists (one list per polyline). */
export function polylinesToPaths(polys: Polyline[]): PathCmd[][] {
  return polys.map((poly) => {
    const cmds: PathCmd[] = [{ type: 'M', x: poly.points[0].x, y: poly.points[0].y }];
    for (let i = 1; i < poly.points.length; i++) {
      cmds.push({ type: 'L', x: poly.points[i].x, y: poly.points[i].y });
    }
    if (poly.closed) cmds.push({ type: 'Z' });
    return cmds;
  });
}

export function boundsOfPaths(paths: PathCmd[][]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const path of paths) {
    for (const cmd of path) {
      if (cmd.type === 'Z') continue;
      visit(cmd.x, cmd.y);
      // control points overestimate slightly; fine as a working bound
      if (cmd.type === 'C') { visit(cmd.x1, cmd.y1); visit(cmd.x2, cmd.y2); }
      if (cmd.type === 'Q') visit(cmd.x1, cmd.y1);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Apply a TRS transform to every coordinate (anchor and control points alike). */
export function transformPaths(paths: PathCmd[][], t: Transform2D): PathCmd[][] {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const tx = (x: number, y: number) => t.x + t.scale * (c * x - s * y);
  const ty = (x: number, y: number) => t.y + t.scale * (s * x + c * y);
  return paths.map((cmds) =>
    cmds.map((cmd): PathCmd => {
      switch (cmd.type) {
        case 'M': return { type: 'M', x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y) };
        case 'L': return { type: 'L', x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y) };
        case 'C': return {
          type: 'C',
          x1: tx(cmd.x1, cmd.y1), y1: ty(cmd.x1, cmd.y1),
          x2: tx(cmd.x2, cmd.y2), y2: ty(cmd.x2, cmd.y2),
          x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y),
        };
        case 'Q': return {
          type: 'Q',
          x1: tx(cmd.x1, cmd.y1), y1: ty(cmd.x1, cmd.y1),
          x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y),
        };
        case 'Z': return { type: 'Z' };
      }
    }),
  );
}

/**
 * Sample points (with tangent angle) along flattened paths, spanning subpaths
 * as one run. `gap` is the arc-length spacing between samples; the count of
 * points follows from how many fit in the path's length. The run is centered
 * along the path (like Grid/Function center their output), so changing `gap`
 * moves every sample — none is pinned to the path's start. `offset` then slides
 * the whole run along the arc. Distances wrap around the run, so offset rotates
 * the pattern; a gap that doesn't divide the length evenly drops the remainder.
 */
export function samplePathEvenly(
  polys: Polyline[],
  gap: number,
  offset = 0,
): { x: number; y: number; rotation: number; t: number }[] {
  type Seg = { ax: number; ay: number; bx: number; by: number; len: number };
  const segs: Seg[] = [];
  for (const poly of polys) {
    const pts = poly.closed ? [...poly.points, poly.points[0]] : poly.points;
    for (let i = 1; i < pts.length; i++) {
      const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (len > 0) segs.push({ ax: pts[i - 1].x, ay: pts[i - 1].y, bx: pts[i].x, by: pts[i].y, len });
    }
  }
  const total = segs.reduce((sum, s) => sum + s.len, 0);
  if (total === 0 || segs.length === 0 || gap <= 0) return [];

  const count = Math.max(1, Math.floor(total / gap)); // spacing drives how many fit
  const mid = (count - 1) / 2; // center the run so no sample is pinned to the start
  const out: { x: number; y: number; rotation: number; t: number }[] = [];
  for (let i = 0; i < count; i++) {
    const dist = offset + (i - mid) * gap;
    const target = ((dist % total) + total) % total; // wrap into [0, total)
    let segIdx = 0, walked = 0;
    while (segIdx < segs.length - 1 && walked + segs[segIdx].len < target) {
      walked += segs[segIdx].len;
      segIdx++;
    }
    const seg = segs[segIdx];
    const local = seg.len === 0 ? 0 : (target - walked) / seg.len;
    out.push({
      x: seg.ax + (seg.bx - seg.ax) * local,
      y: seg.ay + (seg.by - seg.ay) * local,
      rotation: Math.atan2(seg.by - seg.ay, seg.bx - seg.ax),
      t: target / total,
    });
  }
  return out;
}

function sampleCount(controls: Pt[], step: number): number {
  let len = 0;
  for (let i = 1; i < controls.length; i++) {
    len += Math.hypot(controls[i].x - controls[i - 1].x, controls[i].y - controls[i - 1].y);
  }
  return Math.min(64, Math.max(1, Math.ceil(len / step)));
}

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

function quadAt(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}
