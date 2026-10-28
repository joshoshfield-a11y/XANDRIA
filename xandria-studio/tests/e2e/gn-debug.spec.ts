import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

// Mirror the portal spec's phase 1 but diff the counted meshes.
test('gn-debug: portal mesh diff', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  // Same tutorial gate as gathering-nodes.spec.ts: the Forgotten Valley
  // fixture opens the tutorial, which keeps engine.state off 'playing'
  // until dismissed — without this the boot wait below times out.
  const skip = page.getByRole('button', { name: /SKIP TUTORIAL/i });
  if (await skip.isVisible({ timeout: 5000 }).catch(() => false)) await skip.click();
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${label}`);
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    // NOTE: engine.portalManager is NOT attached in this fixture (bootcheck
    // 2026-10-26: portalManager false while everything else is live) —
    // the probe's portal legs use engine.portalEntities, so gate on that.
    return !!(X?.engine?.portalEntities && X.engine.portalsPlayerAvatar && X.engine.state === 'playing'
      && X?.gatheringTest?.liveManager() && X?.craftingTest?.liveStations());
  }), 240_000);
  const meshList = (): Promise<string[]> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const out: string[] = [];
    X.engine.scene.traverse((o: any) => {
      if (o.isMesh && o.visible && !o.isInstancedMesh) {
        let p = o.parent;
        let chain = o.name || 'unnamed';
        while (p && p !== X.engine.scene) { chain = `${p.name || p.type}/${chain}`; p = p.parent; }
        out.push(chain);
      }
      if (o.isInstancedMesh) out.push(`INSTANCED:${o.name || o.type}`);
    });
    return out.sort();
  });
  const counts = async () => (await meshList()).length;
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalEntities.despawnAll();
  });
  const base = await meshList();
  console.log('BASE: ' + base.length);
  // Same SEED_00 as the portal spec: deriveMapSeed(20261014, 0, 0).
  const seed = (() => {
    let h = (20261014 | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ 0, 0x85ebca6b);
    h = Math.imul(h ^ 0, 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  })();
  console.log('SEED: ' + seed);
  await page.evaluate((s) => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalEntities.spawnForMap(s);
  }, seed);
  await page.waitForTimeout(5000);
  const withLayer = await meshList();
  console.log('WITH LAYER: ' + withLayer.length);
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalEntities.despawnAll();
  });
  const after = await meshList();
  console.log('AFTER DEPART: ' + after.length);
  const baseSet = new Set(base);
  const extra = after.filter((m) => !baseSet.has(m));
  const missing = base.filter((m) => !after.includes(m));
  console.log('EXTRA (in after, not base):');
  for (const m of extra) console.log('  + ' + m);
  console.log('MISSING (in base, not after):');
  for (const m of missing) console.log('  - ' + m);
  expect(true).toBe(true);
});
