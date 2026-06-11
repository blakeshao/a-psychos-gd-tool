// Phase 5 gate in the real app: Text -> Split(chars) -> Place onto
// SamplePath(ellipse) with tangent rotation + weight->scale -> Flatten ->
// Rasterize -> Output. Then change the layout count: Text/Split/Shape must
// HIT (the element lane caches independently of the layout lane).
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

await page.evaluate(() => {
  const N = (id, type, params, x, y) => [id, { id, type, params, position: { x, y } }];
  const E = (fn, fs, tn, ts) => ({ from: { node: fn, socket: fs }, to: { node: tn, socket: ts } });
  globalThis.__app.setState({
    selectedNodeId: null,
    graph: {
      nodes: Object.fromEntries([
        N('text1', 'Text', { content: 'PSYCHO', fontSize: 80, font: 'default' }, 20, 40),
        N('split1', 'Split', { by: 'characters' }, 190, 40),
        N('shape1', 'Shape', { kind: 'ellipse', width: 460, height: 300, sides: 6 }, 20, 200),
        N('sample1', 'SamplePath', { count: 18, tangent: 'rotate' }, 190, 200),
        N('place1', 'Place', { distribute: 'cycle', bindWeight: 'scale', bindAmount: 0.7, seed: 0 }, 400, 120),
        N('flat1', 'Flatten', {}, 580, 120),
        N('raster1', 'Rasterize', { width: 768, height: 512 }, 750, 120),
        N('out', 'Output', {}, 930, 120),
      ]),
      edges: [
        E('text1', 'out', 'split1', 'text'),
        E('split1', 'out', 'place1', 'elements'),
        E('shape1', 'out', 'sample1', 'path'),
        E('sample1', 'out', 'place1', 'layout'),
        E('place1', 'out', 'flat1', 'in'),
        E('flat1', 'out', 'raster1', 'vector'),
        E('raster1', 'out', 'out', 'in'),
      ],
    },
  });
});
await sleep(900);

console.log('--- cook: split -> samplePath -> place -> flatten ---');
for (const line of await readLog()) console.log(line);
const errA = await cookError();
if (errA) console.log('COOK ERROR:', errA);
await page.screenshot({ path: '/tmp/nodegfx-place.png' });

// layout-lane change: the element lane must stay cached
await page.evaluate(() => globalThis.__app.getState().setParam('sample1', 'count', 30));
await sleep(500);
console.log('--- layout count 18 -> 30: Text/Split/Shape should HIT ---');
for (const line of await readLog()) console.log(line);

console.log('---', await page.$eval('.pool', (el) => el.textContent));
await page.screenshot({ path: '/tmp/nodegfx-place30.png' });
console.log('screenshots: /tmp/nodegfx-place.png /tmp/nodegfx-place30.png');
await browser.close();
