# nodegfx

A node-based graphic design tool. Types flow on typed wires — `text => vector => raster`, every step explicit, never coerced.

**Status: Phase 1.** The engine spine is proven on a hardcoded `Text → Outline → Rasterize → Blur → Output` chain with a live inspector and a HIT/MISS cook log. No node editor yet.

## Run

```sh
npm install
./scripts/get-font.sh   # fetches a font into public/fonts/ (or copies a system font, gitignored)
npm run dev             # needs a WebGPU browser (Chrome/Edge 113+, Safari 18+)
npm test                # headless engine tests — cache + pool, no GPU needed
```

## Architecture

- `src/engine/` — the core: document graph (pure JSON), node registry (typed sockets + `cook()`), pull-based evaluator with hash-keyed memoization (`hash(type, params, upstream hashes)`), so a param change re-cooks only that node and its descendants.
- `src/gpu/` — WebGPU wrapper: ref-counted texture pool (render targets recycle instead of allocating during param drags), fullscreen-pass runner, WGSL shaders. Every raster op is one pass: sample previous target, write next.
- `src/nodes/` — node definitions. `Rasterize` is the CPU→GPU boundary; resolution is introduced there and inherited downstream.
- `scripts/verify.mjs` — drives headless Chrome: cooks cold, changes blur radius, asserts upstream nodes HIT cache.

## Roadmap

1. ~~Engine spine + Text→Output slice~~ ← here
2. Node editor (@xyflow/react) wired to the engine; `canConnect` type-checking on drag
3. Raster breadth: Dither, Recolor, Chroma Key, ASCII, Composite…
4. Vector ops + Trace/To Alpha conversions
5. Elements & layout: Split, Duplicator, Grid, Sample Path, Place…
6. Async model nodes (Extract Subject/Objects/Edges via ONNX Runtime Web)
7. Persistence, export, undo
