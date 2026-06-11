// Drives the app in headless Chrome — the Phase 2 gate:
//  1. select the Blur node, drag its slider → upstream nodes HIT cache
//  2. drag an ILLEGAL wire (text -> raster input) → rejected, edge count unchanged
//  3. drag a LEGAL rewire (Rasterize.out -> Output.in) → Blur drops out of the
//     cook, upstream still HITs
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

const readLog = () =>
  page.$$eval('.cook-log li', (lis) => lis.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
const edgeCount = () => page.$$eval('.react-flow__edge', (els) => els.length);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dragHandle(fromNode, fromSocket, toNode, toSocket) {
  const sel = (node, socket, kind) =>
    `.react-flow__node[data-id="${node}"] .react-flow__handle.${kind}[data-handleid="${socket}"]`;
  const src = await page.waitForSelector(sel(fromNode, fromSocket, 'source'));
  const dst = await page.waitForSelector(sel(toNode, toSocket, 'target'));
  const a = await src.boundingBox();
  const b = await dst.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await sleep(400);
}

console.log('--- cook 1 (cold) ---');
for (const line of await readLog()) console.log(line);

// 1. select Blur, change radius via the inspector
await page.click('.react-flow__node[data-id="blur1"]');
await page.waitForSelector('.inspector input[type=range]');
await page.evaluate(() => {
  const slider = document.querySelector('.inspector input[type=range]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(slider, '24');
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(400);
console.log('--- cook 2 (blur radius changed via inspector) ---');
for (const line of await readLog()) console.log(line);

// 2. illegal wire: Text.out (text) -> Blur.in (raster) must be rejected
const before = await edgeCount();
await dragHandle('text1', 'out', 'blur1', 'in');
const after = await edgeCount();
console.log(`--- illegal wire text->raster: edges ${before} -> ${after} (${before === after ? 'REJECTED ok' : 'BUG: accepted!'}) ---`);

// 3. legal rewire: Rasterize.out -> Output.in (replaces Blur.out -> Output.in)
await dragHandle('raster1', 'out', 'out', 'in');
console.log('--- cook 3 (rewired Rasterize directly into Output) ---');
for (const line of await readLog()) console.log(line);

const pool = await page.$eval('.pool', (el) => el.textContent);
console.log('---', pool);
const err = await page.$('.cook-error');
if (err) console.log('COOK ERROR:', await err.evaluate((el) => el.textContent));

await page.screenshot({ path: '/tmp/nodegfx-verify.png' });
console.log('screenshot: /tmp/nodegfx-verify.png');
await browser.close();
