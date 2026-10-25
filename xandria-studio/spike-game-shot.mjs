import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const RAW = readFileSync('tests/e2e/fixtures/npcs.b64', 'utf8').trim();
const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
spec.custom = spec.custom ?? {};
spec.custom.characters = spec.custom.characters ?? {};
spec.custom.characters.skins = {
  'spike-baked': { name: 'Spike Baked', palette: { skin: '#8a6a52', shirt: '#3d7a8c', pants: '#2a3540', accent: '#ffb43c' }, texture: { baked: 'spike-shirt' }, roughness: 0.85, metalness: 0.05 },
};
spec.custom.characters.player = { skin: 'spike-baked' };
const B64 = Buffer.from(JSON.stringify(spec)).toString('base64');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:4180/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
await page.waitForFunction(() => !!window.__XANDRIA__?.engine, { timeout: 60000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/spike-game.png', timeout: 120000 });
console.log('ERRORS:', JSON.stringify(errors));
await browser.close();
