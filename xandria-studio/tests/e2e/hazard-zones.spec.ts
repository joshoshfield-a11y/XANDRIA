/**
 * UPGRADE LOOP (hazard-zones phase): seeded environmental hazard zones, live.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012):
 *  1. Seeded replication in-test: planHazardZones(seed, anchors) twice →
 *     identical; the live manager's plan deep-equals the pure plan.
 *  2. Telegraph precedes the first tick: jumping the zone clock into the
 *     telegraph window shows telegraphing + warning tick with NO damage;
 *     crossing the tick deals exactly the tuned damage.
 *  3. Standing outside the radius takes no damage across ticks.
 *  4. Real frame-loop tick: standing in a zone drops health by exactly
 *     the tuned damage through the real update path.
 *  5. Minimap markers: a fogged zone has no marker; revealing its tile
 *     paints the def-colored diamond on the canvas (fog rules respected).
 *  6. Perf (INSTANCING.md method): A-B-A draw deltas around despawnAll /
 *     spawnForMap are small; respawn restores the count.
 *  7. Portal round-trip (8km fixture): leaving and re-entering the origin
 *     map restores the identical hazard set.
 *
 * Desktop AND 360x780, zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const PORTAL_RAW = readFileSync(
  '/home/hatch/workspace/xandria/qa/openworld/workers-portals/portal-8km.b64',
  'utf8',
).trim();

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function specWith(patch: (s: any) => void, raw: string): string {
  const s = JSON.parse(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  patch(s);
  return b64urlEncode(JSON.stringify(s));
}
const B64 = specWith((s) => {
  s.custom = s.custom ?? {};
  s.custom.items = { defs: {} };
}, NPCS_RAW);
const PORTAL_B64 = specWith((s) => {
  s.custom = s.custom ?? {};
  s.custom.items = { defs: {} };
}, PORTAL_RAW);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function boot(page: any, specB64: string, errors: string[]) {
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(specB64)}&test=1&autostart=1&splash=0`);
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X?.hazardTest?.liveHazards?.();
    return !!(X?.engine && X.engine.state === 'playing' && hz && hz.current().active);
  }), 240_000);
  // God-mode-ish: enemies are live; hazard ticks must register exactly, and
  // a tick must never kill the player mid-assertion (death modal pauses
  // the sim — updateHooks only run while state === 'playing').
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 100000;
  });
}

/** Clear the arena WITHOUT killing: mass enemy death completes an objective
 *  stage, which opens a choice modal and pauses the sim. Teleported enemies
 *  stay alive 2 km away (the weather-cycles pattern). */
async function clearEnemies(page: any) {
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    for (const e of X.blueprint.enemies.enemies.slice()) {
      if (e.body) { e.body.position.set(2000, 50, 2000); e.body.velocity.set(0, 0, 0); }
    }
  });
}

