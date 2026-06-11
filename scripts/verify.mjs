// Drive the dev server in headless Chrome, change the blur radius, and dump
// the cook log — verifies the Phase 1 gate end to end (pixels + cache HITs).
// Usage: node scripts/verify.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5199/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell' === 'never' ? false : true,
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars', '--window-size=1280,820'],
  defaultViewport: { width: 1280, height: 820 },
});

const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[console.${msg.type()}]`, msg.text());
});
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForSelector('.cook-log li', { timeout: 15000 });

const readLog = () =>
  page.$$eval('.cook-log li', (lis) =>
    lis.map((li) => li.textContent?.replace(/\s+/g, ' ').trim()),
  );

console.log('--- cook 1 (cold) ---');
for (const line of await readLog()) console.log(line);

// nudge the blur radius and re-read the log
await page.evaluate(() => {
  const slider = [...document.querySelectorAll('.node-panel')]
    .find((p) => p.querySelector('h2')?.textContent?.includes('Blur'))
    ?.querySelector('input[type=range]');
  if (!slider) throw new Error('blur slider not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(slider, '24');
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 500));

console.log('--- cook 2 (blur radius changed) ---');
for (const line of await readLog()) console.log(line);

const pool = await page.$eval('.pool', (el) => el.textContent);
console.log('---', pool);

const err = await page.$('.cook-error');
if (err) console.log('COOK ERROR:', await err.evaluate((el) => el.textContent));

await page.screenshot({ path: '/tmp/nodegfx-verify.png' });
console.log('screenshot: /tmp/nodegfx-verify.png');
await browser.close();
