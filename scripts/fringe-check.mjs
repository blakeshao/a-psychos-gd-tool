// Edge-fringe gate: render white text on a white background and scan the
// viewport for dark pixels. Soft glyph edges must stay white — any gray/black
// rim means transparent-black texels leaked into the composite (straight-alpha
// filtering or src-over onto a transparent ground without un-premultiplying).
// Usage: node scripts/fringe-check.mjs [url]
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

// the factory render first, for eyeballing that normal colors still composite
// right (white glyphs, teal stroke, purple paper)
const canvas = await page.$('.viewport canvas');
await canvas.screenshot({ path: '/tmp/fringe-default.png' });

// then force white-on-white: white fill (already the default), stroke off,
// white paper. The Place scale binds keep the rasters scaled, so filtering
// fringes would show too, not just compositing ones.
await page.evaluate(() => {
  const app = globalThis.__app;
  app.getState().setParam('text1', 'stroke', false);
  app.getState().setParam('out', 'background', '#ffffff');
});
await sleep(1500);

// clip to the left part of the canvas — the layer panel overlays the top
// right corner and its UI chrome would read as dark pixels
const box = await canvas.boundingBox();
const clip = { x: box.x + 2, y: box.y + 2, width: Math.floor(box.width * 0.55), height: Math.floor(box.height - 4) };
const png = await page.screenshot({ clip, encoding: 'base64' });

// decode in the page (node has no png reader here) and scan
const scan = await page.evaluate(async (b64) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}`; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let dark = 0, darkest = 255;
  for (let i = 0; i < data.length; i += 4) {
    const m = Math.min(data[i], data[i + 1], data[i + 2]);
    if (m < darkest) darkest = m;
    if (m < 230) dark++;
  }
  return { pixels: data.length / 4, dark, darkest };
}, png);

await page.screenshot({ clip, path: '/tmp/fringe-check.png' });
console.log('screenshots: /tmp/fringe-default.png (factory), /tmp/fringe-check.png (white-on-white)');
console.log(`scanned ${scan.pixels} px — ${scan.dark} darker than 230, darkest channel ${scan.darkest}`);
console.log(scan.dark === 0 ? 'PASS: white-on-white stays white' : 'FAIL: dark fringe present');

await browser.close();
process.exit(scan.dark === 0 ? 0 : 1);
