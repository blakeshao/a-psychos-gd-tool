// Frame config gate: editing the frame in the sidebar re-cooks exactly the
// frame-aware nodes (Rasterize/Noise/Output) and their descendants — Text and
// vector ops stay cached — and the artboard canvas takes the new size.
// Usage: node scripts/verify.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5199/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
const canvasSize = () =>
  page.$eval('.viewport canvas', (c) => `${c.width}x${c.height}`);

console.log('--- cook 1 (default graph, default frame) ---');
for (const line of await readLog()) console.log(line);
console.log('canvas:', await canvasSize());

// type a new frame width into the sidebar config
await page.evaluate(() => {
  const input = document.querySelector('.frame-config input[type=number]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '1024');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(500);

console.log('--- frame width 768 -> 1024 via UI ---');
for (const line of await readLog()) console.log(line);
console.log('canvas:', await canvasSize());
const err = await page.$('.cook-error');
if (err) console.log('COOK ERROR:', await err.evaluate((el) => el.textContent));
console.log('---', await page.$eval('.pool', (el) => el.textContent));

await page.screenshot({ path: '/tmp/nodegfx-frame.png' });
console.log('screenshot: /tmp/nodegfx-frame.png');
await browser.close();
