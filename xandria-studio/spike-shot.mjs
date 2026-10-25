import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5190/spike-demo.html');
await page.waitForFunction(() => window.__SPIKE_READY__ === true, { timeout: 30000 });
await page.waitForTimeout(800);
await page.screenshot({ path: '/home/hatch/workspace/xandria/wt-gfx-spike/spike/demo-desktop.png' });
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mp = await mobile.newPage();
mp.on('pageerror', (e) => errors.push(String(e)));
await mp.goto('http://localhost:5190/spike-demo.html');
await mp.waitForFunction(() => window.__SPIKE_READY__ === true, { timeout: 30000 });
await mp.waitForTimeout(800);
await mp.screenshot({ path: '/home/hatch/workspace/xandria/wt-gfx-spike/spike/demo-mobile.png' });
console.log('ERRORS:', JSON.stringify(errors));
await browser.close();
