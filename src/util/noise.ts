// Deterministic noise — same inputs, same output, always. Both the Noise
// node and the vector Displace op sample this, so cached cooks stay honest.

/** integer lattice hash -> 0..1, stable across runs */
export function latticeHash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** smooth value noise over the integer lattice, 0..1 */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = smooth(x - ix), ty = smooth(y - iy);
  const a = latticeHash(ix, iy, seed), b = latticeHash(ix + 1, iy, seed);
  const c = latticeHash(ix, iy + 1, seed), d = latticeHash(ix + 1, iy + 1, seed);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
