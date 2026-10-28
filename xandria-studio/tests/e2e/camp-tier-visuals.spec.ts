/**
 * Camp-tier-visuals wave — tiered visuals for camp structures.
 *
 * Desktop (portal 8km fixture): build all three structures at tier 0 and
 * assert the rendered props match the visual table exactly (parts, amber
 * glow count, height). Upgrade through the real panel UI and the manager
 * path: the rendered visual tier changes immediately, with no reload and
 * no portal trip, and matches the table at every tier. Instancer buckets
 * + registered counts are IDENTICAL at tier 0 and tier 2 (tier extras
 * reuse existing geometry/material roles — instances, not buckets), and
 * draw calls get only the camp-upgrades blowup guard. A walked portal
 * round-trip restores the origin camp's visuals identically, and a second
 * map's camp renders its own tier. Capabilities are unchanged (chest
 * capacity, workbench/rest tier effects exact).
 * Mobile 360x780: panel upgrade taps change the rendered visual tier.
 * Reload: visuals + tiers + chest survive a page reload identically.
 *
 * Follows the camp-upgrades.spec.ts harness: all waits poll engine state
 * (never wall time), generous SwiftShader timeouts.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const PORTAL_RAW = readFileSync(
  '/home/hatch/workspace/xandria/qa/openworld/workers-portals/portal-8km.b64', 'utf8').trim();

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);
const PORTAL_B64 = withItems(PORTAL_RAW);

const URL = `/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`;
const PORTAL_URL = `/player.html?spec=${encodeURIComponent(PORTAL_B64)}&test=1&autostart=1&splash=0`;

type X = { __XANDRIA__?: any };

const waitFor = async (
  page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number,
) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(200);
  }
};

const bootWait = (page: any) => waitFor(page, 'boot', () => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  return !!(X?.engine && X?.campTest && X?.blueprint?.camp && X?.blueprint?.itemKit
    && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
}), 240_000);

const quietField = async (page: any, keepEnemies: boolean) => {
  await page.evaluate((keepEnemies: boolean) => {
    const X = (window as unknown as X).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs' || (!keepEnemies && s.id === 'enemies')) s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  }, keepEnemies);
};

const grant = async (page: any) => {
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    inv.add('mat_ore', 99); inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
  });
};

const teleport = (page: any, x: number, z: number): Promise<void> => page.evaluate(([x, z]: number[]) => {
  const X = (window as unknown as X).__XANDRIA__;
  const E = X.engine;
  const V = E.camera.position.constructor;
  const y = E.terrain.heightAt(x, z) + 3;
  E.portalsPlayerAvatar.ctrl.teleport(new V(x, y, z));
}, [x, z]);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const sampleDraws = async (page: any, n: number): Promise<number> => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.renderer.info.render.calls));
    await page.waitForTimeout(1500);
  }
  return median(out);
};

// Instancer state: the true geometry signal (same helper as camp-upgrades).
const sampleInstancer = async (page: any) => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  const inst = (X.blueprint.enemies as unknown as { instancer?: { bucketCount: number; registeredNpcCount: number } }).instancer;
  return { buckets: inst?.bucketCount ?? -1, registered: inst?.registeredNpcCount ?? -1 };
});

/** Rendered visual descriptors, normalized (height to 4dp) + the table's expected counts. */
const visuals = async (page: any) => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  const mgr = X.campTest.liveManager();
  return mgr.propVisuals().map((v: any) => {
    const expected = X.campTest.campTierVisualParts(v.kind, v.tier);
    return { kind: v.kind, tier: v.tier, parts: v.parts, amberParts: v.amberParts, height: +v.height.toFixed(4), expected };
  }).sort((a: any, b: any) => a.kind.localeCompare(b.kind));
});

