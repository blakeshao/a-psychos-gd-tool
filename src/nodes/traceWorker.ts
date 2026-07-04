// Web Worker for the CPU-heavy raster work, kept off the main thread so the UI
// never freezes:
//  - trace ops (composite / sobel / silhouette): imagetracer raster→vector
//  - removebg: subject segmentation (RMBG-1.4 via Transformers.js) → masked image
//
// Two speedups live here:
//  1. Tracing runs at a capped resolution (the artboard is often ~8MP, where
//     full-res tracing takes seconds); paths are scaled back up afterwards.
//  2. The model runs on the WebGPU backend when available (far faster than WASM).

import ImageTracer from 'imagetracerjs';
import type { PathCmd } from '../engine/values';

// longest side the tracer/model ever sees. tracing scales linearly-ish in pixel
// count, so capping an 8MP artboard to ~1MP is a several-fold speedup.
const TRACE_CAP = 1024;
const MODEL_ID = 'briaai/RMBG-1.4';

interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Req {
  id: number;
  // composite/sobel: trace image content. silhouette: trace the alpha shape.
  // removebg: segment the subject and return the image with the bg cut out.
  op: 'composite' | 'sobel' | 'silhouette' | 'removebg';
  width: number;
  height: number;
  data: ArrayBuffer; // rgba pixels, transferred
  smoothness: number;
  minArea: number;
  threshold: number;
  dropLight: boolean;
  thickness?: number; // silhouette op: outline band width, in (capped) pixels
}

// `self.postMessage` in a worker takes (message, transfer); the DOM-typed global
// disagrees, so post through a narrowly-typed handle.
const post = (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage.bind(self);

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    const img: Img = {
      data: new Uint8ClampedArray(req.data),
      width: req.width,
      height: req.height,
    };
    if (req.op === 'removebg') {
      const out = await removeBackground(img);
      post({ id: req.id, image: out }, [out.data.buffer]);
    } else {
      post({ id: req.id, paths: traceRaster(img, req) });
    }
  } catch (err) {
    post({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
};

// trace a capped copy of the image, then scale the paths back to source res.
//  - composite: ink-on-transparent flattened over white (traces dark content)
//  - sobel: edge-detected line map
//  - silhouette: a hollow outline of the alpha shape (see silhouetteOutline)
function traceRaster(img: Img, req: Req): PathCmd[][] {
  const small = downscale(img, TRACE_CAP);
  const sx = img.width / small.width;
  const sy = img.height / small.height;
  if (req.op === 'silhouette') {
    return scalePaths(silhouetteOutline(small, req), sx, sy);
  }
  if (req.op === 'sobel') sobelEdges(small, req.threshold);
  else compositeOverWhite(small);
  return scalePaths(imageToPaths(small, req.smoothness, req.minArea, req.dropLight), sx, sy);
}

// A hollow outline of the image's alpha shape: trace the shape's contour, trace
// the shape eroded by `thickness`, and reverse the inner contour. Combined under
// a nonzero-winding fill the inner loop subtracts, leaving a ring `thickness`
// wide — a true outline, not a fill. (Reversing is what makes it reliably hollow:
// imagetracer doesn't guarantee the inner edge winds opposite to the outer.)
function silhouetteOutline(small: Img, req: Req): PathCmd[][] {
  const { width: w, height: h } = small;
  const fg = alphaForeground(small, req.threshold);

  let inner = fg;
  const t = Math.max(1, Math.round(req.thickness ?? 6));
  for (let i = 0; i < t; i++) inner = erode(inner, w, h);

  const outer = traceBitmap(fg, w, h, req.smoothness, req.minArea);
  const hole = traceBitmap(inner, w, h, req.smoothness, req.minArea).map(reversePath);
  return [...outer, ...hole];
}

// trace a foreground bitmap (painted as black ink on white) into closed paths.
function traceBitmap(fg: Uint8Array, w: number, h: number, smoothness: number, minArea: number): PathCmd[][] {
  const img: Img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  paintInk(img, fg);
  return imageToPaths(img, smoothness, minArea, true);
}

// reverse a closed sub-path's direction (flips its winding). curve controls ride
// with the segment that arrives at each vertex, so they move with it.
function reversePath(cmds: PathCmd[]): PathCmd[] {
  type Vert = {
    x: number;
    y: number;
    q?: { x1: number; y1: number };
    c?: { x1: number; y1: number; x2: number; y2: number };
  };
  const verts: Vert[] = [];
  let closed = false;
  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'M':
      case 'L':
        verts.push({ x: cmd.x, y: cmd.y });
        break;
      case 'Q':
        verts.push({ x: cmd.x, y: cmd.y, q: { x1: cmd.x1, y1: cmd.y1 } });
        break;
      case 'C':
        verts.push({ x: cmd.x, y: cmd.y, c: { x1: cmd.x1, y1: cmd.y1, x2: cmd.x2, y2: cmd.y2 } });
        break;
      case 'Z':
        closed = true;
        break;
    }
  }
  if (verts.length === 0) return cmds;

  const last = verts[verts.length - 1];
  const out: PathCmd[] = [{ type: 'M', x: last.x, y: last.y }];
  for (let i = verts.length - 1; i > 0; i--) {
    const from = verts[i]; // original segment was verts[i-1] -> verts[i]
    const to = verts[i - 1];
    if (from.q) out.push({ type: 'Q', x1: from.q.x1, y1: from.q.y1, x: to.x, y: to.y });
    else if (from.c) out.push({ type: 'C', x1: from.c.x2, y1: from.c.y2, x2: from.c.x1, y2: from.c.y1, x: to.x, y: to.y });
    else out.push({ type: 'L', x: to.x, y: to.y });
  }
  if (closed) out.push({ type: 'Z' });
  return out;
}

