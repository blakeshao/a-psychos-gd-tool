# nodegfx

A node-based graphic design tool. Types flow on typed wires — `text => vector => raster`, every step explicit, never coerced.

**Status: Phase 5.** Twenty-eight node types — the compositional lane is in. Split (characters/words, kerned positions + indices preserved), Duplicator, Place (cycle / by-index / shuffle, weight→scale/rotation binding), Flatten (the explicit elements→vector conversion). Layout generators: Grid, Random (generates standalone, jitters when wired), SamplePath (even arc-length + tangent rotation, weight = position along path), Function (circle/spiral/wave); modulators Filter (nth / weight threshold) and Sort (re-indexing); DrawLayout renders placements as debug geometry. Alpha Map layout and vector Slice still TODO.

### The element model

`elements` is **one type, singular or plural** — a lone vector/raster/text value lifts into a single-element list at any elements socket (containment, not coercion: the value is untouched). Element content can be **vector or raster** (or live text). **Output is the artboard**: it accepts `raster | elements`, and composites elements natively in z-order — vector/text content batches through the 2D tessellator, raster content quad-draws its texture with the element's transform, GPU-side. The `text => vector => raster` ladder governs *content conversions*; placing things on the artboard never needed it. Minimal scatter graph is 4 nodes: `Shape → Place ← Grid`, `Place → Output`.

Union input sockets (white handles) accept several types — e.g. `Output.in: raster | elements`, `Place.elements: elements | vector | raster | text` — matching the spec's `To Alpha (raster | element => alpha)` pattern.

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
4. ~~Vector ops (Shape, Displace, Warp, Boolean) + Trace~~ (vector Slice deferred)
5. ~~Elements & layout: Split, Duplicator, Place, Flatten, Grid, Random, SamplePath, Function, Filter, Sort, DrawLayout~~ ← here (Alpha Map deferred)
6. Async model nodes (Extract Subject/Objects/Edges via ONNX Runtime Web)
7. Persistence, export, undo
