/**
 * Player-camp wave — build -> store -> rest -> workbench buff -> panel ->
 * minimap marker, plus the portal round-trip persistence leg and the
 * INSTANCING.md perf leg.
 *
 * Flow (desktop): boot the deterministic "Forgotten Valley" scene (seed
 * 20261012, tp-action, 512m walled arena) with an empty custom.items table
 * (ensureCraftingItemDefs fills it at boot) -> despawn NPCs (quiet field;
 * enemies stay live for the melee-buff leg) and make the player invincible
 * -> grant tier-1 materials -> build all three camp structures via the
 * shipped manager path -> exercise the real panel UI (open via the [E]
 * prompt path, click Store/Take, Esc closes) -> rest restores HP exactly
 * -> workbench buff multiplies a real input-path melee swing by exactly
 * 1.1x -> camp marker painted on the minimap canvas.
 * Portal leg: on the 8km fixture, build chest + store an item, cross north
 * and back south — the chest contents survive travel and the origin
 * camp's structures + site are restored from the profile.
 * Perf leg: A/B/A draw-call delta of a fully built camp (desktop + s25).
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to the enemy (never the reverse), all waits poll from Node,
 * enemy pinning + facing re-apply every poll slice under SwiftShader's
 * slow frames; all movement assertions key off engine.time, never wall time.
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

test('camp: build -> store -> rest -> buff -> panel -> minimap marker, desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(URL);
  await bootWait(page);
  await quietField(page, true); // keep enemies for the melee-buff leg

  // ---- build all three structures via the shipped manager path ----
  await grant(page);
  const built = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    const out: Record<string, boolean> = {};
    for (const id of ['chest', 'workbench', 'rest']) out[id] = mgr.buildStructure(id).ok;
    const inv = X.blueprint.itemKit.inventory;
    return {
      built: out, site: { x: mgr.site.x, z: mgr.site.z }, builtList: [...mgr.built],
      counts: { ore: inv.count('mat_ore'), fiber: inv.count('mat_fiber'), scrap: inv.count('mat_scrap') },
    };
  });
  expect(built.built, 'all three structures build').toEqual({ chest: true, workbench: true, rest: true });
  expect(built.builtList.sort()).toEqual(['chest', 'rest', 'workbench']);
  // exact material consumption: chest 4 scrap+2 fiber, workbench 4 ore+4 scrap, rest 4 fiber+2 scrap
  expect(built.counts, 'exact build costs consumed').toEqual({ ore: 95, fiber: 93, scrap: 89 });

  // ---- real panel UI: [E] prompt path -> Store/Take clicks -> Esc ----
  await teleport(page, built.site.x, built.site.z);
  await waitFor(page, 'camp prompt live', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.campTest.liveSession().promptedCamp), 60_000);
  await page.keyboard.press('e');
  await waitFor(page, 'camp panel opens on E', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.campTest.liveSession().isPanelOpen), 30_000);
  const panelBox = await page.locator('#xandria-camp-panel').boundingBox();
  expect(panelBox, 'camp panel has a box').toBeTruthy();
  await page.click('#xandria-camp-deposit-mat_ore');
  const afterStore = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.campTest.liveManager().chestContents;
  });
  expect(afterStore, 'panel Store click deposits exactly 1').toEqual({ mat_ore: 1 });
  await page.click('#xandria-camp-withdraw-mat_ore');
  const afterTake = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.campTest.liveManager().chestContents;
  });
  expect(afterTake, 'panel Take click withdraws exactly 1').toEqual({});
  await page.keyboard.press('Escape');
  await waitFor(page, 'camp panel closes on Esc', () => page.evaluate(() =>
    !(window as unknown as X).__XANDRIA__.campTest.liveSession().isPanelOpen), 30_000);
  // Engine M9 behavior (shared with every panel): the same Escape keydown
  // also queues a pause edge, consumed on the next rendered frame — under
  // SwiftShader a frame can take tens of wall seconds. The melee legs need
  // a running game, so wait for the pause to land, Escape again to resume,
  // and wait for 'playing' before any input-path swing.
  await waitFor(page, 'game pauses after panel Escape', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.state === 'paused'), 300_000);
  await page.keyboard.press('Escape');
  await waitFor(page, 'game resumes after second Escape', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.state === 'playing'), 300_000);

  // ---- storage chest via the manager path (exact counts) ----
  const chest = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    const d = mgr.deposit('mat_ore', 5);
    const w = mgr.withdraw('mat_ore', 2);
    return { deposited: d, withdrawn: w, contents: mgr.chestContents };
  });
  expect(chest, 'deposit 5 / withdraw 2 exact').toEqual({ deposited: 5, withdrawn: 2, contents: { mat_ore: 3 } });

  // ---- rest restores HP exactly ----
  const rest = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const avatar = X.engine.portalsPlayerAvatar;
    avatar.health = 37;
    const r = X.campTest.liveManager().rest();
    return { ok: r.ok, health: avatar.health, max: avatar.maxHealth };
  });
  expect(rest.ok, 'rest succeeds').toBe(true);
  expect(rest.health, 'rest restores HP exactly to max').toBe(rest.max);

  // ---- workbench buff multiplies a real input-path melee swing by 1.1x ----
  // pin the healthiest enemy 2m from the player, face it, swing via the
  // real attack input; re-pin + re-face every poll slice.
  const meleeSetup = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const enemies = X.blueprint.enemies.enemies.filter((e: any) => e.alive);
    enemies.sort((a: any, b: any) => b.health - a.health);
    const e = enemies[0];
    e.health = 1e6;
    const avatar = X.engine.portalsPlayerAvatar;
    const V = avatar.ctrl.position.constructor;
    avatar.ctrl.teleport(new V(e.position.x + 2, e.position.y + 1, e.position.z));
    (window as any).__campFoe = e;
    return { foeHealth: e.health };
  });
  const pinAndFace = async () => {
    await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const e = (window as any).__campFoe;
      const avatar = X.engine.portalsPlayerAvatar;
      const pp = avatar.ctrl.position;
      // enemy 2m from the player on the +x side; face it exactly.
      // melee forward is (-sin yaw, -cos yaw), so yaw = atan2(-dx, -dz)
      // makes forward = (dx, dz)/|..| exactly.
      if (e?.alive && e.body) {
        e.body.position.set(pp.x + 2, pp.y, pp.z);
        e.body.velocity.set(0, 0, 0);
      }
      avatar.ctrl.yaw = Math.atan2(-2, 0);
    });
  };
  const swing = async (): Promise<number> => {
    await pinAndFace();
    const before = await page.evaluate(() => (window as any).__campFoe.health);
    await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.input.tap('attack'));
    await waitFor(page, 'melee lands', async () => {
      await pinAndFace();
      const h = await page.evaluate(() => (window as any).__campFoe.health);
      return h < before;
    }, 120_000);
    const after = await page.evaluate(() => (window as any).__campFoe.health);
    return before - after;
  };
  const delta1 = await swing();
  expect(delta1, 'unbuffed melee deals damage').toBeGreaterThan(0);
  const buff = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const r = X.campTest.liveManager().activateWorkbench();
    return { ok: r.ok, mult: X.campTest.liveManager().workbenchDamageMult() };
  });
  expect(buff.ok, 'workbench activates').toBe(true);
  expect(buff.mult, 'workbench multiplier is 1.1x').toBe(1.1);
  const delta2 = await swing();
  expect(delta2 / delta1, `buffed swing is exactly 1.1x (${delta1} -> ${delta2})`).toBeCloseTo(1.1, 2);

  // ---- minimap camp marker: seam + painted green pixels ----
  // Poll for the painted pixels: under SwiftShader the minimap's 0.5s
  // game-time scan throttle can take many wall seconds per redraw.
  await teleport(page, built.site.x, built.site.z);
  let marker: { camp: { x: number; z: number }; green: number } | null = null;
  await waitFor(page, 'camp diamond painted', async () => {
    marker = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const M = X.engine.minimap;
      const camp = M.campMarker;
      if (!camp) return null;
      const half = 256, W = 208;
      const px = ((camp.x + half) / (half * 2)) * W;
      const py = ((half - camp.z) / (half * 2)) * W;
      const canvas = document.querySelector('#xandria-minimap canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.getImageData(Math.max(0, Math.floor(px) - 6), Math.max(0, Math.floor(py) - 6), 13, 13);
      let green = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (g > 180 && r < 150 && b > 80) green++;
      }
      return { camp, green };
    });
    return !!marker && marker.green > 0;
  }, 180_000);
  expect(marker, 'minimap camp marker exists').toBeTruthy();
  expect(Math.abs(marker!.camp.x - built.site.x), 'marker x matches the site').toBeLessThan(1);
  expect(Math.abs(marker!.camp.z - built.site.z), 'marker z matches the site').toBeLessThan(1);
  expect(marker!.green, 'camp diamond painted on the minimap').toBeGreaterThan(0);

  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test('camp: portal round-trip keeps chest + restores origin camp, desktop 8km', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(PORTAL_URL);
  await bootWait(page);
  await quietField(page, false);
  await grant(page);
  const origin = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    const chestOk = mgr.buildStructure('chest').ok;
    const deposited = mgr.deposit('mat_ore', 5);
    return {
      chestOk, deposited, site: { x: mgr.site.x, z: mgr.site.z },
      built: [...mgr.built], chest: mgr.chestContents,
    };
  });
  expect(origin.chestOk, 'origin chest builds').toBe(true);
  expect(origin.deposited, 'origin deposit lands').toBe(5);

  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
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

  await walkThrough('N', 0);
  await waitFor(page, 'minimap arrives on a new map', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.minimap.activeKey !== '0,0'), 600_000);
  const away = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    return {
      key: X.engine.minimap.activeKey,
      chest: mgr.chestContents,
      site: mgr.site ? { x: mgr.site.x, z: mgr.site.z } : null,
    };
  });
  expect(away.key, 'travelled to a new map').not.toBe('0,0');
  expect(away.chest, 'chest contents survive portal travel').toEqual({ mat_ore: 5 });

  await walkThrough('S', 1);
  await waitFor(page, 'minimap back on origin', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.minimap.activeKey === '0,0'), 600_000);
  const back = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    return {
      key: X.engine.minimap.activeKey,
      chest: mgr.chestContents,
      built: [...mgr.built],
      site: mgr.site ? { x: mgr.site.x, z: mgr.site.z } : null,
    };
  });
  expect(back.key, 'back on the origin map').toBe('0,0');
  expect(back.built, 'origin camp structures restored from the profile').toContain('chest');
  expect(back.chest, 'chest contents survive the round trip').toEqual({ mat_ore: 5 });
  expect(Math.abs(back.site!.x - origin.site.x), 'origin site identical after return').toBeLessThan(1);
  expect(Math.abs(back.site!.z - origin.site.z), 'origin site identical after return').toBeLessThan(1);

  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test.describe('mobile 360x780', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('camp: panel opens at 360px, Store tap works, Leave closes', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

    await page.goto(URL);
    await bootWait(page);
    await quietField(page, false);
    await grant(page);
    const site = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const mgr = X.campTest.liveManager();
      mgr.buildStructure('chest');
      return { x: mgr.site.x, z: mgr.site.z };
    });
    await teleport(page, site.x, site.z);
    await waitFor(page, 'camp prompt live', () => page.evaluate(() =>
      (window as unknown as X).__XANDRIA__.campTest.liveSession().promptedCamp), 60_000);
    await page.evaluate(() => (window as unknown as X).__XANDRIA__.campTest.liveSession().open());
    const box = await page.locator('#xandria-camp-panel').boundingBox();
    expect(box, 'camp panel visible at 360px').toBeTruthy();
    expect(box!.x + box!.width, 'panel fits the 360px viewport').toBeLessThanOrEqual(360);
    const btn = await page.locator('#xandria-camp-deposit-mat_ore').boundingBox();
    expect(btn, 'Store button has a box').toBeTruthy();
    await page.touchscreen.tap(btn!.x + btn!.width / 2, btn!.y + btn!.height / 2);
    await waitFor(page, 'touch Store deposits', () => page.evaluate(() => {
      const c = (window as unknown as X).__XANDRIA__.campTest.liveManager().chestContents;
      return c.mat_ore === 1;
    }), 30_000);
    await page.evaluate(() => {
      const panel = document.querySelector('#xandria-camp-panel') as HTMLElement;
      const btns = [...panel.querySelectorAll('button')];
      const leave = btns.find((b) => b.textContent?.includes('Leave'));
      leave?.click();
    });
    await waitFor(page, 'panel closes', () => page.evaluate(() =>
      !(window as unknown as X).__XANDRIA__.campTest.liveSession().isPanelOpen), 30_000);

    expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
  });
});

test('camp perf: instanced draw-call delta, desktop + s25', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const sample = async (): Promise<{ calls: number; buckets: number; registered: number }> =>
    page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const inst = (X.blueprint.enemies as unknown as { instancer?: { bucketCount: number; registeredNpcCount: number } }).instancer;
      return { calls: X.engine.renderer.info.render.calls, buckets: inst?.bucketCount ?? -1, registered: inst?.registeredNpcCount ?? -1 };
    });
  const sampleDraws = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push((await sample()).calls);
      await page.waitForTimeout(1500);
    }
    return out;
  };

  // Instancing honesty note: camp props reuse the scene's existing palette
  // buckets (same voxel roles as stations/gathering), so they add ZERO new
  // buckets and ~zero draws — that is the instancing dividend, not a
  // missing render. The leak signals are the registered-entity counts:
  // base includes the site tent (registered at arrival), with adds exactly
  // the 3 structures, after removes tent + structures.
  const results: Record<string, { base: number; with: number; after: number; delta: number; baseBuckets: number; withBuckets: number; afterBuckets: number; baseReg: number; withReg: number; afterReg: number }> = {};
  // Profile isolation: the slot profile lives in localStorage, which one
  // Playwright page context shares across navigations — without this the
  // s25 tier boots with the desktop tier's 3 restored structures and its
  // base/with/after numbers measure restoration, not the camp's own cost.
  await page.addInitScript(() => { try { localStorage.clear(); } catch { /* no storage */ } });
  for (const tier of ['desktop', 's25']) {
    await page.goto(`${URL}&tier=${tier}`);
    await bootWait(page);
    const resolved = await page.evaluate(() =>
      (window as unknown as X).__XANDRIA__.engine.tiers.tier);
    expect(resolved).toBe(tier);
    await quietField(page, false);
    // Teleport FIRST, then sample base from the camp-site view: base and
    // after must share a camera view, or terrain-chunk/props-in-view noise
    // (29 calls seen) swamps the camp's own delta. The site tent is in both
    // base and with (it despawns with the rest, costing ~0-2 draws).
    await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const mgr = X.campTest.liveManager();
      const V = X.engine.camera.position.constructor;
      const y = X.engine.terrain.heightAt(mgr.site.x, mgr.site.z) + 3;
      X.engine.portalsPlayerAvatar.ctrl.teleport(new V(mgr.site.x, y, mgr.site.z));
    });
    await page.waitForTimeout(20_000); // settle under SwiftShader
    const baseS = await sample();
    const baseBuckets = baseS.buckets;
    const baseReg = baseS.registered;
    const base = median(await sampleDraws(10));
    // build all three structures from the same view
    await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const mgr = X.campTest.liveManager();
      const inv = X.blueprint.itemKit.inventory;
      inv.add('mat_ore', 99); inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
      for (const id of ['chest', 'workbench', 'rest']) mgr.buildStructure(id);
    });
    const n = await page.evaluate(() =>
      (window as unknown as X).__XANDRIA__.campTest.liveManager().built.length);
    expect(n).toBe(3);
    // settle before sampling so instancer registration/submission lands
    await page.waitForTimeout(20_000);
    const withS = await sample();
    const withD = median(await sampleDraws(10));
    await page.evaluate(() =>
      (window as unknown as X).__XANDRIA__.campTest.liveManager().despawnAll());
    await page.waitForTimeout(20_000);
    const afterS = await sample();
    const after = median(await sampleDraws(10));
    results[tier] = {
      base, with: withD, after,
      delta: withD - base,
      baseBuckets, withBuckets: withS.buckets, afterBuckets: afterS.buckets,
      baseReg, withReg: withS.registered, afterReg: afterS.registered,
    };
    // log per tier immediately so the numbers survive a later-tier failure
    console.log(`camp perf ${tier}:`, JSON.stringify(results[tier]));
    expect(Math.abs(after - base), `${tier}: no unexplained drift (base=${base} after=${after})`)
      .toBeLessThanOrEqual(20);
    expect(afterS.buckets, `${tier}: no bucket leak (base=${baseBuckets} after=${afterS.buckets})`)
      .toBeLessThanOrEqual(baseBuckets);
    expect(withS.registered - baseReg, `${tier}: 3 structures register (base=${baseReg} with=${withS.registered})`)
      .toBe(3);
    expect(afterS.registered, `${tier}: tent + structures fully unregister (base=${baseReg} after=${afterS.registered})`)
      .toBe(baseReg - 1);
    expect(withD - base, `${tier}: no draw-call blowup (delta=${withD - base})`).toBeLessThan(45);
  }
  console.log('camp perf (median render.calls, 10 samples):', JSON.stringify(results));
  expect(errors).toEqual([]);
});
