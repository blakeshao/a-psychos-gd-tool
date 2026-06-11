// Path geometry utilities shared by the vector ops. The vector ops that bend
// geometry (Displace, Warp, Boolean) flatten curves to polylines first —
// per-point operations on cubics would distort unevenly along the curve.

import type { PathCmd, Rect } from './values';

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
