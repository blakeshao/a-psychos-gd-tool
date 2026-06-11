// WebGPU wrapper: device init, pipeline cache, fullscreen passes, present.
// Raster node cooks call runPass(src → dst); nothing here knows about the graph.

import { BLIT_FS, BLUR_FS, FULLSCREEN_VS } from './shaders';
import { TexturePool, type PooledTexture } from './pool';

const FRAGMENTS: Record<string, string> = {
  blit: BLIT_FS,
  blur: BLUR_FS,
};

export class GpuContext {
  readonly pool: TexturePool;
  private pipelines = new Map<string, GPURenderPipeline>();
  private sampler: GPUSampler;
  private uniforms: GPUBuffer;
  private configured = new WeakSet<HTMLCanvasElement>();

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
      size: 16,
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

  /** One fullscreen fragment pass: sample src, write dst. uniformData is 4 floats. */
  runPass(name: string, src: PooledTexture, dst: PooledTexture, uniformData: Float32Array<ArrayBuffer>) {
    this.device.queue.writeBuffer(this.uniforms, 0, uniformData);
    this.encodePass(this.getPipeline(name, dst.format), src, dst.texture.createView(), true);
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
      src,
      ctx.getCurrentTexture().createView(),
      false,
    );
  }

  private encodePass(
    pipeline: GPURenderPipeline,
    src: PooledTexture,
    target: GPUTextureView,
    withUniforms: boolean,
  ) {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: src.texture.createView() },
    ];
    if (withUniforms) entries.push({ binding: 2, resource: { buffer: this.uniforms } });
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
