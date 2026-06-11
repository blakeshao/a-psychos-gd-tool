// Renders an ordered list of elements onto an artboard texture, in z-order.
// Vector/text elements batch into OffscreenCanvas layers (the browser is the
// tessellator, as in Rasterize); raster elements draw as transformed quads
// sampling their texture directly — no readback, no detour through vector.

import type { Font } from 'opentype.js';
import type { Element, PathCmd } from '../engine/values';
import { appendPath } from '../nodes/rasterize';
import type { GpuContext } from './device';
import type { PooledTexture } from './pool';

/** artboard-covering layer: local px (0..W, 0..H) -> clip */
function fullscreenCoeffs(W: number, H: number): Float32Array<ArrayBuffer> {
  return new Float32Array([2 / W, 0, 0, -2 / H, -1, 1, W, H]);
}

/** content px through the element TRS (centered anchor, artboard origin at center) -> clip */
function elementCoeffs(el: Element, w: number, h: number, W: number, H: number): Float32Array<ArrayBuffer> {
  const t = el.transform;
  const cs = Math.cos(t.rotation) * t.scale;
  const sn = Math.sin(t.rotation) * t.scale;
  const ax = w / 2, ay = h / 2;
  return new Float32Array([
    cs / (W / 2), -sn / (W / 2),
    -sn / (H / 2), -cs / (H / 2),
    (t.x - cs * ax + sn * ay) / (W / 2),
    -(t.y - sn * ax - cs * ay) / (H / 2),
    w, h,
  ]);
}

export function renderElements(
  gpu: GpuContext,
  fonts: Map<string, Font>,
  items: Element[],
  width: number,
  height: number,
  background: { r: number; g: number; b: number; a: number },
): PooledTexture {
  const dst = gpu.pool.acquire(width, height);
  gpu.clear(dst, background);

  let canvas: OffscreenCanvas | null = null;
  let c2d: OffscreenCanvasRenderingContext2D | null = null;

  const flush = () => {
    if (!canvas) return;
    const tmp = gpu.pool.acquire(width, height);
    gpu.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: tmp.texture }, { width, height });
    gpu.drawQuad(tmp, dst, fullscreenCoeffs(width, height));
    gpu.pool.release(tmp);
    canvas = null;
    c2d = null;
  };

  for (const el of items) {
    if (el.content.kind === 'raster') {
      flush(); // keep z-order: pending vector layer goes down first
      gpu.drawQuad(el.content.texture, dst, elementCoeffs(el, el.content.width, el.content.height, width, height));
      continue;
    }

    if (!canvas) {
      canvas = new OffscreenCanvas(width, height);
      c2d = canvas.getContext('2d')!;
    }
    const t = el.transform;
    const cs = Math.cos(t.rotation) * t.scale;
    const sn = Math.sin(t.rotation) * t.scale;
    c2d!.setTransform(cs, sn, -sn, cs, width / 2 + t.x, height / 2 + t.y);

    const p = new Path2D();
    if (el.content.kind === 'vector') {
      for (const path of el.content.paths) appendPath(p, path);
    } else {
      const font = fonts.get(el.content.fontKey);
      if (!font) throw new Error(`font not loaded: ${el.content.fontKey}`);
      for (const g of el.content.glyphs) {
        appendPath(p, font.glyphs.get(g.glyphId).getPath(g.x, g.y, el.content.fontSize).commands as PathCmd[]);
      }
    }
    c2d!.fillStyle = '#000000';
    c2d!.fill(p);
  }
  flush();
  return dst;
}
