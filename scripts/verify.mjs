// Verifies the elements-native artboard:
//  A. Shape -> Place.elements (single lifted), Function(spiral) layout,
//     Place.out -> Output.in DIRECTLY — no Flatten, no Rasterize.
//  B. raster content: Noise -> Duplicator -> Place(Grid) -> Output; the
//     artboard quad-draws each texture with its transform, in z-order.
// Usage: node scripts/verify.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5199/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars', '--window-size=1480,920'],
  defaultViewport: { width: 1480, height: 920 },
});

const page = await browser.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForSelector('.cook-log li', { timeout: 15000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readLog = () =>
  page.$$eval('.cook-log li', (lis) => lis.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
const cookError = async () => {
  const err = await page.$('.cook-error');
  return err ? await err.evaluate((el) => el.textContent) : null;
};

// --- A: vector elements straight to the artboard ---
await page.evaluate(() => {
  const N = (id, type, params, x, y) => [id, { id, type, params, position: { x, y } }];
  const E = (fn, fs, tn, ts) => ({ from: { node: fn, socket: fs }, to: { node: tn, socket: ts } });
  globalThis.__app.setState({
    selectedNodeId: null,
    graph: {
      nodes: Object.fromEntries([
        N('shape1', 'Shape', { kind: 'polygon', width: 70, height: 70, sides: 3 }, 20, 40),
        N('fn1', 'Function', { fn: 'spiral', count: 48, radius: 220, turns: 3, spacing: 40 }, 20, 200),
        N('place1', 'Place', { distribute: 'cycle', bindWeight: 'scale', bindAmount: 0.85, seed: 0 }, 240, 120),
        N('out', 'Output', { width: 768, height: 512, background: '#f3ead8' }, 430, 120),
      ]),
      edges: [
        E('shape1', 'out', 'place1', 'elements'), // vector → elements socket (lift)
        E('fn1', 'out', 'place1', 'layout'),
        E('place1', 'out', 'out', 'in'),          // elements → Output (artboard composites)
      ],
    },
  });
});
await sleep(900);

console.log('--- A: Shape -> Place(spiral) -> Output, 4 nodes total ---');
for (const line of await readLog()) console.log(line);
const errA = await cookError();
if (errA) console.log('COOK ERROR:', errA);
await page.screenshot({ path: '/tmp/nodegfx-spiral.png' });

// --- B: raster elements on the artboard ---
await page.evaluate(() => {
  const N = (id, type, params, x, y) => [id, { id, type, params, position: { x, y } }];
  const E = (fn, fs, tn, ts) => ({ from: { node: fn, socket: fs }, to: { node: tn, socket: ts } });
  globalThis.__app.setState({
    selectedNodeId: null,
    graph: {
      nodes: Object.fromEntries([
        N('noise1', 'Noise', { width: 96, height: 96, mode: 'value', scale: 24, seed: 5 }, 20, 40),
        N('dup1', 'Duplicator', { count: 12 }, 200, 40),
        N('grid1', 'Grid', { columns: 4, rows: 3, spacingX: 150, spacingY: 140 }, 20, 200),
        N('rand1', 'Random', { count: 24, areaWidth: 600, areaHeight: 400, offset: 20, rotate: 0.4, scaleJitter: 0.3, seed: 9 }, 200, 200),
        N('place1', 'Place', { distribute: 'cycle', bindWeight: 'none', bindAmount: 1, seed: 0 }, 420, 120),
        N('out', 'Output', { width: 768, height: 512, background: '#101018' }, 610, 120),
      ]),
      edges: [
        E('noise1', 'out', 'dup1', 'in'),         // raster → Duplicator (lift)
        E('dup1', 'out', 'place1', 'elements'),
        E('grid1', 'out', 'rand1', 'layout'),     // grid jittered by Random
        E('rand1', 'out', 'place1', 'layout'),
        E('place1', 'out', 'out', 'in'),
      ],
    },
  });
});
await sleep(900);

console.log('--- B: Noise -> Duplicator -> Place(jittered grid) -> Output ---');
for (const line of await readLog()) console.log(line);
const errB = await cookError();
if (errB) console.log('COOK ERROR:', errB);

console.log('---', await page.$eval('.pool', (el) => el.textContent));
await page.screenshot({ path: '/tmp/nodegfx-rasterel.png' });
console.log('screenshots: /tmp/nodegfx-spiral.png /tmp/nodegfx-rasterel.png');
await browser.close();
