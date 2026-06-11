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
export const BLUR_FS = /* wgsl */ `
struct BlurU {
  dir: vec2f,
  radius: f32,
  _pad: f32,
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: BlurU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(tex));
  let r = i32(u.radius);
  if (r <= 0) {
    return textureSample(tex, samp, in.uv);
  }
  let sigma = max(f32(r) * 0.5, 1.0);
  var sum = vec4f(0.0);
  var wsum = 0.0;
  for (var i = -r; i <= r; i++) {
    let w = exp(-f32(i * i) / (2.0 * sigma * sigma));
    sum += textureSample(tex, samp, in.uv + f32(i) * u.dir * texel) * w;
    wsum += w;
  }
  return sum / wsum;
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
  let cell = vec2i(in.pos.xy / max(u.scale, 1.0)) % vec2i(4, 4);
  let t = (BAYER[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;
  let n = max(u.levels - 1.0, 1.0);
  let q = floor((c.rgb + vec3f(t / n)) * n + 0.5) / n;
  return vec4f(clamp(q, vec3f(0.0), vec3f(1.0)), c.a);
}
`;

// Duotone: map luminance onto a dark->light color ramp.
export const RECOLOR_FS = /* wgsl */ `
struct RecolorU { colA: vec4f, colB: vec4f }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: RecolorU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  let lum = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(mix(u.colA.rgb, u.colB.rgb, lum), c.a);
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
  let lum = dot(textureSample(tex, samp, cellUV).rgb, vec3f(0.2126, 0.7152, 0.0722));
  let gi = floor((1.0 - lum) * (u.glyphs - 1.0) + 0.5);
  // inset within the glyph cell so linear filtering can't bleed neighbors
  let local = clamp(fract(in.pos.xy / u.cell), vec2f(0.02), vec2f(0.98));
  let atlasUV = vec2f((gi + local.x) / u.glyphs, local.y);
  return textureSample(atlas, samp, atlasUV);
}
`;

// Luminance or alpha as a signal, written to all channels.
export const TO_ALPHA_FS = /* wgsl */ `
struct ToAlphaU { useAlpha: f32, invert: f32, _p2: f32, _p3: f32 }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: ToAlphaU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  var v = select(dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)), c.a, u.useAlpha > 0.5);
  v = select(v, 1.0 - v, u.invert > 0.5);
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

@fragment
fn fs(in: QVSOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
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
  return vec4f(mix(b.rgb, blended, a), b.a);
}
`;