test('hazard zones: seeded replication, telegraph, exact ticks, minimap, perf (desktop)', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  await boot(page, B64, errors);
  await clearEnemies(page);

  // (1) seeded replication in-test: pure plan twice + live plan deep-equal
  const replication = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const HT = X.hazardTest;
    const seed = X.spec.meta.seed;
    const hz = HT.liveHazards();
    const anchors = hz.getPois();
    const p1 = HT.planHazardZones(seed, X.spec, anchors);
    const p2 = HT.planHazardZones(seed, X.spec, anchors);
    const live = hz.getPlan();
    return {
      seed,
      twiceEqual: JSON.stringify(p1) === JSON.stringify(p2),
      liveEqualsPure: JSON.stringify(live) === JSON.stringify(p1),
      zones: p1.length,
      defs: [...new Set(p1.map((p: any) => p.defId))],
      anchors: anchors.length,
    };
  });
  expect(replication.twiceEqual).toBe(true);
  expect(replication.liveEqualsPure).toBe(true);
  expect(replication.zones).toBeGreaterThan(0);
  expect(replication.defs.length).toBe(3);

  // (2) telegraph precedes the first tick; the tick deals exactly the tuned damage.
  // Single synchronous evaluate: no frame-loop interleaving between the
  // telegraph read and the tick — the ordering assertion is exact.
  const telegraph = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    const av = X.engine.portalsPlayerAvatar;
    const z = hz.zones[0];
    const def = X.hazardTest.HAZARD_DEFS.find((d: any) => d.id === z.def.id);
    const y = X.engine.terrain ? X.engine.terrain.heightAt(z.plan.x, z.plan.z) : 0;
    // Park far away first: advancing the clock to the NEXT telegraph
    // window may cross an intervening tick, which must not damage the
    // player (the zone has been ticking since boot — its clock is never
    // rewindable, so aim at the next cycle, not the current one).
    av.ctrl.body.position.set(1000, 50, 1000);
    av.ctrl.body.velocity.set(0, 0, 0);
    let target = z.nextTickAt - def.telegraphSec - 0.05;
    if (target <= hz.current().clock) target += def.tickIntervalSec;
    hz.debugTick(Math.max(0, target - hz.current().clock));
    // now step into the zone center, just before the window opens
    av.ctrl.body.position.set(z.plan.x, y + 1, z.plan.z);
    av.ctrl.body.velocity.set(0, 0, 0);
    av.iframes = 0;
    const hp0 = av.health;
    const beforeWindow = { telegraphing: hz.zones[0].telegraphing, hp: av.health, warnings: hz.zones[0].warningTicks };
    // step into the middle of the telegraph window: telegraphing + warning, still no damage
    hz.debugTick(def.telegraphSec / 2);
    const inWindow = { telegraphing: hz.zones[0].telegraphing, hp: av.health, warnings: hz.zones[0].warningTicks };
    // step past the tick: exactly one tick of tuned damage
    av.iframes = 0;
    hz.debugTick(def.telegraphSec);
    const afterTick = { hp: av.health, ticks: hz.zones[0].ticksFired };
    return {
      defId: z.def.id, damage: def.damage,
      beforeWindow, inWindow, afterTick,
      hp0,
      delta: hp0 - afterTick.hp,
    };
  });
  expect(telegraph.beforeWindow.telegraphing).toBe(false);
  expect(telegraph.beforeWindow.hp).toBe(telegraph.hp0);
  expect(telegraph.inWindow.telegraphing).toBe(true);
  expect(telegraph.inWindow.hp).toBe(telegraph.hp0);
  expect(telegraph.inWindow.warnings).toBeGreaterThanOrEqual(1);
  expect(telegraph.afterTick.ticks).toBeGreaterThanOrEqual(1);
  expect(telegraph.delta).toBe(telegraph.damage);

  // (3) standing outside the radius takes no damage across ticks
  const outside = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    const av = X.engine.portalsPlayerAvatar;
    const z = hz.zones[0];
    const y = X.engine.terrain ? X.engine.terrain.heightAt(z.plan.x, z.plan.z) : 0;
    av.ctrl.body.position.set(z.plan.x + z.def.radius + 5, y + 1, z.plan.z);
    av.ctrl.body.velocity.set(0, 0, 0);
    av.iframes = 0;
    const hp0 = av.health;
    const ticks0 = z.ticksFired;
    hz.debugTick(3);
    return { hp: av.health, hp0, ticks: z.ticksFired, ticks0 };
  });
  expect(outside.hp).toBe(outside.hp0);
  expect(outside.ticks).toBeGreaterThan(outside.ticks0);

  // (4) real frame-loop tick: standing in the zone drops health by exactly
  // the tuned damage through the real update path (no debugTick).
  const realTick = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    const av = X.engine.portalsPlayerAvatar;
    const z = hz.zones[0];
    const def = X.hazardTest.HAZARD_DEFS.find((d: any) => d.id === z.def.id);
    const y = X.engine.terrain ? X.engine.terrain.heightAt(z.plan.x, z.plan.z) : 0;
    av.ctrl.body.position.set(z.plan.x, y + 1, z.plan.z);
    av.ctrl.body.velocity.set(0, 0, 0);
    av.iframes = 0;
    (window as unknown as { __HP0?: number }).__HP0 = av.health;
    return { damage: def.damage, defId: z.def.id };
  });
  await page.waitForFunction(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.engine.portalsPlayerAvatar.health < (window as unknown as { __HP0?: number }).__HP0!;
  }, null, { timeout: 120_000 });
  const realDelta: number = await page.evaluate(() =>
    (window as unknown as { __HP0?: number }).__HP0! - (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.health);
  expect(realDelta).toBe(realTick.damage);

  // (5) minimap markers respect the fog rule: a fogged zone has no marker;
  // revealing its tile paints the def-colored diamond on the canvas.
  const minimap = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    const zones = hz.zones.map((z: any) => ({ defId: z.def.id, x: z.plan.x, z: z.plan.z, color: z.def.color, warning: z.def.warningColor }));
    // farthest zone from spawn — the fog-rule candidate
    let far = zones[0];
    for (const zn of zones) {
      if (Math.hypot(zn.x, zn.z) > Math.hypot(far.x, far.z)) far = zn;
    }
    return { zones, far, farDist: Math.hypot(far.x, far.z) };
  });
  const target = minimap.far;
  let fogRuleChecked = false;
  if (minimap.farDist > 160) {
    const before = await page.evaluate((t: any) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.minimap.hazardMarkers.some((m: any) => Math.abs(m.x - t.x) < 0.01 && Math.abs(m.z - t.z) < 0.01);
    }, target);
    expect(before, 'fogged zone has no minimap marker').toBe(false);
    fogRuleChecked = true;
  }
  // teleport onto the zone, wait for the marker to appear (scan throttle
  // runs on game time; SwiftShader crawls, so wait generously)
  await page.evaluate((t: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const y = E.terrain.heightAt(t.x, t.z) + 3;
    E.portalsPlayerAvatar.ctrl.teleport(new V(t.x, y, t.z));
  }, target);
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('hazard marker appears', () => page.evaluate((t: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.engine.minimap.hazardMarkers.some((m: any) => Math.abs(m.x - t.x) < 0.01 && Math.abs(m.z - t.z) < 0.01);
  }, target), 180_000);
  // step 40m east so the player marker can't cover the zone diamond
  await page.evaluate((t: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const y = E.terrain.heightAt(t.x + 40, t.z) + 3;
    E.portalsPlayerAvatar.ctrl.teleport(new V(t.x + 40, y, t.z));
  }, target);
  await page.waitForTimeout(4000);
  const markerPx = await page.evaluate((t: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const half = X.engine.terrain.size / 2, W = 208;
    const px = ((t.x + half) / (half * 2)) * W;
    const py = ((half - t.z) / (half * 2)) * W;
    const canvas = document.querySelector('#xandria-minimap canvas') as HTMLCanvasElement;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.getImageData(Math.max(0, Math.floor(px) - 6), Math.max(0, Math.floor(py) - 6), 13, 13);
    const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const targets = [hex(t.color), hex(t.warning)];
    let matched = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      for (const [tr, tg, tb] of targets) {
        if (Math.abs(r - tr) <= 30 && Math.abs(g - tg) <= 30 && Math.abs(b - tb) <= 30) { matched++; break; }
      }
    }
    return { matched, px, py };
  }, target);
  console.log('[hazard] minimap marker pixels: ' + JSON.stringify({ ...markerPx, fogRuleChecked }));
  expect(markerPx, 'minimap canvas exists').toBeTruthy();
  expect(markerPx!.matched, 'hazard diamond painted on the minimap').toBeGreaterThan(0);

  // (6) perf A-B-A on the natural spec
  const perf = await page.evaluate(async () => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    const sample = async () => {
      const xs: number[] = [];
      for (let i = 0; i < 10; i++) {
        xs.push(X.engine.renderer.info.render.calls);
        await new Promise((r) => setTimeout(r, 400));
      }
      xs.sort((a, b) => a - b);
      const m = Math.floor(xs.length / 2);
      return (xs[m - 1] + xs[m]) / 2;
    };
    const withH = await sample();
    hz.despawnAll();
    const without = await sample();
    hz.spawnForMap(X.spec.meta.seed);
    const respawned = await sample();
    return { withH, without, respawned };
  });
  const d1 = Math.abs(perf.withH - perf.without);
  const d2 = Math.abs(perf.respawned - perf.withH);
  console.log('PERF hazard A-B-A draw calls:', JSON.stringify({ ...perf, d1, d2 }));
  expect(d1).toBeLessThanOrEqual(12);
  expect(d2).toBeLessThanOrEqual(12);

  expect(errors).toEqual([]);
});

