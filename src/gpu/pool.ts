// Ref-counted GPU texture pool. RasterValues hold PooledTexture handles;
// release() returns a texture to the free list instead of destroying it, so a
// param drag re-cooking 60×/sec recycles render targets instead of allocating.

export interface PooledTexture {
  texture: GPUTexture;
  width: number;
  height: number;
  format: GPUTextureFormat;
  refs: number;
  key: string;
}

// Minimal device surface so the pool is testable without a real GPU.
export interface TextureFactory {
  createTexture(desc: GPUTextureDescriptor): GPUTexture;
}

// read at call time, not module load, so headless tests can stub the global
const usage = () =>
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.COPY_DST |
  GPUTextureUsage.COPY_SRC;

export class TexturePool {
  private free = new Map<string, PooledTexture[]>();
  private allocated = 0;

  constructor(private device: TextureFactory) {}

  acquire(width: number, height: number, format: GPUTextureFormat = 'rgba8unorm'): PooledTexture {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`invalid texture size ${width}x${height} — a node cooked with bad dimensions`);
    }
    const key = `${width}x${height}:${format}`;
    const list = this.free.get(key);
    const recycled = list?.pop();
    if (recycled) {
      recycled.refs = 1;
      return recycled;
    }
    this.allocated++;
    return {
      texture: this.device.createTexture({
        size: { width, height },
        format,
        usage: usage(),
      }),
      width,
      height,
      format,
      refs: 1,
      key,
    };
  }

  retain(t: PooledTexture) {
    t.refs++;
  }

  release(t: PooledTexture) {
    if (t.refs <= 0) throw new Error(`double release of texture ${t.key}`);
    t.refs--;
    if (t.refs === 0) {
      let list = this.free.get(t.key);
      if (!list) {
        list = [];
        this.free.set(t.key, list);
      }
      list.push(t);
    }
  }

  stats() {
    let freeCount = 0;
    for (const list of this.free.values()) freeCount += list.length;
    return { allocated: this.allocated, free: freeCount, live: this.allocated - freeCount };
  }
}
