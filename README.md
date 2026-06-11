# nodegfx

A node-based graphic design tool. Types flow on typed wires — `text => vector => raster`, every step explicit, never coerced.

**Status: Phase 3.** Twelve node types. New raster lane: Noise (deterministic value/grain source), Dither (Bayer), Recolor (duotone), Chroma Key, ASCII (glyph-atlas rebuild), To Alpha, and Composite (blend modes + optional alpha mask — the first multi-input, optional-input node). Every op is one WGSL pass on the shared fullscreen-pass frame; param drags at 60Hz recycle pool textures instead of allocating.

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
- `src/store.ts` — zustand store; the document graph is the single source of truth, the editor and evaluator both read it. `wireIsValid` = socket-type equality + acyclicity.
- `src/editor/` — xyflow canvas + custom node component; handles and wires colored by socket type.
- `scripts/verify.mjs` — drives headless Chrome: cold cook, inspector edit (upstream HITs), illegal wire drag (rejected), legal rewire (Blur drops out of the cook).

## Roadmap

1. ~~Engine spine + Text→Output slice~~
2. ~~Node editor wired to the engine; type-checking on drag~~
3. ~~Raster breadth: Noise, Dither, Recolor, Chroma Key, ASCII, To Alpha, Composite~~ ← here
4. Vector ops + Trace/To Alpha conversions
5. Elements & layout: Split, Duplicator, Grid, Sample Path, Place…
6. Async model nodes (Extract Subject/Objects/Edges via ONNX Runtime Web)
7. Persistence, export, undo