test('hazard zones: forced counts on 360x780', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors: string[] = [];
  await boot(page, B64, errors);
  const out = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    return {
      active: hz.current().active,
      zones: hz.zones.length,
      decals: hz.zones.filter((z: any) => z.decal !== null).length,
    };
  });
  expect(out.active).toBe(true);
  expect(out.zones).toBeGreaterThan(0);
  expect(out.decals).toBe(out.zones);
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});

// ---- portal round-trip (8km fixture): the hazard set survives re-entry ----
async function portalHarness(page: any) {
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  /** walk through `edge` (N/S): teleport 11m inside, face it, hold forward */
  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate((edge: 'N' | 'S') => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const HALF = 4000;
      const tx = 100;
      const tz = edge === 'N' ? HALF - 11 : -(HALF - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      E.portalsPlayerAvatar.ctrl.teleport(new V(tx, y, tz));
      const want = edge === 'N' ? Math.PI : 0; // +z north at PI
      let d = (want - E.portalsPlayerAvatar.ctrl.camYaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      E.input.look.x = -d / 0.0026;
    }, edge);
    await page.waitForTimeout(8000);
    await page.evaluate(() => {
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
    });
    await waitFor(`transition to ${fromTransitions + 1}`, () => page.evaluate((n: number) =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalManager.transitions >= n, fromTransitions + 1), 300_000);
    await page.evaluate(() => {
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.inject([], null);
    });
  };
  return { waitFor, walkThrough };
}

