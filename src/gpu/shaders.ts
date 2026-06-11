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
