// WGSL for the raster pipeline. Every raster op is one fullscreen pass:
// sample the previous render target, write the next (texture ping-pong).

export const FULLSCREEN_VS = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  // one triangle covering the screen
  var corners = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  let p = corners[i];
  var out: VSOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
  return out;
}
`;

// NOTE: no uniform binding here — layout:'auto' strips unused bindings, and a
// bind group entry for a stripped binding is a validation error.
export const BLIT_FS = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}
`;

// Binding convention for every pass: sampler@0, source textures @1..N,
// uniform struct @N+1 (omitted when the shader takes no uniforms).

// Separable gaussian: run twice, dir=(1,0) then dir=(0,1), ping-ponging targets.
// Accumulates premultiplied (transparent-black ground must not darken edges)
// and in linear light (averaging gamma-encoded bytes biases soft edges dark).
// Taps run out to 3 sigma so the halo fades to nothing instead of stepping
// off at the kernel cut — a 2-sigma cut leaves ~13% weight, a visible rim.
export const BLUR_FS = /* wgsl */ `
struct BlurU {
  dir: vec2f,
  radius: f32,
  _pad: f32,
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: BlurU;

fn srgb2lin(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }
fn lin2srgb(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)); }

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(tex));
  if (u.radius <= 0.0) {
    return textureSample(tex, samp, in.uv);
  }
  let sigma = max(u.radius * 0.5, 1.0);
  let reach = ceil(sigma * 3.0);
  // radius is uncapped, taps are not: past 64 per side, widen the stride
  // instead of the loop. Strides stay whole texels — bilinear between texels
  // would re-mix transparent black into edges (straight-alpha filtering).
  let stride = max(1.0, ceil(reach / 64.0));
  let taps = i32(reach / stride);
  var sum = vec4f(0.0);
  var wsum = 0.0;
  for (var i = -taps; i <= taps; i++) {
    let o = f32(i) * stride;
    let w = exp(-(o * o) / (2.0 * sigma * sigma));
    let c = textureSample(tex, samp, in.uv + o * u.dir * texel);
    sum += vec4f(srgb2lin(c.rgb) * c.a, c.a) * w;
    wsum += w;
  }
  let p = sum / wsum;
  return vec4f(lin2srgb(p.rgb / max(p.a, 1e-5)), p.a);
}
`;

// Ordered (Bayer 4x4) per-channel quantization.
export const DITHER_FS = /* wgsl */ `
struct DitherU { levels: f32, scale: f32, _p2: f32, _p3: f32 }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: DitherU;

var<private> BAYER: array<f32, 16> = array<f32, 16>(
  0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  // quantize the color as seen on white paper; alpha passes through
  let ink = mix(vec3f(1.0), c.rgb, c.a);
  let cell = vec2i(in.pos.xy / max(u.scale, 1.0)) % vec2i(4, 4);
  let t = (BAYER[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;
  let n = max(u.levels - 1.0, 1.0);
  let q = floor((ink + vec3f(t / n)) * n + 0.5) / n;
  return vec4f(clamp(q, vec3f(0.0), vec3f(1.0)), c.a);
}
`;

// Duotone: map luminance (as seen on white paper) onto a dark->light color
// ramp. Lays its own paper — the output is opaque.
export const RECOLOR_FS = /* wgsl */ `
struct RecolorU { colA: vec4f, colB: vec4f }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: RecolorU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  let lum = dot(mix(vec3f(1.0), c.rgb, c.a), vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(mix(u.colA.rgb, u.colB.rgb, lum), 1.0);
}
`;

// Drop a color range to transparency.
export const CHROMA_KEY_FS = /* wgsl */ `
struct KeyU { key: vec4f, tolerance: f32, softness: f32, _p2: f32, _p3: f32 }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: KeyU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  let d = distance(c.rgb, u.key.rgb);
  let a = smoothstep(u.tolerance, u.tolerance + u.softness + 1e-4, d);
  return vec4f(c.rgb, c.a * a);
}
`;