test('hazard zones: portal round-trip preserves the hazard set (8km fixture)', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(PORTAL_B64)}&test=1&autostart=1&splash=0`);
  const h = await portalHarness(page);
  await h.waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X?.hazardTest?.liveHazards?.();
    return !!(X?.engine && X.engine.state === 'playing' && hz && hz.current().active && X.engine.minimap);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 100000;
  });
  const origin = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    return {
      key: X.engine.minimap.activeKey,
      plan: JSON.stringify(hz.getPlan()),
      zones: hz.zones.length,
      seed: X.spec.meta.seed,
    };
  });
  expect(origin.key).toBe('0,0');
  expect(origin.zones).toBeGreaterThan(0);

  // Fog-rule check on the 8km map (zones spread far beyond the 150m
  // reveal radius): the farthest zone has no minimap marker while its
  // tile is fogged; teleporting onto it reveals the marker.
  const farTarget = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    let far = hz.zones[0];
    for (const z of hz.zones) {
      if (Math.hypot(z.plan.x, z.plan.z) > Math.hypot(far.plan.x, far.plan.z)) far = z;
    }
    return { x: far.plan.x, z: far.plan.z, dist: Math.hypot(far.plan.x, far.plan.z) };
  });
  expect(farTarget.dist, '8km map has a zone beyond the reveal radius').toBeGreaterThan(160);
  const foggedBefore = await page.evaluate((t: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.engine.minimap.hazardMarkers.some((m: any) => Math.abs(m.x - t.x) < 0.01 && Math.abs(m.z - t.z) < 0.01);
  }, farTarget);
  expect(foggedBefore, 'fogged zone has no minimap marker').toBe(false);
  await page.evaluate((t: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const y = E.terrain.heightAt(t.x, t.z) + 3;
    E.portalsPlayerAvatar.ctrl.teleport(new V(t.x, y, t.z));
  }, farTarget);
  await h.waitFor('hazard marker appears after reveal', () => page.evaluate((t: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.engine.minimap.hazardMarkers.some((m: any) => Math.abs(m.x - t.x) < 0.01 && Math.abs(m.z - t.z) < 0.01);
  }, farTarget), 180_000);

  await h.walkThrough('N', 0);
  await h.waitFor('minimap leaves origin', () => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.minimap.activeKey !== '0,0'), 180_000);
  const away = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    return { key: X.engine.minimap.activeKey, zones: hz.zones.length, plan: JSON.stringify(hz.getPlan()) };
  });
  expect(away.key).not.toBe('0,0');
  expect(away.zones).toBeGreaterThan(0);

  await h.walkThrough('S', 1);
  await h.waitFor('minimap returns to origin', () => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.minimap.activeKey === '0,0'), 180_000);
  const back = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const hz = X.hazardTest.liveHazards();
    return { key: X.engine.minimap.activeKey, plan: JSON.stringify(hz.getPlan()), zones: hz.zones.length };
  });
  expect(back.key).toBe('0,0');
  expect(back.plan, 're-entering the origin map restores the identical hazard set').toBe(origin.plan);
  expect(back.zones).toBe(origin.zones);
  expect(errors).toEqual([]);
});