const assertVisualTable = (vs: any[], tiers: Record<string, number>) => {
  expect(vs.map((v: any) => v.kind)).toEqual(['chest', 'rest', 'workbench']);
  for (const v of vs) {
    expect(v.tier, `${v.kind} visual tier`).toBe(tiers[v.kind]);
    expect(v.parts, `${v.kind} tier ${v.tier} part count`).toBe(v.expected.parts);
    expect(v.amberParts, `${v.kind} tier ${v.tier} amber count`).toBe(v.expected.amberParts);
    expect(v.height, `${v.kind} tier ${v.tier} has height`).toBeGreaterThan(0);
  }
  // Heights strictly increase with tier (checked across the tier sets by the caller).
};

const walkThrough = async (page: any, edge: 'N' | 'S', fromTransitions: number) => {
  await page.evaluate((edge: 'N' | 'S') => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const HALF = 4000;
    const tx = 100;
    const tz = edge === 'N' ? HALF - 11 : -(HALF - 11);
    const y = E.terrain.heightAt(tx, tz) + 3;
    E.streamFocus = new V(tx, y, tz);
    E.portalsPlayerAvatar.ctrl.teleport(new V(tx, y, tz));
    const want = edge === 'N' ? Math.PI : 0;
    let d = (want - E.portalsPlayerAvatar.ctrl.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    E.input.look.x = -d / 0.0026;
  }, edge);
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.engine.input.inject(['forward', 'sprint'], null);
  });
  await waitFor(page, `transition to ${fromTransitions + 1}`, () => page.evaluate((n: number) =>
    (window as unknown as X).__XANDRIA__!.engine.portalManager.transitions >= n, fromTransitions + 1), 300_000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.engine.input.inject([], null);
  });
};