// removebg: the model decides foreground; multiply its mask into the image's
// alpha so the background becomes transparent. colors are kept at full res.
async function removeBackground(img: Img): Promise<Img> {
  const { run, RawImage } = await loadModel();

  // the model wants an opaque photo — infer on a capped, white-composited copy
  const small = downscale(img, TRACE_CAP);
  const infer: Img = { data: new Uint8ClampedArray(small.data), width: small.width, height: small.height };
  compositeOverWhite(infer);
  const mask = await run(new RawImage(infer.data, infer.width, infer.height, 4).rgb());

  // scale the mask back up and fold it into the original alpha
  const full = resizeMask(mask, img.width, img.height);
  const out = new Uint8ClampedArray(img.data); // keep original colors
  for (let p = 0; p < img.width * img.height; p++) {
    out[p * 4 + 3] = Math.round((out[p * 4 + 3] * full[p]) / 255);
  }
  return { data: out, width: img.width, height: img.height };
}

// foreground = pixels whose alpha clears the threshold (the image's shape).
function alphaForeground(img: Img, threshold: number): Uint8Array {
  const fg = new Uint8Array(img.width * img.height);
  const px = img.data;
  for (let p = 0; p < fg.length; p++) fg[p] = px[p * 4 + 3] >= threshold ? 1 : 0;
  return fg;
}

// paint a foreground bitmap as black ink on a white ground, in place.
function paintInk(img: Img, fg: Uint8Array): void {
  const px = img.data;
  for (let p = 0; p < fg.length; p++) {
    const c = fg[p] ? 0 : 255;
    const o = p * 4;
    px[o] = c;
    px[o + 1] = c;
    px[o + 2] = c;
    px[o + 3] = 255;
  }
}

// expand a 1-channel mask to rgba, resize to w×h via canvas, return its R channel.
function resizeMask(mask: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }, w: number, h: number): Uint8Array {
  const rgba = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let p = 0; p < mask.width * mask.height; p++) {
    const v = mask.data[p];
    const o = p * 4;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  const src = new OffscreenCanvas(mask.width, mask.height);
  src.getContext('2d')!.putImageData(new ImageData(rgba, mask.width, mask.height), 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const dctx = dst.getContext('2d')!;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, w, h);
  const scaled = dctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = scaled[p * 4]; // R channel
  return out;
}

// one step of binary erosion: a foreground pixel survives only if all four of its
// edge-neighbors are foreground (image edge counts as background).
function erode(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!src[p]) continue;
      const left = x > 0 ? src[p - 1] : 0;
      const right = x < w - 1 ? src[p + 1] : 0;
      const up = y > 0 ? src[p - w] : 0;
      const down = y < h - 1 ? src[p + w] : 0;
      if (left && right && up && down) out[p] = 1;
    }
  }
  return out;
}

// ---- image helpers -------------------------------------------------------

// area-averaged downscale so the longest side is at most `cap`. returns the
// image unchanged when it already fits.
function downscale(img: Img, cap: number): Img {
  const longest = Math.max(img.width, img.height);
  if (longest <= cap) return img;
  const scale = cap / longest;
  const nw = Math.max(1, Math.round(img.width * scale));
  const nh = Math.max(1, Math.round(img.height * scale));

  const src = new OffscreenCanvas(img.width, img.height);
  // copy into a fresh ArrayBuffer-backed array for the ImageData constructor
  const srcData = new Uint8ClampedArray(img.data);
  src.getContext('2d')!.putImageData(new ImageData(srcData, img.width, img.height), 0, 0);

  const dst = new OffscreenCanvas(nw, nh);
  const dctx = dst.getContext('2d')!;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, nw, nh);
  const scaled = dctx.getImageData(0, 0, nw, nh);
  return { data: scaled.data, width: nw, height: nh };
}

// rasters are ink on a transparent ground — flatten onto white paper so the
// tracer (or model) sees opaque ink-vs-paper, then force alpha opaque. in place.
function compositeOverWhite(img: Img): void {
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    px[i] = Math.round(255 * (1 - a) + px[i] * a);
    px[i + 1] = Math.round(255 * (1 - a) + px[i + 1] * a);
    px[i + 2] = Math.round(255 * (1 - a) + px[i + 2] * a);
    px[i + 3] = 255;
  }
}

