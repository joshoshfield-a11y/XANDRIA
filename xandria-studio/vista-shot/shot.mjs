// Offline render → tests/e2e/shots/inv-env-vista.png
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, 'dist');
const server = spawn('python3', ['-m', 'http.server', '8901', '--directory', dist], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const errors = [];
try {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:8901/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__shotReady === true', null, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 800));
  const out = path.join(dir, '..', 'tests', 'e2e', 'shots', 'inv-env-vista.png');
  await page.screenshot({ path: out });
  console.log('shot saved:', out);
  await browser.close();
} finally {
  server.kill();
}
if (errors.length) { console.log('PAGE ERRORS:'); for (const e of errors) console.log(' ', e.slice(0, 300)); }
else console.log('no page errors');
