# a-psychos-gd-tool

**Hosted version:** [a-psychos-gd-tool.vercel.app](https://a-psychos-gd-tool.vercel.app/) — needs a WebGPU browser (Chrome/Edge 113+ or Safari 18+).

A node-based graphic design tool that runs in the browser, on the GPU. You build a poster by wiring nodes on a canvas: text is shaped into vector outlines, vectors are warped and combined, rasters are blurred and dithered — every conversion is an explicit node on a typed wire, never a hidden coercion. The engine only re-computes what a change actually touches, so dragging a parameter stays interactive even in deep graphs.

**Status:** experimental, under active development. 31 node types; undo/redo is built in (⌘/Ctrl Z, ⇧⌘/Ctrl Z); persistence is not built yet (see [Roadmap](#roadmap)).

## Requirements

- **Node.js 20.19+ or 22+** (for Vite 7)
- **A WebGPU browser** to run the app: Chrome/Edge 113+ or Safari 18+. The headless engine tests don't need a GPU.

## Quick start

```sh
./scripts/setup.sh   # checks Node, installs deps, fetches a free font into public/fonts/
npm run dev          # open the printed URL in a WebGPU browser
```

You'll get a default graph cooking to the artboard. Add nodes from the palette, drag wires between sockets — handle colors encode socket types, and illegal wires are rejected on drag.

Other commands:

```sh
npm test              # headless engine tests (vitest) — cache, pool, layout; no GPU needed
npm run typecheck     # tsc -b
npm run build         # production build to dist/
```

## Core ideas

### Typed wires and the conversion ladder

Values on wires are typed: `text`, `vector`, `raster`, `alpha`, `layout`, `elements`. Content conversions follow one ladder — `text => vector => raster` — and each step down is an explicit node (Outline Text, Rasterize, or back up via Trace). Nothing converts silently; the graph you see is the computation you get.

### Elements: singular or plural, one type

`elements` is a list of placed things — but it's **one type, singular or plural**. A lone vector, raster, or text value lifts into a single-element list at any elements socket (containment, not coercion: the value is untouched). Element content can be vector, raster, or live text. Union input sockets (white handles) accept several types — e.g. `Output.in: raster | elements`.

**Output is the artboard.** It composites elements natively in z-order — vector and text content batches through the 2D tessellator, raster content quad-draws its texture with the element's transform, all GPU-side. Placing things on the artboard never needed the conversion ladder. A minimal scatter graph is four nodes: `Shape → Place ← Grid`, `Place → Output`.

### The frame

The document has one **frame** (artboard size), edited in the sidebar and stored in the graph. Frame-aware nodes — Rasterize, Noise, Output — cook at frame resolution via `ctx.frame` and declare `usesFrame`, so the evaluator folds the frame into their content hash. Changing the frame re-cooks exactly those nodes and their descendants; text shaping and vector geometry stay cached. There are no per-node resolution params.

### Caching

Evaluation is pull-based from Output with hash-keyed memoization: a node's key is `hash(type, params, upstream hashes)`. Editing a parameter re-cooks only that node and its descendants; everything upstream is a cache hit. GPU render targets come from a ref-counted texture pool, so param drags recycle textures instead of allocating.

## Nodes

| Node | Wires | Description |
| --- | --- | --- |
| **Assets** | | Sources — no inputs; where content enters the graph. |
| Text | `→ text` | Live type: shapes a string into kerned, positioned glyphs, with fill/stroke and a synthetic weight axis. |
| Shape | `→ vector` | Parametric vector source: rect, ellipse, or n-sided polygon, with fill and stroke. |
| Image | `→ raster` | An uploaded bitmap, stored in the document as a data URI; fit / scale / offset / rotate / opacity onto the frame. |
| Noise | `→ raster` | Generated value-noise or grain texture at frame resolution — deterministic by (seed, scale), so the cache stays honest. |
| **Text ops** | | Operations on live type, while it's still text and not yet geometry. |
| Split | `text → elements` | Peels live type into per-character or per-word elements that keep their kerned positions and indices. |
| **Vector ops** | | Bend and combine path geometry — resolution-independent, upstream of any pixels. |
| Displace | `vector → vector` | Jitters path points with two decorrelated noise fields (amount / scale / seed). |
| Warp | `vector → vector` | Sine-wave displacement along the x or y axis (amplitude / wavelength / phase). |
| Boolean | `vector, vector → vector` | Union, subtract, or intersect two vectors (Paper.js on flattened polygons). |
| **Raster ops** | | Pixel effects — each is one GPU shader pass: sample the upstream texture, write a new one. |
| Blur | `raster → raster` | Separable gaussian blur, two GPU passes. |
| Dither | `raster → raster` | Ordered dithering: quantizes to N levels at a chosen pixel scale. |
| ASCII | `raster → raster` | Rebuilds the image from monospace glyph cells picked by brightness. |
| Recolor | `raster → raster` | Duotone: remaps luminance onto a dark→light two-color ramp. |
| Chroma Key | `raster → raster` | Keys a color out to transparency, with tolerance and softness. |
| **Layout** | | The slot lane: decide what placement slots exist and what signals ride on them — Place decides how elements meet them. |
| Grid | `(raster/alpha mask?) → layout` | Weighted rows × columns over the frame's padded content box — per-axis track distributions (uniform / fibonacci / golden / geometric / custom / expression), gaps, stagger, fill flow. A mask decides which cells exist. |
| Sample Path | `vector (+ raster/alpha mask?) → layout` | Even arc-length samples along a path, with optional tangent rotation; progress = position along the path. A mask trims samples to its coverage. |
| Math Function | `(raster/alpha mask?) → layout` | Even arc-length slots along a circle, spiral, or wave — the gap decides how many fit the curve. A mask trims slots to its coverage. |
| Random | `layout? (+ raster/alpha mask?) → layout` | Standalone: random placements in an area — uniform, poisson-disk, or gaussian, with spacing as the density knob (poisson: the min distance); a mask trims them to its coverage. Wired: seeded jitter (offset / rotation / scale) on an upstream layout, constrained to the mask. |
| Weight | `layout (+ raster?) → layout` | Writes a signal channel onto each slot — noise, image luma/alpha/saturation, progress, cell area, distance from center, or an expression — for Place and Filter to read. |
| Filter | `layout → layout` | Prunes slots: every nth, channel threshold, or random keep. Survivors keep their identity for by-index Place. |
| **Placement** | | The element lane: decide how many things exist and marry them to layout slots. |
| Duplicator | `any → elements` | Makes N copies of its input as elements — content shared, transforms independent until Place. |
| Place | `elements, layout → elements` | Assigns elements to layout slots — in order, keyed by index, or spread evenly along the layout — and binds slot signals to scale / rotation / blur. |
| **Conversion** | | The explicit type-changing steps — every rung of the `text => vector => raster` ladder, up and down. |
| Outline Text | `text → vector` | Glyphs become paths — the explicit step down the ladder from live type to geometry. |
| Rasterize | `vector → raster` | Draws paths at frame resolution — the CPU→GPU boundary; ink on a transparent ground. |
| Trace | `raster → vector` | Pixels become paths, by region fill or Sobel edge detection, traced in a Web Worker. |
| Remove Background | `raster → raster` | Segments the foreground subject (RMBG-1.4 via Transformers.js, in a worker) and folds the mask into the image's alpha. |
| Outline Image | `raster → vector` | Traces a hollow outline around the image's alpha silhouette — pairs with Remove Background. |
| To Alpha | `raster → alpha` | Extracts a mask from luminance or alpha, optionally inverted, cut at an explicit threshold (softness feathers the edge; note luminance reads transparency as white paper). |
| Draw Layout | `layout → vector` | Renders slots as debug geometry — cell rects for grids, dot-and-tick markers elsewhere. |
| Flatten | `elements → vector` | Collapses placed elements into one vector, baking each element's transform into its paths. |
| **Composition** | | Merge separate lanes into one image before (or instead of) the artboard. |
| Composite | `raster/elements ×2 (+ alpha?) → raster` | Blends overlay onto base (normal / multiply / screen / overlay) with opacity and an optional mask. |
| **Output** | | The cook root — requesting it is what makes the graph compute. |
| Output | `raster/elements → raster` | The artboard: composites its input over the background paper at frame resolution, in z-order. |

`?` marks an optional input; `any` on Duplicator is `vector | raster | text | elements`. `src/nodes/index.ts` is the single source of truth for the palette.

## Architecture

- `src/engine/` — the core: document graph (pure JSON), node registry (typed sockets + `cook()`), pull-based evaluator with hash-keyed memoization.
- `src/gpu/` — WebGPU wrapper: ref-counted texture pool, fullscreen-pass runner, WGSL shaders. Every raster op is one pass: sample previous target, write next.
- `src/nodes/` — node definitions. `Rasterize` is the CPU→GPU boundary; resolution is introduced there and inherited downstream.
- `src/store.ts` — zustand store; the document graph is the single source of truth, the editor and evaluator both read it. `wireIsValid` = socket-type equality + acyclicity.
- `src/editor/` — xyflow canvas + custom node component; handles and wires colored by socket type.
- `src/util/` — font parsing (sfnt), expression evaluation, color, noise.

### Dev scripts

Two Puppeteer smoke-test scripts drive a real (headed) Chrome against a running dev server, since WebGPU needs a GPU:

```sh
node scripts/verify.mjs [url]       # cold cook, cache-hit check on edit, wire type-checking
node scripts/blur-check.mjs [url]   # renders a heavy blur and screenshots the halo
```

Both default to `http://localhost:5199/` (pass your dev server's URL) and locate Chrome at the standard macOS path — set the `CHROME` env var to point elsewhere on Linux/Windows.

## Roadmap

1. ~~Engine spine + Text→Output slice~~
2. ~~Node editor wired to the engine; type-checking on drag~~
3. ~~Raster breadth: Noise, Dither, Recolor, Chroma Key, ASCII, To Alpha, Composite~~
4. ~~Vector ops (Shape, Displace, Warp, Boolean) + Trace~~ (vector Slice deferred)
5. ~~Elements & layout: Split, Duplicator, Place, Flatten, Grid, Random, SamplePath, Function, Filter, Weight, DrawLayout~~ (~~Alpha Map~~ landed as the generators' mask input)
6. Async model nodes (Extract Subject/Objects/Edges via ONNX Runtime Web)
7. Persistence, export, ~~undo~~

## Contributing

Issues and PRs are welcome. CI runs `npm run typecheck`, `npm test`, and `npm run build` — please make sure all three pass locally.

## License

[MIT](LICENSE).

[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) (`public/fonts/`) is included under the [SIL Open Font License 1.1](public/fonts/OFL.txt).