// Sobel edge detection over the (white-composited) luminance, thresholded into a
// black-on-white line map. in place.
function sobelEdges(img: Img, threshold: number): void {
  const { width: w, height: h, data: px } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const a = px[i + 3] / 255;
    const r = 255 * (1 - a) + px[i] * a;
    const g = 255 * (1 - a) + px[i + 1] * a;
    const b = 255 * (1 - a) + px[i + 2] * a;
    lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const sample = (x: number, y: number) =>
    lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = sample(x - 1, y - 1);
      const tc = sample(x, y - 1);
      const tr = sample(x + 1, y - 1);
      const ml = sample(x - 1, y);
      const mr = sample(x + 1, y);
      const bl = sample(x - 1, y + 1);
      const bc = sample(x, y + 1);
      const br = sample(x + 1, y + 1);
      const gx = tl + 2 * ml + bl - tr - 2 * mr - br;
      const gy = tl + 2 * tc + tr - bl - 2 * bc - br;
      const mag = Math.sqrt(gx * gx + gy * gy);
      const o = (y * w + x) * 4;
      const c = mag >= threshold ? 0 : 255;
      px[o] = c;
      px[o + 1] = c;
      px[o + 2] = c;
      px[o + 3] = 255;
    }
  }
}

// imagetracer over a flat, opaque, 2-tone image → closed vector paths.
function imageToPaths(img: Img, smoothness: number, minArea: number, dropLight: boolean): PathCmd[][] {
  const traced = ImageTracer.imagedataToTracedata(img as unknown as ImageData, {
    ltres: smoothness,
    qtres: smoothness,
    pathomit: minArea,
    numberofcolors: 2,
    colorsampling: 0,
    blurradius: 0,
  });

  const paths: PathCmd[][] = [];
  traced.layers.forEach((layer, li) => {
    const c = traced.palette[li];
    const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    if (dropLight && lum > 0.5) return; // the light layer is the background
    for (const path of layer) {
      if (path.segments.length === 0) continue;
      const cmds: PathCmd[] = [{ type: 'M', x: path.segments[0].x1, y: path.segments[0].y1 }];
      for (const s of path.segments) {
        if (s.type === 'Q' && s.x3 !== undefined && s.y3 !== undefined) {
          cmds.push({ type: 'Q', x1: s.x2, y1: s.y2, x: s.x3, y: s.y3 });
        } else {
          cmds.push({ type: 'L', x: s.x2, y: s.y2 });
        }
      }
      cmds.push({ type: 'Z' });
      paths.push(cmds);
    }
  });
  return paths;
}

// map traced (capped-resolution) coords back onto the source image.
function scalePaths(paths: PathCmd[][], sx: number, sy: number): PathCmd[][] {
  if (sx === 1 && sy === 1) return paths;
  return paths.map((cmds) =>
    cmds.map((c): PathCmd => {
      switch (c.type) {
        case 'M':
        case 'L':
          return { type: c.type, x: c.x * sx, y: c.y * sy };
        case 'Q':
          return { type: 'Q', x1: c.x1 * sx, y1: c.y1 * sy, x: c.x * sx, y: c.y * sy };
        case 'C':
          return {
            type: 'C',
            x1: c.x1 * sx,
            y1: c.y1 * sy,
            x2: c.x2 * sx,
            y2: c.y2 * sy,
            x: c.x * sx,
            y: c.y * sy,
          };
        default:
          return c; // Z
      }
    }),
  );
}

// ---- model ---------------------------------------------------------------

type MaskImage = { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunFn = (image: any) => Promise<MaskImage>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelPromise: Promise<{ run: RunFn; RawImage: any }> | null = null;

function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { AutoModel, AutoProcessor, RawImage, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false; // fetch from the hub, skip local 404 probing

      // prefer the WebGPU backend; fall back to WASM if it isn't available here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const base = { config: { model_type: 'custom' } } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let model: any;
      try {
        model = await AutoModel.from_pretrained(MODEL_ID, { ...base, device: 'webgpu', dtype: 'fp32' });
      } catch {
        model = await AutoModel.from_pretrained(MODEL_ID, base);
      }

      const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
        // RMBG-1.4 preprocessing (the model ships no preprocessor_config.json)
        config: {
          do_normalize: true,
          do_pad: false,
          do_rescale: true,
          do_resize: true,
          image_mean: [0.5, 0.5, 0.5],
          image_std: [1, 1, 1],
          resample: 2,
          rescale_factor: 1 / 255,
          size: { width: 1024, height: 1024 },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const run: RunFn = async (image: any) => {
        const { pixel_values } = await processor(image);
        const result = await model({ input: pixel_values });
        // RMBG returns a single [1,H,W] mask in 0..1 (model's square size)
        const tensor = result.output ?? Object.values(result)[0];
        return RawImage.fromTensor(tensor[0].mul(255).to('uint8')) as MaskImage;
      };
      return { run, RawImage };
    })();
  }
  return modelPromise;
}
