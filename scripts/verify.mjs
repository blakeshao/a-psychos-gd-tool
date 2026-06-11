// Phase 4 gate, driven in headless Chrome:
//  A. vector lane: Text -> Outline -> Boolean(subtract ellipse) -> Displace
//     -> Warp -> Rasterize -> Output
//  B. conversion round trip: ...Rasterize -> Trace (async GPU readback) ->
//     Rasterize -> Output; Trace must cook async and then HIT on re-cook
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

// --- A: vector ops + boolean ---
await page.evaluate(() => {
  const N = (id, type, params, x, y) => [id, { id, type, params, position: { x, y } }];
  const E = (fn, fs, tn, ts) => ({ from: { node: fn, socket: fs }, to: { node: tn, socket: ts } });
  globalThis.__app.setState({
    selectedNodeId: null,
    graph: {
      nodes: Object.fromEntries([
        N('text1', 'Text', { content: 'PSYCHO', fontSize: 200, font: 'default' }, 20, 40),
        N('outline1', 'Outline', {}, 200, 40),
        N('shape1', 'Shape', { kind: 'ellipse', width: 620, height: 150, sides: 6 }, 200, 200),
        N('bool1', 'Boolean', { op: 'subtract' }, 400, 120),
        N('disp1', 'Displace', { amount: 5, scale: 50, seed: 3 }, 580, 120),
        N('warp1', 'Warp', { axis: 'y', amplitude: 14, wavelength: 320, phase: 0 }, 760, 120),
        N('raster1', 'Rasterize', { width: 768, height: 512 }, 940, 120),
        N('out', 'Output', {}, 1120, 120),
      ]),
      edges: [
        E('text1', 'out', 'outline1', 'text'),
        E('outline1', 'out', 'bool1', 'a'),
        E('shape1', 'out', 'bool1', 'b'),
        E('bool1', 'out', 'disp1', 'in'),
        E('disp1', 'out', 'warp1', 'in'),
        E('warp1', 'out', 'raster1', 'vector'),
        E('raster1', 'out', 'out', 'in'),
      ],
    },
  });
});
await sleep(900);

console.log('--- A: vector lane (boolean subtract + displace + warp) ---');
for (const line of await readLog()) console.log(line);
const errA = await cookError();
if (errA) console.log('COOK ERROR:', errA);
await page.screenshot({ path: '/tmp/nodegfx-vector.png' });

// --- B: append Trace -> Rasterize, rewire Output ---
await page.evaluate(() => {
  const app = globalThis.__app;
  const g = app.getState().graph;
  const E = (fn, fs, tn, ts) => ({ from: { node: fn, socket: fs }, to: { node: tn, socket: ts } });
  app.setState({
    graph: {
      nodes: {
        ...g.nodes,
        trace1: { id: 'trace1', type: 'Trace', params: { smoothness: 1, minArea: 8, ignoreLight: 'yes' }, position: { x: 940, y: 280 } },
        raster2: { id: 'raster2', type: 'Rasterize', params: { width: 768, height: 512 }, position: { x: 1120, y: 280 } },
      },
      edges: [
        ...g.edges.filter((e) => e.to.node !== 'out'),
        E('raster1', 'out', 'trace1', 'in'),
        E('trace1', 'out', 'raster2', 'vector'),
        E('raster2', 'out', 'out', 'in'),
      ],
    },
  });
});
await sleep(1200);

console.log('--- B: + Trace (async readback) -> Rasterize ---');
for (const line of await readLog()) console.log(line);
const errB = await cookError();
if (errB) console.log('COOK ERROR:', errB);

// nudge a downstream param: Trace must HIT (its result is cached)
await page.evaluate(() => globalThis.__app.getState().setParam('raster2', 'width', 760));
await sleep(500);
console.log('--- B2: downstream param change — Trace should HIT ---');
for (const line of await readLog()) console.log(line);

console.log('---', await page.$eval('.pool', (el) => el.textContent));
await page.screenshot({ path: '/tmp/nodegfx-trace.png' });
console.log('screenshots: /tmp/nodegfx-vector.png /tmp/nodegfx-trace.png');
await browser.close();
