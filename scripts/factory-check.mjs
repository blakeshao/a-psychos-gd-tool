// First-run gate: with no saved document, the app boots into the four-layer
// factory doc extracted from the author's setup, the public image asset
// fetches, and every layer cooks without page errors.
// Usage: node scripts/factory-check.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5199/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars', '--window-size=1480,920'],
  defaultViewport: { width: 1480, height: 920 },
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => { errors.push(err.message); console.log('[pageerror]', err.message); });
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });

await page.goto(url, { waitUntil: 'networkidle0' });
// simulate a first run: wipe any saved doc and reload
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.react-flow__node', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 3000)); // let all layers cook (image fetch + GPU)

const s = await page.evaluate(() => {
  const st = globalThis.__app.getState();
  return {
    frame: st.doc.frame,
    layers: st.doc.layers.map((l) => ({ id: l.id, name: l.name, nodes: Object.keys(l.graph.nodes).length })),
    active: st.activeLayerId,
    imageSrcs: st.doc.layers.flatMap((l) =>
      Object.values(l.graph.nodes).filter((n) => n.type === 'Image').map((n) => n.params.src)),
  };
});
console.log('frame:', JSON.stringify(s.frame));
console.log('layers:', JSON.stringify(s.layers));
console.log('active layer:', s.active);
console.log('image srcs:', JSON.stringify(s.imageSrcs));

if (s.frame.width !== 2480 || s.frame.height !== 3508) throw new Error('wrong frame');
const ids = s.layers.map((l) => l.id).join(',');
if (ids !== 'layer_2,layer_3,layer_1,layer_4') throw new Error(`wrong layer stack: ${ids}`);
if (!s.imageSrcs.every((src) => src === '/factory-image.jpg')) throw new Error('image src not the public asset');

const img = await page.evaluate(async () => {
  const r = await fetch('/factory-image.jpg');
  return { ok: r.ok, bytes: (await r.blob()).size };
});
console.log('image fetch:', JSON.stringify(img));
if (!img.ok || img.bytes !== 987604) throw new Error('factory image asset missing or wrong size');

if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);

await page.screenshot({ path: '/tmp/factory-first-run.png' });
console.log('screenshot: /tmp/factory-first-run.png');
console.log('ALL CHECKS PASSED');
await browser.close();
