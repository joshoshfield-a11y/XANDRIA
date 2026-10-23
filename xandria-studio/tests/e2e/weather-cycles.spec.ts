/**
 * UPGRADE LOOP (weather-cycles phase): seeded day/night + weather cycles, live.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012):
 *  1. Seeded replication in-test: planWeatherCycle(seed) twice → identical;
 *     the live manager's plan deep-equals the pure plan for the map seed.
 *  2. Night band asserted: the plan contains a real night band; jumping the
 *     cycle clock into it flips the phase, drops the sun, and arms the
 *     additive brute/walker night damage multipliers.
 *  3. Storm hazards green (forced-storm spec): teleporting the player into a
 *     planned strike zone deals exactly the tuned damage; a far-away strike
 *     deals nothing. Telegraph → flash → damage through the real path.
 *  4. Perf (INSTANCING.md method): A-B-A draw deltas around despawnAll /
 *     spawnForMap are ~0; respawn restores the count.
 *
 * Desktop AND 360x780, zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function specWith(patch: (s: any) => void): string {
  const s = JSON.parse(Buffer.from(B64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  patch(s);
  return b64urlEncode(JSON.stringify(s));
}
// forced-storm spec: deterministic lightning for the hazard leg
const B64_STORM = specWith((s) => {
  s.custom = s.custom ?? {};
  s.custom.weatherCycles = { forced: 'storm' };
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function boot(page: any, specB64: string) {
  const errors: string[] = [];
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
    return !!(X?.engine && X.engine.state === 'playing' && X?.weatherTest?.liveWeather?.());
  }), 240_000);
  // God-mode-ish: enemies are live; strikes must still be measurable, so
  // health is large but finite (storm damage = 25 must register exactly).
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 100000;
  });
  return errors;
}

test('weather cycles: seeded replication, night band, storm hazards (desktop)', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await boot(page, B64);

  // (1) seeded replication in-test
  const replication = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const WT = X.weatherTest;
    const seed = X.spec.meta.seed;
    const p1 = WT.planWeatherCycle(seed);
    const p2 = WT.planWeatherCycle(seed);
    const live = WT.liveWeather().getPlan();
    return {
      seed,
      twiceEqual: JSON.stringify(p1) === JSON.stringify(p2),
      liveEqualsPure: JSON.stringify(live) === JSON.stringify(p1),
      segments: p1.segments.length,
      strikes: p1.strikes.length,
      nightSec: p1.segments.filter((s: any) => s.phase === 'night').reduce((a: number, s: any) => a + (s.endT - s.startT), 0),
      cycleSec: p1.cycleSec,
    };
  });
  expect(replication.twiceEqual).toBe(true);
  expect(replication.liveEqualsPure).toBe(true);
  // (2) night band asserted: real duration, phase flip, sun drop, damage hook armed
  expect(replication.nightSec).toBeGreaterThan(replication.cycleSec * 0.1);
  const night = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const WT = X.weatherTest;
    const w = WT.liveWeather();
    const plan = w.getPlan();
    const day = plan.segments.find((s: any) => s.phase === 'day')!;
    const nightSeg = plan.segments.find((s: any) => s.phase === 'night')!;
    w.debugSetCycleT(day.startT + 2);
    const daySun = X.engine.sky.sun.intensity;
    const dayDmg = w.enemyDamageMult('brute');
    w.debugSetCycleT(nightSeg.startT + 2);
    return {
      phase: w.current().phase,
      sun: X.engine.sky.sun.intensity,
      daySun,
      dayDmg,
      nightBrute: w.enemyDamageMult('brute'),
      nightWalker: w.enemyDamageMult('walker'),
      nightDrone: w.enemyDamageMult('drone'),
      tune: WT.WEATHER_TUNING.nightEnemyDamageMult,
    };
  });
  expect(night.phase).toBe('night');
  expect(night.sun).toBeLessThan(night.daySun);
  expect(night.dayDmg).toBe(1);
  expect(night.nightBrute).toBe(night.tune.brute);
  expect(night.nightWalker).toBe(night.tune.walker);
  expect(night.nightDrone).toBe(1);

  // (3) storm hazards: forced-storm spec, real strike path
  const errors2 = await boot(page, B64_STORM);
  errors.push(...errors2);
  const hazard = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const WT = X.weatherTest;
    const w = WT.liveWeather();
    const plan = w.getPlan();
    // clear the arena WITHOUT killing: mass enemy death completes an
    // objective stage, which opens a choice modal and pauses the sim
    // (updateHooks only run while state === 'playing'). Teleported enemies
    // stay alive 2 km away and can't race the strike for the player's iframes.
    for (const e of X.blueprint.enemies.enemies.slice()) {
      if (e.body) { e.body.position.set(2000, 50, 2000); e.body.velocity.set(0, 0, 0); }
    }
    // god-mode: a 25-damage strike must never kill a pre-damaged player
    // (death modal would pause the sim mid-assertion)
    const av0 = X.engine.portalsPlayerAvatar;
    av0.health = av0.maxHealth = 100000;
    return {
      strikes: plan.strikes.length,
      weather: w.current().weather,
      damage: WT.WEATHER_TUNING.storm.damage,
      first3: plan.strikes.slice(0, 3),
      second: plan.strikes[1] ?? null,
    };
  });
  expect(hazard.weather).toBe('storm');
  expect(hazard.strikes).toBeGreaterThan(0);
  // try up to 3 strikes: teleport into the zone, zero iframes, jump the
  // clock just before the strike; the first exact-25 hit wins
  let strikeDelta = -1;
  for (const s of hazard.first3) {
    await page.evaluate((st: any) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      const y = X.engine.terrain ? X.engine.terrain.heightAt(st.x, st.z) : 0;
      // NB: ctrl.position is a getter returning a throwaway toV3(body.position)
      // — teleport the physics body itself.
      av.ctrl.body.position.set(st.x, y + 1, st.z);
      av.ctrl.body.velocity.set(0, 0, 0);
      av.iframes = 0;
      (window as unknown as { __HP0?: number }).__HP0 = av.health;
      X.weatherTest.liveWeather().debugSetCycleT(st.at - 0.3);
    }, s);
    try {
      await page.waitForFunction(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.portalsPlayerAvatar.health < (window as unknown as { __HP0?: number }).__HP0!;
      }, null, { timeout: 20_000 });
      const d: number = await page.evaluate(() =>
        (window as unknown as { __HP0?: number }).__HP0! - (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.health);
      if (d === hazard.damage) { strikeDelta = d; break; }
      // a non-strike hit landed first (shouldn't happen with enemies dead)
      strikeDelta = d;
      break;
    } catch { /* strike missed the window — try the next one */ }
  }
  expect(strikeDelta).toBe(hazard.damage);
  const hpAfter: number = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.health);
  // second strike, player far away → no further damage
  if (hazard.second) {
    await page.evaluate((s: any) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      av.ctrl.body.position.set(1000, 50, 1000);
      av.ctrl.body.velocity.set(0, 0, 0);
      av.iframes = 0;
      X.weatherTest.liveWeather().debugSetCycleT(s.at - 0.3);
    }, hazard.second);
    await page.waitForTimeout(6000);
    const hpLater: number = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.health);
    expect(hpLater).toBe(hpAfter);
  }

  // (4) perf A-B-A on the natural spec (clear day segment: no particles, stable)
  const errors3 = await boot(page, B64);
  errors.push(...errors3);
  const perf = await page.evaluate(async () => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const w = X.weatherTest.liveWeather();
    const plan = w.getPlan();
    const clear = plan.segments.find((s: any) => s.weather === 'clear' && s.phase === 'day') ?? plan.segments[0];
    w.debugSetCycleT(clear.startT + 2);
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
    const withW = await sample();
    w.despawnAll();
    const without = await sample();
    w.spawnForMap(X.spec.meta.seed);
    const respawned = await sample();
    return { withW, without, respawned };
  });
  const d1 = Math.abs(perf.withW - perf.without);
  const d2 = Math.abs(perf.respawned - perf.withW);
  console.log('PERF weather A-B-A draw calls:', JSON.stringify({ ...perf, d1, d2 }));
  expect(d1).toBeLessThanOrEqual(4);
  expect(d2).toBeLessThanOrEqual(4);

  expect(errors).toEqual([]);
});

test('weather cycles: forced storm on 360x780', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await boot(page, B64_STORM);
  const out = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const WT = X.weatherTest;
    const w = WT.liveWeather();
    return {
      active: w.current().active,
      weather: w.current().weather,
      strikes: w.getPlan().strikes.length,
      saltOk: WT.WEATHER_SALT !== 0,
    };
  });
  expect(out.active).toBe(true);
  expect(out.weather).toBe('storm');
  expect(out.strikes).toBeGreaterThan(0);
  // HUD toast path works on the small viewport (storm toast on boot segment)
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});
