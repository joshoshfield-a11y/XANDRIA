/**
 * UPGRADE LOOP (character-customization): e2e verification.
 *
 * Leg 1 (npcs fixture, desktop + 360x780): open the customization panel,
 * pick visor + outfit + scarf + trim, assert the LIVE figure renders them
 * (role materials, not just the profile), assert the profile persisted,
 * reload and assert the rebuilt figure still wears them, assert every
 * panel control is >= 28px and the centered panel overlaps no HUD chip.
 *
 * Leg 2 (portal fixture, one N traversal): the same picks survive a real
 * portal traversal (coord flips, transition fires) — the avatar rig is not
 * map-local, and the profile store is untouched by travel.
 *
 * Zero console/page errors on both legs.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const NPCS_B64 = withItems(NPCS_RAW);

const PORTAL_SPECS = existsSync('/tmp/portal-specs/portal-8km.b64')
  ? '/tmp/portal-specs'
  : '/home/hatch/workspace/xandria/qa/openworld/workers-portals';
const PORTAL_B64 = readFileSync(`${PORTAL_SPECS}/portal-8km.b64`, 'utf8').trim();

type X = { __XANDRIA__?: any };

async function waitFor(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(2000);
  }
}

/** Role-material colors + cape-piece count off the live player rig. */
async function rigLook(page: any) {
  return page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const rig = X.engine.portalsPlayerAvatar.ctrl.rig;
    const roles: Record<string, { color: number; emissive: number }> = {};
    let cape = 0;
    rig.group.traverse((o: any) => {
      if (!o.isMesh) return;
      if (o.userData?.capePiece === true) cape++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const role = m?.userData?.role;
        if (m?.userData?.owned && typeof role === 'string' && !(role in roles)) {
          roles[role] = { color: m.color.getHex(), emissive: m.emissive.getHex() };
        }
      }
    });
    return { roles, cape };
  });
}

async function storedCosmetics(page: any) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('xandria.slots.v1');
    if (!raw) return null;
    const store = JSON.parse(raw);
    const active = store.slots.find((s: any) => s.id === store.activeSlotId) ?? store.slots[0];
    return active.profile.cosmetics ?? null;
  });
}

test('customization: pick -> live figure -> persist -> reload, desktop + 360x780', async ({ page }) => {
  // SwiftShader boots are slow (two boots in this test); the default 90s
  // config timeout is not enough for the mobile leg.
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(NPCS_B64)}&test=1&autostart=1&splash=0`);
  await waitFor(page, 'boot', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X?.questTest && X?.gatheringTest && X?.craftingTest
      && X?.blueprint?.quests && X?.blueprint?.npcs && X?.blueprint?.itemKit
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
    X.engine.customizationPanel.show();
  });
  const panel = page.locator('[data-testid="customization-panel"]');
  await expect(panel).toBeVisible();

  // no overlap with the visible HUD chips (objective top-left, score top-right, bars bottom-left)
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  for (const sel of ['.xhud .panel.objective', '.xhud .panel.score', '.xhud .panel.bars']) {
    const box = await page.locator(sel).boundingBox();
    if (!box || box.width === 0) continue;
    const overlaps = panelBox!.x < box.x + box.width && panelBox!.x + panelBox!.width > box.x
      && panelBox!.y < box.y + box.height && panelBox!.y + panelBox!.height > box.y;
    expect(overlaps, `${sel} overlaps the customization panel`).toBe(false);
  }

  // pick: cyan visor, stealth outfit, scarf on, gold trim
  await page.locator('[data-testid="visor-cyan"]').click();
  await page.locator('[data-testid="outfit-stealth"]').click();
  await page.locator('[data-testid="acc-scarf"]').click();
  await page.locator('[data-testid="trim-gold"]').click();

  let look = await rigLook(page);
  expect(look.roles.accent.emissive).toBe(0x35e0ff); // cyan visor
  expect(look.roles.shirt.color).toBe(0x1a1d24); // stealth shirt
  expect(look.roles.accent.color).toBe(0xd8a428); // gold trim
  expect(look.cape).toBeGreaterThan(0); // mantle drape on
  expect(await storedCosmetics(page)).toEqual(
    { visor: 'cyan', outfit: 'stealth', scarf: true, hood: false, trim: 'gold' });

  // reload: the rebuilt figure wears the same look (construction path)
  await page.reload();
  await waitFor(page, 'reboot', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  look = await rigLook(page);
  expect(look.roles.accent.emissive).toBe(0x35e0ff);
  expect(look.roles.shirt.color).toBe(0x1a1d24);
  expect(look.cape).toBeGreaterThan(0);

  // mobile: panel controls stay >= 28px at 360x780
  await page.setViewportSize({ width: 360, height: 780 });
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.customizationPanel.show();
  });
  await expect(panel).toBeVisible();
  // single round-trip measurement (evaluateAll re-resolves per element and
  // stalls on a busy SwiftShader frame loop)
  const sizes = await panel.evaluate((el: any) => [...el.querySelectorAll('button')].map((b: any) => {
    const r = b.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }));
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) {
    expect(s.w).toBeGreaterThanOrEqual(28);
    expect(s.h).toBeGreaterThanOrEqual(28);
  }
  await page.locator('[data-testid="customization-close"]').click();
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test('customization survives a real portal traversal', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(PORTAL_B64)}&test=1&autostart=1&splash=0`);
  await waitFor(page, 'boot', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine?.portalManager && X.engine.portalsPlayerAvatar && X.engine.state === 'playing');
  }), 240_000);

  // dress the figure before travel: venom visor + crimson outfit
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.customizationPanel.show();
  });
  await page.locator('[data-testid="visor-venom"]').click();
  await page.locator('[data-testid="outfit-crimson"]').click();
  let look = await rigLook(page);
  expect(look.roles.accent.emissive).toBe(0x4dff6a);
  expect(look.roles.shirt.color).toBe(0x8a1f1f);
  await page.locator('[data-testid="customization-close"]').click();

  // walk north through the portal (portal-traverse procedure, one leg)
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const HALF = 4000;
    const tx = 100;
    const tz = HALF - 11;
    const y = E.terrain.heightAt(tx, tz) + 3;
    E.streamFocus = new V(tx, y, tz);
    const av = E.portalsPlayerAvatar;
    av.ctrl.teleport(new V(tx, y, tz));
    av.health = av.maxHealth = 1e9;
    const want = Math.PI;
    let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    E.input.look.x = -d / 0.0026;
  });
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
  });
  await waitFor(page, 'transition', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.engine.portalManager.transitions >= 1;
  }), 300_000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject([], null);
  });
  const coord = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return { ...X.engine.portalManager.coord };
  });
  expect(coord).toEqual({ mx: 0, my: 1 });

  // the figure still wears the picks after arrival, and the store is untouched
  look = await rigLook(page);
  expect(look.roles.accent.emissive).toBe(0x4dff6a);
  expect(look.roles.shirt.color).toBe(0x8a1f1f);
  expect(await storedCosmetics(page)).toMatchObject({ visor: 'venom', outfit: 'crimson' });
  expect(errors).toEqual([]);
});
