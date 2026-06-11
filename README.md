# nodegfx

A node-based graphic design tool. Types flow on typed wires — `text => vector => raster`, every step explicit, never coerced.

**Status: Phase 4.** Seventeen node types across the full ladder. Vector lane: Shape (rect/ellipse/polygon), Displace and Warp (flatten-then-deform on the shared path utils), Boolean (Paper.js union/subtract/intersect on pre-flattened polygons). Conversions both ways: Rasterize (vector→raster) and Trace (raster→vector via async GPU readback + imagetracerjs — cooks once, then cache-hits like any other node). Vector Slice is still TODO.

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
3. ~~Raster breadth: Noise, Dither, Recolor, Chroma Key, ASCII, To Alpha, Composite~~
4. ~~Vector ops (Shape, Displace, Warp, Boolean) + Trace~~ ← here (vector Slice deferred)
5. Elements & layout: Split, Duplicator, Grid, Sample Path, Place…
6. Async model nodes (Extract Subject/Objects/Edges via ONNX Runtime Web)
7. Persistence, export, undo
