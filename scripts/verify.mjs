// Phase 3 gate, driven in headless Chrome:
//  1. build a 12-node graph using every raster op via the dev store handle
//  2. confirm it cooks clean (no cook error, all nodes in the log)
//  3. stress: change Blur radius at ~60Hz for 2s — pool allocation must stay
//     flat (recycling, not allocating) and cooks must keep up
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
const poolText = () => page.$eval('.pool', (el) => el.textContent);

// 1. the kitchen-sink graph: text -> blur -> ascii -> recolor -> dither -> composite
//    with a value-noise mask and a grain overlay
await page.evaluate(() => {
  const N = (id, type, params, x, y) => [id, { id, type, params, position: { x, y } }];
  const E = (fn, fs, tn, ts) => ({ from: { node: fn, socket: fs }, to: { node: tn, socket: ts } });
  globalThis.__app.setState({
    selectedNodeId: null,
    graph: {
      nodes: Object.fromEntries([
        N('text1', 'Text', { content: 'PSYCHO', fontSize: 200, font: 'default' }, 20, 40),
        N('outline1', 'Outline', {}, 200, 40),
        N('raster1', 'Rasterize', { width: 768, height: 512 }, 380, 40),
        N('blur1', 'Blur', { radius: 3 }, 560, 40),
        N('ascii1', 'ASCII', { cell: 8 }, 720, 40),
        N('recolor1', 'Recolor', { dark: '#1c1240', light: '#ffd27f' }, 880, 40),
        N('dither1', 'Dither', { levels: 4, scale: 2 }, 1060, 40),
        N('noise1', 'Noise', { width: 768, height: 512, mode: 'value', scale: 96, seed: 7 }, 560, 220),
        N('toalpha1', 'ToAlpha', { source: 'luminance', invert: 'no' }, 740, 220),
        N('noise2', 'Noise', { width: 768, height: 512, mode: 'grain', scale: 1, seed: 3 }, 880, 300),
        N('comp1', 'Composite', { mode: 'multiply', opacity: 0.5 }, 1230, 140),
        N('out', 'Output', {}, 1390, 140),
      ]),
      edges: [
        E('text1', 'out', 'outline1', 'text'),
        E('outline1', 'out', 'raster1', 'vector'),
        E('raster1', 'out', 'blur1', 'in'),
        E('blur1', 'out', 'ascii1', 'in'),
        E('ascii1', 'out', 'recolor1', 'in'),
        E('recolor1', 'out', 'dither1', 'in'),
        E('dither1', 'out', 'comp1', 'base'),
        E('noise2', 'out', 'comp1', 'overlay'),
        E('noise1', 'out', 'toalpha1', 'in'),
        E('toalpha1', 'out', 'comp1', 'mask'),
        E('comp1', 'out', 'out', 'in'),
      ],
    },
  });
});
await sleep(800);

console.log('--- cook: kitchen-sink graph (12 nodes) ---');
for (const line of await readLog()) console.log(line);
const err = await page.$('.cook-error');
if (err) console.log('COOK ERROR:', await err.evaluate((el) => el.textContent));
console.log('---', await poolText());

await page.screenshot({ path: '/tmp/nodegfx-verify.png' });

// 2. stress: ~60Hz blur-radius changes for 2 seconds
const result = await page.evaluate(async () => {
  const app = globalThis.__app;
  let ticks = 0;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      ticks++;
      app.getState().setParam('blur1', 'radius', 1 + (ticks % 30));
      if (performance.now() - t0 > 2000) { clearInterval(iv); resolve(); }
    }, 16);
  });
  return { ticks };
});
await sleep(500);

console.log(`--- stress: ${result.ticks} param changes in 2s ---`);
console.log('---', await poolText(), '(must stay small/flat)');
console.log('--- post-stress log ---');
for (const line of await readLog()) console.log(line);

await page.screenshot({ path: '/tmp/nodegfx-stress.png' });
console.log('screenshots: /tmp/nodegfx-verify.png /tmp/nodegfx-stress.png');
await browser.close();
