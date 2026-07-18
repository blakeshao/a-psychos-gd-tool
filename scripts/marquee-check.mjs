// Canvas interaction gate: two-finger scroll pans and pinch zooms; space+drag
// pans; left-drag draws a marquee that selects the boxed nodes; ⌘-click adds
// to the selection; the selected group moves as one undo step and deletes
// together. Undo restores both operations.
// Usage: node scripts/marquee-check.mjs [url]
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
await page.waitForSelector('.react-flow__node', { timeout: 15000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = () =>
  page.evaluate(() => {
    const s = globalThis.__app.getState();
    const layer = s.doc.layers.find((l) => l.id === s.activeLayerId);
    return {
      selected: [...s.selectedNodeIds].sort(),
      positions: Object.fromEntries(Object.entries(layer.graph.nodes).map(([id, n]) => [id, n.position])),
      past: s.past.length,
    };
  });

// the canvas camera — pan moves the translate, pinch changes the scale
const viewport = () =>
  page.$eval('.react-flow__viewport', (el) => {
    const m = el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/);
    return { x: +m[1], y: +m[2], zoom: +m[3] };
  });

const nodeRects = () =>
  page.$$eval('.react-flow__node', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-id'), x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );

const drag = async (x1, y1, x2, y2) => {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8);
  await page.mouse.up();
};

// pane center, clear of the palette and the poster viewport
const PANE = { x: 560, y: 700 };

// --- 1. two-finger scroll pans (no zoom change) ---
let v0 = await viewport();
await page.mouse.move(PANE.x, PANE.y);
await page.mouse.wheel({ deltaX: -40, deltaY: -60 });
await sleep(200);
let v1 = await viewport();
console.log('--- scroll pan ---');
console.log(`camera (${v0.x}, ${v0.y}) -> (${v1.x}, ${v1.y}), zoom ${v0.zoom} -> ${v1.zoom}`);
if (v1.x === v0.x && v1.y === v0.y) throw new Error('scroll did not pan');
if (v1.zoom !== v0.zoom) throw new Error('plain scroll must pan, not zoom');

// --- 2. pinch zooms (macOS trackpad pinch arrives as a ctrlKey wheel) ---
v0 = v1;
await page.evaluate(({ x, y }) => {
  document
    .querySelector('.react-flow__pane')
    .dispatchEvent(new WheelEvent('wheel', { deltaY: -80, ctrlKey: true, bubbles: true, cancelable: true, clientX: x, clientY: y }));
}, PANE);
await sleep(200);
v1 = await viewport();
console.log('--- pinch zoom ---');
console.log(`zoom ${v0.zoom} -> ${v1.zoom}`);
if (v1.zoom <= v0.zoom) throw new Error('pinch (ctrl+wheel) did not zoom in');

// --- 3. space + drag pans ---
v0 = v1;
await page.keyboard.down('Space');
await drag(PANE.x, PANE.y, PANE.x + 70, PANE.y - 50);
await page.keyboard.up('Space');
await sleep(200);
v1 = await viewport();
console.log('--- space+drag pan ---');
console.log(`camera (${v0.x}, ${v0.y}) -> (${v1.x}, ${v1.y})`);
if (v1.x === v0.x && v1.y === v0.y) throw new Error('space+drag did not pan');

// --- 4. plain left-drag draws the marquee over two on-screen nodes ---
// reload to refit the view — the pinch above zoomed way in
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.react-flow__node', { timeout: 15000 });
await sleep(300);
const visible = (r) => r.x > 260 && r.y > 60 && r.x + r.w < 1100 && r.y + r.h < 900;
const rects = (await nodeRects()).filter(visible);
if (rects.length < 3) throw new Error(`need 3+ fully visible nodes clear of the palette, got ${rects.length}`);
const [a, b, c] = rects;
const x1 = Math.min(a.x, b.x) - 12, y1 = Math.min(a.y, b.y) - 12;
const x2 = Math.max(a.x + a.w, b.x + b.w) + 12, y2 = Math.max(a.y + a.h, b.y + b.h) + 12;
await drag(x1, y1, x2, y2);
await sleep(200);

let s = await state();
console.log('--- marquee over', a.id, '+', b.id, '---');
console.log('selected:', s.selected.join(', '));
if (![a.id, b.id].every((id) => s.selected.includes(id))) throw new Error('marquee did not select the boxed nodes');

// --- 5. ⌘-click adds a node to the selection ---
await page.keyboard.down('Meta');
await page.mouse.click(c.x + c.w / 2, c.y + 8); // title bar, clear of param inputs
await page.keyboard.up('Meta');
await sleep(200);
s = await state();
console.log('--- ⌘-click', c.id, '---');
console.log('selected:', s.selected.join(', '));
const group = [a.id, b.id, c.id];
if (!group.every((id) => s.selected.includes(id))) throw new Error('⌘-click did not add to the selection');

// --- 6. drag one selected node: the group moves together, one undo step ---
const before = s;
await drag(a.x + a.w / 2, a.y + 10, a.x + a.w / 2 + 80, a.y + 10 + 60);
await sleep(200);
s = await state();
const movedIds = group.filter(
  (id) => s.positions[id].x !== before.positions[id].x || s.positions[id].y !== before.positions[id].y,
);
console.log('--- group drag ---');
console.log('moved:', movedIds.join(', '), '| history steps added:', s.past - before.past);
if (movedIds.length !== group.length) throw new Error('group drag did not move every selected node');
if (s.past - before.past !== 1) throw new Error(`group drag should be 1 undo step, got ${s.past - before.past}`);

await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await sleep(200);
s = await state();
const restored = group.every(
  (id) => s.positions[id].x === before.positions[id].x && s.positions[id].y === before.positions[id].y,
);
console.log('undo restored all positions:', restored);
if (!restored) throw new Error('undo did not restore the whole group');

// --- 7. batch delete + undo ---
s = await state();
const countBefore = Object.keys(s.positions).length;
await page.keyboard.press('Backspace');
await sleep(200);
s = await state();
console.log('--- batch delete ---');
console.log('nodes:', countBefore, '->', Object.keys(s.positions).length, '| selected now:', s.selected.length);
if (Object.keys(s.positions).length !== countBefore - group.length) throw new Error('delete did not remove the selected group');
if (s.selected.length !== 0) throw new Error('selection should clear after delete');

await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await sleep(200);
s = await state();
console.log('undo restored nodes:', Object.keys(s.positions).length === countBefore);
if (Object.keys(s.positions).length !== countBefore) throw new Error('undo did not restore deleted nodes');

await page.screenshot({ path: '/tmp/a-psychos-gd-tool-marquee.png' });
console.log('screenshot: /tmp/a-psychos-gd-tool-marquee.png');
console.log('ALL CHECKS PASSED');
await browser.close();
