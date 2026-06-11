// WebGPU wrapper: device init, pipeline cache, fullscreen passes, present.
// Raster node cooks call runPass(srcs → dst); nothing here knows about the graph.
//
// Binding convention (matches shaders.ts): sampler@0, source textures @1..N,
// uniform @N+1 when uniformData is given.

import {
  ASCII_FS,
  BLIT_FS,
  BLUR_FS,
  CHROMA_KEY_FS,
  COMPOSITE_FS,
  DITHER_FS,
  FULLSCREEN_VS,
  RECOLOR_FS,
  TO_ALPHA_FS,
} from './shaders';
import { TexturePool, type PooledTexture } from './pool';

const FRAGMENTS: Record<string, string> = {
  blit: BLIT_FS,
  blur: BLUR_FS,
  dither: DITHER_FS,
  recolor: RECOLOR_FS,
  chromakey: CHROMA_KEY_FS,
  ascii: ASCII_FS,
  toalpha: TO_ALPHA_FS,
  composite: COMPOSITE_FS,
};

/** Pass sources are pooled render targets or persistent textures (atlas, white). */
type TexSource = PooledTexture | GPUTexture;

const viewOf = (t: TexSource) => ('createView' in t ? t.createView() : t.texture.createView());

export class GpuContext {
  readonly pool: TexturePool;
  private pipelines = new Map<string, GPURenderPipeline>();
  private sampler: GPUSampler;
  private uniforms: GPUBuffer;
  private configured = new WeakSet<HTMLCanvasElement>();
  private whiteTex: GPUTexture | null = null;
  private asciiAtlas: { texture: GPUTexture; glyphs: number } | null = null;

  private constructor(
    readonly device: GPUDevice,
    readonly canvasFormat: GPUTextureFormat,
  ) {
    this.pool = new TexturePool(device);
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.uniforms = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  static async init(): Promise<GpuContext | null> {
    if (!('gpu' in navigator)) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    return new GpuContext(device, navigator.gpu.getPreferredCanvasFormat());
  }

  /** 1x1 white — stands in for unwired optional mask inputs. */
  white(): GPUTexture {
    if (!this.whiteTex) {
      this.whiteTex = this.device.createTexture({
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this.whiteTex },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );
    }
    return this.whiteTex;
  }

  /** Glyph ramp atlas for the ASCII node: light -> dark, one 32px cell per glyph. */
  getAsciiAtlas(): { texture: GPUTexture; glyphs: number } {
    if (this.asciiAtlas) return this.asciiAtlas;
    const ramp = ' .:-=+*#%@';
    const cell = 32;
    const canvas = new OffscreenCanvas(cell * ramp.length, cell);
    const c2d = canvas.getContext('2d')!;
    c2d.fillStyle = '#ffffff';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.fillStyle = '#000000';
    c2d.font = `${cell * 0.8}px ui-monospace, Menlo, monospace`;
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    for (let i = 0; i < ramp.length; i++) {
      c2d.fillText(ramp[i], i * cell + cell / 2, cell / 2 + 1);
    }
    const texture = this.device.createTexture({
      size: { width: canvas.width, height: canvas.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture },
      { width: canvas.width, height: canvas.height },
    );
    this.asciiAtlas = { texture, glyphs: ramp.length };
    return this.asciiAtlas;
  }

  /** One fullscreen fragment pass: sample srcs, write dst. */
  runPass(
    name: string,
    srcs: TexSource | TexSource[],
    dst: PooledTexture,
    uniformData?: Float32Array<ArrayBuffer>,
  ) {
    if (uniformData) this.device.queue.writeBuffer(this.uniforms, 0, uniformData);
    const list = Array.isArray(srcs) ? srcs : [srcs];
    this.encodePass(this.getPipeline(name, dst.format), list, dst.texture.createView(), !!uniformData);
  }

  /** Draw a texture into a canvas (the viewport / Output display). */
  present(src: PooledTexture, canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('webgpu canvas context unavailable');
    if (!this.configured.has(canvas)) {
      ctx.configure({ device: this.device, format: this.canvasFormat, alphaMode: 'opaque' });
      this.configured.add(canvas);
    }
    this.encodePass(
      this.getPipeline('blit', this.canvasFormat),
      [src],
      ctx.getCurrentTexture().createView(),
      false,
    );
  }

  private getPipeline(name: string, targetFormat: GPUTextureFormat): GPURenderPipeline {
    const key = `${name}:${targetFormat}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const module = this.device.createShaderModule({ code: FULLSCREEN_VS + FRAGMENTS[name] });
    pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: targetFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private encodePass(
    pipeline: GPURenderPipeline,
    srcs: TexSource[],
    target: GPUTextureView,
    withUniforms: boolean,
  ) {
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: this.sampler }];
    srcs.forEach((src, i) => entries.push({ binding: i + 1, resource: viewOf(src) }));
    if (withUniforms) entries.push({ binding: srcs.length + 1, resource: { buffer: this.uniforms } });
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    // submit per pass so the shared uniform buffer's writeBuffer/draw ordering holds
    this.device.queue.submit([encoder.finish()]);
  }
}