test('camp-tier-visuals: tier visuals change on upgrade, survive portal travel, desktop 8km', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(PORTAL_URL);
  await bootWait(page);
  await quietField(page, false);
  await grant(page);

  const built = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    const out: Record<string, boolean> = {};
    for (const id of ['chest', 'workbench', 'rest']) out[id] = mgr.buildStructure(id).ok;
    return { built: out, site: { x: mgr.site.x, z: mgr.site.z } };
  });
  expect(built.built).toEqual({ chest: true, workbench: true, rest: true });

  // ---- tier 0 visuals match the table exactly, from the camp-site view ----
  await teleport(page, built.site.x, built.site.z);
  await page.waitForTimeout(20_000);
  const draws0 = await sampleDraws(page, 10);
  const inst0 = await sampleInstancer(page);
  const v0 = await visuals(page);
  assertVisualTable(v0, { chest: 0, workbench: 0, rest: 0 });
  const heights0: Record<string, number> = {};
  for (const v of v0) heights0[v.kind] = v.height;

  // ---- real panel UI: [E] prompt -> upgrade chest one tier, visual changes at once ----
  await waitFor(page, 'camp prompt live', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.campTest.liveSession().promptedCamp), 60_000);
  await page.keyboard.press('e');
  await waitFor(page, 'camp panel opens on E', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.campTest.liveSession().isPanelOpen), 30_000);
  await page.click('#xandria-camp-upgrade-chest');
  await waitFor(page, 'panel upgrade raises chest tier', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.campTest.liveManager().tierOf('chest') === 1), 30_000);
  const vPanel = await visuals(page);
  assertVisualTable(vPanel, { chest: 1, workbench: 0, rest: 0 });
  expect(vPanel.find((v: any) => v.kind === 'chest')!.height, 'chest stack grows on upgrade').toBeGreaterThan(heights0.chest);
  await page.keyboard.press('Escape');
  await waitFor(page, 'camp panel closes on Esc', () => page.evaluate(() =>
    !(window as unknown as X).__XANDRIA__.campTest.liveSession().isPanelOpen), 30_000);
  await waitFor(page, 'game pauses after panel Escape', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.state === 'paused'), 300_000);
  await page.keyboard.press('Escape');
  await waitFor(page, 'game resumes after second Escape', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.state === 'playing'), 300_000);

  // ---- remaining upgrades via the manager path; visuals track every tier ----
  const upgraded = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    const out: Record<string, boolean> = {};
    out.chest2 = mgr.upgradeStructure('chest').ok;
    out.wb1 = mgr.upgradeStructure('workbench').ok;
    out.wb2 = mgr.upgradeStructure('workbench').ok;
    out.rest1 = mgr.upgradeStructure('rest').ok;
    out.rest2 = mgr.upgradeStructure('rest').ok;
    return { out, tiers: { chest: mgr.tierOf('chest'), workbench: mgr.tierOf('workbench'), rest: mgr.tierOf('rest') } };
  });
  expect(upgraded.out).toEqual({ chest2: true, wb1: true, wb2: true, rest1: true, rest2: true });
  expect(upgraded.tiers).toEqual({ chest: 2, workbench: 2, rest: 2 });
  const v2 = await visuals(page);
  assertVisualTable(v2, { chest: 2, workbench: 2, rest: 2 });
  for (const v of v2) {
    expect(v.height, `${v.kind} tier 2 taller than tier 0`).toBeGreaterThan(heights0[v.kind]);
  }

  // ---- capabilities unchanged by the visual rebuild ----
  const effects = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    const avatar = X.engine.portalsPlayerAvatar;
    avatar.health = 37;
    mgr.activateWorkbench();
    const rest = mgr.rest();
    return {
      wbMult: mgr.workbenchDamageMult(), wbRem: mgr.workbenchBuffRemaining(),
      restOk: rest.ok, health: avatar.health, max: avatar.maxHealth,
      restedMult: mgr.restedDamageMult(), restedRem: mgr.restedBuffRemaining(),
      capacity: mgr.chestCapacity(),
    };
  });
  expect(effects.wbMult, 'workbench tier 2 = 1.35x').toBe(1.35);
  expect(effects.wbRem, 'workbench tier 2 = 1200s').toBe(1200);
  expect(effects.restOk).toBe(true);
  expect(effects.health, 'rest still restores HP exactly').toBe(effects.max);
  expect(effects.restedMult, 'rest tier 2 = 1.1x').toBe(1.1);
  expect(effects.restedRem, 'rest tier 2 = 600s').toBe(600);
  expect(effects.capacity, 'chest tier 2 = 800').toBe(800);

  // ---- perf: tier extras add instances, not buckets (same view as tier 0) ----
  await teleport(page, built.site.x, built.site.z);
  await page.waitForTimeout(10_000);
  const draws2 = await sampleDraws(page, 10);
  const inst2 = await sampleInstancer(page);
  expect(inst2.registered, `tier rebuild registers no extra props (tier0=${inst0.registered} tier2=${inst2.registered})`).toBe(inst0.registered);
  expect(inst2.buckets, `tier visuals add no buckets (tier0=${inst0.buckets} tier2=${inst2.buckets})`).toBe(inst0.buckets);
  expect(Math.abs(draws2 - draws0), `no draw blowup tier 0 -> tier 2 (tier0=${draws0} tier2=${draws2})`).toBeLessThan(60);

  // ---- portal round-trip: walk N, build + upgrade a camp there, walk S back ----
  await walkThrough(page, 'N', 0);
  await waitFor(page, 'minimap arrives on a new map', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.minimap.activeKey !== '0,0'), 600_000);
  await grant(page);
  const north = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    const builtChest = mgr.buildStructure('chest').ok;
    const upgradedChest = mgr.upgradeStructure('chest').ok;
    return { builtChest, upgradedChest, visuals: mgr.propVisuals() };
  });
  expect(north.builtChest, 'second camp builds on the walked-to map').toBe(true);
  expect(north.upgradedChest, 'second camp upgrades on the walked-to map').toBe(true);
  expect(north.visuals, 'new map renders the tier-1 chest visual').toHaveLength(1);
  expect(north.visuals[0].tier).toBe(1);
  expect(north.visuals[0].parts, 'tier-1 chest visual = 8 parts').toBe(8);
  expect(north.visuals[0].amberParts, 'tier-1 chest visual = 0 amber parts').toBe(0);
  await walkThrough(page, 'S', 1);
  await waitFor(page, 'minimap back on origin', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.minimap.activeKey === '0,0'), 600_000);
  await page.waitForTimeout(5000);
  const vBack = await visuals(page);
  assertVisualTable(vBack, { chest: 2, workbench: 2, rest: 2 });
  expect(vBack, 'origin visuals identical after the portal round-trip').toEqual(v2);

  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test.describe('mobile 360x780', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('camp-tier-visuals: panel upgrade taps change the rendered visual tier', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

    await page.goto(PORTAL_URL);
    await bootWait(page);
    await quietField(page, false);
    await grant(page);
    await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const mgr = X.campTest.liveManager();
      for (const id of ['chest', 'workbench', 'rest']) mgr.buildStructure(id);
    });
    const v0 = await visuals(page);
    assertVisualTable(v0, { chest: 0, workbench: 0, rest: 0 });
    await page.evaluate(() => (window as unknown as X).__XANDRIA__.campTest.liveSession().open());
    const box = await page.locator('#xandria-camp-panel').boundingBox();
    expect(box, 'camp panel visible at 360px').toBeTruthy();
    expect(box!.x + box!.width, 'panel fits the 360px viewport').toBeLessThanOrEqual(360);
    for (const id of ['chest', 'workbench', 'rest']) {
      const upBtn = await page.locator(`#xandria-camp-upgrade-${id}`).boundingBox();
      expect(upBtn, `${id} upgrade button has a box`).toBeTruthy();
      await page.touchscreen.tap(upBtn!.x + upBtn!.width / 2, upBtn!.y + upBtn!.height / 2);
      await waitFor(page, `touch upgrade raises ${id} tier`, () => page.evaluate((want: string) =>
        (window as unknown as X).__XANDRIA__.campTest.liveManager().tierOf(want) === 1, id), 30_000);
    }
    const v1 = await visuals(page);
    assertVisualTable(v1, { chest: 1, workbench: 1, rest: 1 });
    await page.evaluate(() => {
      const panel = document.querySelector('#xandria-camp-panel') as HTMLElement;
      const btns = [...panel.querySelectorAll('button')];
      btns.find((b) => b.textContent?.includes('Leave'))?.click();
    });
    await waitFor(page, 'panel closes', () => page.evaluate(() =>
      !(window as unknown as X).__XANDRIA__.campTest.liveSession().isPanelOpen), 30_000);

    expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
  });
});

