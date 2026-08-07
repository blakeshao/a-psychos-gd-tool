// Slice on a real GPU: the srcRect window added to the quad shader has no
// headless coverage, so this checks the one property that pins it down —
// Image → Slice → Output must reassemble the source pixel for pixel. It then
// renders a shuffled non-uniform mosaic to eyeball.
// Usage: node scripts/slice-check.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5199/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FRAME = { width: 900, height: 1200 };

const node = (id, type, params = {}) => [id, { id, type, params, position: { x: 0, y: 0 } }];
const wire = (from, fs, to, ts) => ({ from: { node: from, socket: fs }, to: { node: to, socket: ts } });

/** one-layer doc around a graph */
const doc = (nodes, edges) => ({
  frame: FRAME,
  layers: [{
    id: 'layer_1', name: 'Layer 1', visible: true, opacity: 1, blendMode: 'normal',
    graph: { nodes: Object.fromEntries(nodes), edges },
  }],
});

const IMAGE = node('image_1', 'Image', { src: '/factory-image.jpg', fit: 'cover' });
const OUT = node('out', 'Output', {});
// gapless and unpadded: the cells have to account for every pixel
const GRID = (over) => node('grid_1', 'Grid', {
  columns: 5, rows: 7, gapX: 0, gapY: 0, padding: 'x/y', padX: 0, padY: 0, ...over,
});

const DOCS = {
  // the reference: the picture, straight to the artboard
  plain: doc([IMAGE, OUT], [wire('image_1', 'out', 'out', 'in')]),
  // cut into a uniform grid and drawn back — same pixels, 35 quads
  sliced: doc(
    [IMAGE, GRID({}), node('slice_1', 'Slice', {}), OUT],
    [wire('image_1', 'out', 'slice_1', 'image'), wire('grid_1', 'out', 'slice_1', 'layout'),
     wire('slice_1', 'out', 'out', 'in')],
  ),
  // and again with tracks of wildly different sizes
  slicedFib: doc(
    [IMAGE, GRID({ distX: 'fibonacci', distY: 'golden' }), node('slice_1', 'Slice', {}), OUT],
    [wire('image_1', 'out', 'slice_1', 'image'), wire('grid_1', 'out', 'slice_1', 'layout'),
     wire('slice_1', 'out', 'out', 'in')],
  ),
  // the payoff: non-uniform tiles, shuffled by track, placed by index
  shuffled: doc(
    [IMAGE, GRID({ distX: 'fibonacci', distY: 'golden' }), node('slice_1', 'Slice', {}),
     node('shuffle_1', 'Shuffle', { mode: 'tracks', axes: 'both', seed: 4 }),
     node('place_1', 'Place', { distribute: 'by-index', binds: '[]' }), OUT],
    [wire('image_1', 'out', 'slice_1', 'image'), wire('grid_1', 'out', 'slice_1', 'layout'),
     wire('grid_1', 'out', 'shuffle_1', 'layout'), wire('slice_1', 'out', 'place_1', 'elements'),
     wire('shuffle_1', 'out', 'place_1', 'layout'), wire('place_1', 'out', 'out', 'in')],
  ),
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars', '--window-size=1480,920'],
  defaultViewport: { width: 1480, height: 920 },
});
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
await page.goto(url, { waitUntil: 'networkidle0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function render(name) {
  await page.evaluate((d) => localStorage.setItem('gfx.document.v2', JSON.stringify(d)), DOCS[name]);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.viewport canvas', { timeout: 15000 });
  await sleep(2500); // the image fetch + cook settle
  const err = await page.$('.cook-error');
  if (err) console.log(`  ${name}: COOK ERROR:`, await err.evaluate((el) => el.textContent));
  const shot = await page.$('.viewport canvas').then((c) => c.screenshot());
  return shot;
}

const plain = await render('plain');
const sliced = await render('sliced');
const fib = await render('slicedFib');
const shuffled = await render('shuffled');

const same = (a, b) => a.length === b.length && a.equals(b);
console.log('uniform slice reassembles the source :', same(plain, sliced) ? 'IDENTICAL' : 'DIFFERS');
console.log('fibonacci slice reassembles the source:', same(plain, fib) ? 'IDENTICAL' : 'DIFFERS');
console.log('shuffle actually rearranges           :', same(plain, shuffled) ? 'NO CHANGE' : 'rearranged');

const fs = await import('node:fs/promises');
for (const [name, buf] of [['plain', plain], ['sliced', sliced], ['fib', fib], ['shuffled', shuffled]]) {
  await fs.writeFile(`/tmp/slice-${name}.png`, buf);
}
console.log('screenshots: /tmp/slice-{plain,sliced,fib,shuffled}.png');
await browser.close();
