// Blur gate: cook the default graph (Text -> Outline -> Rasterize -> Blur ->
// Output) at a heavy radius and screenshot the viewport. Eyeball the halo:
// it should fade to paper with no dark rim and no hard cutoff.
// Usage: node scripts/blur-check.mjs [url]
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
page.on('console', (msg) => {
  const t = msg.text();
  if (/error|warn/i.test(msg.type()) || /WGSL|shader|pipeline/i.test(t)) console.log(`[console.${msg.type()}]`, t);
});

await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForSelector('.cook-log li', { timeout: 15000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fresh localStorage in a new profile -> factory graph, radius 8. Crank the
// blur so the halo shape is obvious in the screenshot.
await page.evaluate(() => {
  const app = globalThis.__app;
  app.getState().setParam('blur1', 'radius', 32);
});
await sleep(1000);

const canvas = await page.$('.viewport canvas');
await canvas.screenshot({ path: '/tmp/blur-check.png' });
console.log('screenshot: /tmp/blur-check.png');

await browser.close();