test('camp-tier-visuals: reload preserves visuals + tiers + chest', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(URL);
  await bootWait(page);
  await quietField(page, false);
  await grant(page);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    for (const id of ['chest', 'workbench', 'rest']) mgr.buildStructure(id);
    for (const id of ['chest', 'workbench', 'rest']) { mgr.upgradeStructure(id); mgr.upgradeStructure(id); }
    mgr.deposit('mat_ore', 5);
  });
  const beforeVisuals = await visuals(page);
  assertVisualTable(beforeVisuals, { chest: 2, workbench: 2, rest: 2 });
  const before = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    return {
      tiers: { chest: mgr.tierOf('chest'), workbench: mgr.tierOf('workbench'), rest: mgr.tierOf('rest') },
      capacity: mgr.chestCapacity(), contents: mgr.chestContents,
    };
  });
  expect(before.tiers).toEqual({ chest: 2, workbench: 2, rest: 2 });
  await page.reload();
  await bootWait(page);
  const afterVisuals = await visuals(page);
  expect(afterVisuals, 'reload restores visuals identically').toEqual(beforeVisuals);
  const after = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    return {
      tiers: { chest: mgr.tierOf('chest'), workbench: mgr.tierOf('workbench'), rest: mgr.tierOf('rest') },
      capacity: mgr.chestCapacity(), contents: mgr.chestContents,
    };
  });
  expect(after, 'reload restores tiers + chest + capacity').toEqual(before);

  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});