// Rebuild from glyphs: average each cell, pick a glyph from the ramp atlas.
export const ASCII_FS = /* wgsl */ `
struct AsciiU { cell: f32, glyphs: f32, _p2: f32, _p3: f32 }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: AsciiU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(tex));
  let cellIdx = floor(in.pos.xy / u.cell);
  let cellUV = (cellIdx + 0.5) * u.cell / dims;
  let s = textureSample(tex, samp, cellUV);
  let lum = dot(mix(vec3f(1.0), s.rgb, s.a), vec3f(0.2126, 0.7152, 0.0722));
  let gi = floor((1.0 - lum) * (u.glyphs - 1.0) + 0.5);
  // inset within the glyph cell so linear filtering can't bleed neighbors
  let local = clamp(fract(in.pos.xy / u.cell), vec2f(0.02), vec2f(0.98));
  let atlasUV = vec2f((gi + local.x) / u.glyphs, local.y);
  return textureSample(atlas, samp, atlasUV);
}
`;

// Luminance (as seen on white paper) or alpha as a signal, written to all channels.
export const TO_ALPHA_FS = /* wgsl */ `
struct ToAlphaU { useAlpha: f32, invert: f32, threshold: f32, softness: f32 }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: ToAlphaU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  let lum = dot(mix(vec3f(1.0), c.rgb, c.a), vec3f(0.2126, 0.7152, 0.0722));
  var v = select(lum, c.a, u.useAlpha > 0.5);
  v = select(v, 1.0 - v, u.invert > 0.5);
  // the cutoff is authored here, visibly — not by whoever samples the mask.
  // softness 0 is a hard step; > 0 feathers a band around the threshold
  v = select(
    step(u.threshold, v),
    smoothstep(u.threshold - u.softness, u.threshold + u.softness, v),
    u.softness > 0.0,
  );
  return vec4f(v, v, v, 1.0);
}
`;

// Textured quad with a 2D affine transform (content px -> clip space).
// Used by the element renderer: one draw per element, alpha-blended over
// the artboard (pipeline blend state does src-over; loadOp preserves).
export const QUAD_SHADER = /* wgsl */ `
struct QuadU {
  // clip = [a b; c d] * local_px + [tx; ty]
  abcd: vec4f,
  txty: vec2f,
  size: vec2f, // content size in px
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: QuadU;

struct QVSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> QVSOut {
  // two-triangle quad over the unit square
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let c = corners[i];
  let local = c * u.size;
  var out: QVSOut;
  out.pos = vec4f(
    u.abcd.x * local.x + u.abcd.y * local.y + u.txty.x,
    u.abcd.z * local.x + u.abcd.w * local.y + u.txty.y,
    0.0, 1.0);
  out.uv = c;
  return out;
}

// exact sRGB EOTF — must invert the hardware encode so opaque pixels
// round-trip byte-identical through the composite
fn qsrgb2lin(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

@fragment
fn fs(in: QVSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  // the target view is sRGB: emit linear, the hardware re-encodes on store.
  // src-over then blends in linear light — blending gamma bytes darkens
  // every soft edge (blur halos, antialiasing) against the paper.
  return vec4f(qsrgb2lin(c.rgb), c.a);
}
`;

// Blend overlay onto base, weighted by overlay alpha * opacity * mask.
export const COMPOSITE_FS = /* wgsl */ `
struct CompU { mode: f32, opacity: f32, _p2: f32, _p3: f32 }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var base: texture_2d<f32>;
@group(0) @binding(2) var overlay: texture_2d<f32>;
@group(0) @binding(3) var mask: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: CompU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let b = textureSample(base, samp, in.uv);
  let o = textureSample(overlay, samp, in.uv);
  let m = textureSample(mask, samp, in.uv).r;
  var blended: vec3f;
  switch (i32(u.mode)) {
    case 1 { blended = b.rgb * o.rgb; }                                  // multiply
    case 2 { blended = 1.0 - (1.0 - b.rgb) * (1.0 - o.rgb); }            // screen
    case 3 {                                                             // overlay
      blended = select(
        2.0 * b.rgb * o.rgb,
        1.0 - 2.0 * (1.0 - b.rgb) * (1.0 - o.rgb),
        b.rgb > vec3f(0.5));
    }
    default { blended = o.rgb; }                                         // normal
  }
  let a = o.a * u.opacity * m;
  // src-over alpha so drawing onto a transparent base still registers
  return vec4f(mix(b.rgb, blended, a), a + b.a * (1.0 - a));
}
`;
