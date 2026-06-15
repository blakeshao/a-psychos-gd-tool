import { describe, expect, it } from 'vitest';
import { TexturePool, type TextureFactory } from './pool';

// GPUTextureUsage doesn't exist outside the browser — stub the constants
(globalThis as Record<string, unknown>).GPUTextureUsage ??= {
  TEXTURE_BINDING: 4,
  RENDER_ATTACHMENT: 16,
  COPY_DST: 2,
  COPY_SRC: 1,
};

function fakeDevice(): TextureFactory & { created: number } {
  const factory = {
    created: 0,
    createTexture(_desc: GPUTextureDescriptor): GPUTexture {
      factory.created++;
      return { destroy() {} } as GPUTexture;
    },
  };
  return factory;
}

describe('TexturePool', () => {
  it('recycles released textures instead of allocating', () => {
    const device = fakeDevice();
    const pool = new TexturePool(device);
    const a = pool.acquire(256, 256);
    pool.release(a);
    const b = pool.acquire(256, 256);
    expect(b).toBe(a); // same handle came back off the free list
    expect(device.created).toBe(1);
  });

  it('allocates separately per size', () => {
    const device = fakeDevice();
    const pool = new TexturePool(device);
    const a = pool.acquire(256, 256);
    const b = pool.acquire(512, 512);
    expect(a).not.toBe(b);
    expect(device.created).toBe(2);
    expect(pool.stats()).toEqual({ allocated: 2, free: 0, live: 2 });
  });

  it('retain keeps a texture alive across one release', () => {
    const device = fakeDevice();
    const pool = new TexturePool(device);
    const a = pool.acquire(64, 64);
    pool.retain(a); // refs = 2
    pool.release(a); // refs = 1 — still live
    expect(pool.stats().live).toBe(1);
    const b = pool.acquire(64, 64);
    expect(b).not.toBe(a); // a was not free, so a fresh one was made
    pool.release(a);
    expect(pool.stats().free).toBe(1);
  });

  it('throws on double release', () => {
    const pool = new TexturePool(fakeDevice());
    const a = pool.acquire(64, 64);
    pool.release(a);
    expect(() => pool.release(a)).toThrow(/double release/);
  });
});
