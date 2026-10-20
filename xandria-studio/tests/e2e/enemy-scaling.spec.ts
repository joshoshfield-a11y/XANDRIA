/**
 * UPGRADE LOOP (enemy-scaling phase): world difficulty scaling, live player.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012):
 *  1. The blueprint's own initial-build roster (fresh player, origin map)
 *     spawns in band 0 with byte-identical stats to the authored spec
 *     (no regression from scaling).
 *  2. Fresh player (level 1) vs leveled player (level 12) on the SAME map
 *     seed, via two EnemyManagers on the portal-arrival path: different
 *     stat bands asserted (band 2 multipliers + seeded variance ranges),
 *     identical positions/kinds.
 *  3. Portal arrival preserves the band: spawnForMap twice on the leveled
 *     manager -> identical stats (deterministic re-arrival).
 *  4. Perf (INSTANCING.md method): median renderer.info.render.calls over
 *     10 frames with a band-0 roster vs a band-9 roster of the same
 *     count/specs — scaling is spawn-time only, draws must not move.
 *
 * Desktop AND 360x780, zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const TEST_SPECS = [
  { kind: 'walker', count: 3, health: 30, speed: 4, damage: 10, weapon: 'melee' },
];

async function boot(page: any) {
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.enemyTest?.enemyScaling);
  }), 240_000);
  return errors;
}

async function runScalingAssertions(page: any) {
  return page.evaluate((testSpecs: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const S = X.enemyTest.enemyScaling;
    const av = E.portalsPlayerAvatar;
    const M = av.enemies;
    const mapSeed = X.spec.meta.seed;
    const out: any = {};

    // (1) blueprint initial-build roster: band 0, byte-identical stats
    const authoredByKind: Record<string, number> = {};
    for (const s of X.spec.enemies ?? []) if (!(s.kind in authoredByKind)) authoredByKind[s.kind] = s.health;
    out.authoredByKind = authoredByKind;
    out.blueprintRoster = M.enemies.map((e: any) => ({
      band: e.scalingBand, hp: e.maxHealth, specHp: e.spec.health, kind: e.spec.kind,
      dmg: e.spec.damage, xp: e.xpMult,
    }));
    out.blueprintCount = M.enemies.length;

    // (2) fresh vs leveled on the same map seed, portal-arrival path
    const mk = (level: number) => new X.enemyTest.EnemyManager(
      E, null, { onPlayerHit() {}, onDeath() {} },
      { specs: testSpecs, playerLevel: () => level },
    );
    const fresh = mk(1);
    const leveled = mk(12);
    fresh.spawnForMap(mapSeed);
    leveled.spawnForMap(mapSeed);
    const snap = (m: any) => m.enemies.map((e: any) => ({
      x: e.position.x, z: e.position.z, kind: e.spec.kind,
      hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult, band: e.scalingBand,
    }));
    out.fresh = snap(fresh);
    out.leveled = snap(leveled);
    out.band2 = S.ENEMY_LEVEL_BANDS[2];

    // (3) portal arrival preserves the band: re-spawn, identical stats
    leveled.spawnForMap(mapSeed);
    out.leveledAgain = snap(leveled);

    // (4) perf: median draw calls, band-0 roster vs band-9 roster, same count
    const sampleCalls = async (n: number): Promise<number[]> => {
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        vals.push(E.renderer.info.render.calls);
        await new Promise((r) => setTimeout(r, 100));
      }
      return vals.sort((a, b) => a - b);
    };
    const median = (v: number[]) => v[Math.floor(v.length / 2)];
    return (async () => {
      fresh.despawnAll();
      const lo = mk(1); lo.spawnForMap(mapSeed);
      out.callsBand0 = median(await sampleCalls(10));
      lo.despawnAll();
      const hi = mk(50); hi.spawnForMap(mapSeed); // band 9 (clamped)
      out.callsBand9 = median(await sampleCalls(10));
      out.hiBand = hi.enemies[0]?.scalingBand;
      hi.despawnAll();
      leveled.despawnAll();
      return out;
    })();
  }, TEST_SPECS);
}

function checkAssertions(out: any) {
  // (1) blueprint roster: band 0, stats == authored spec
  expect(out.blueprintCount).toBeGreaterThan(0);
  for (const e of out.blueprintRoster) {
    expect(e.band).toBe(0);
    expect(e.hp).toBe(e.specHp);
    expect(e.xp).toBe(1);
    if (e.kind in out.authoredByKind) expect(e.specHp).toBe(out.authoredByKind[e.kind]);
  }
  // (2) fresh vs leveled: same count, same positions/kinds, different bands
  expect(out.fresh.length).toBe(3);
  expect(out.leveled.length).toBe(3);
  const b2 = out.band2;
  for (let i = 0; i < 3; i++) {
    const f = out.fresh[i];
    const l = out.leveled[i];
    expect(f.band).toBe(0);
    expect(f.hp).toBe(30); // identity band, byte-identical
    expect(f.x).toBeCloseTo(l.x, 9); // positions mapSeed-alone
    expect(f.z).toBeCloseTo(l.z, 9);
    expect(f.kind).toBe(l.kind);
    expect(l.band).toBe(2);
    expect(l.xp).toBe(b2.xpMult);
    const hpC = 30 * b2.hpMult;
    const dmgC = 10 * b2.dmgMult;
    expect(l.hp).toBeGreaterThanOrEqual(hpC * (1 - b2.variance));
    expect(l.hp).toBeLessThanOrEqual(hpC * (1 + b2.variance));
    expect(l.dmg).toBeGreaterThanOrEqual(dmgC * (1 - b2.variance));
    expect(l.dmg).toBeLessThanOrEqual(dmgC * (1 + b2.variance));
    expect(l.hp).toBeGreaterThan(f.hp);
    expect(l.dmg).toBeGreaterThan(f.dmg);
  }
  // (3) re-arrival: identical stats
  expect(out.leveledAgain).toEqual(out.leveled);
  // (4) perf: draw calls do not move with the band
  expect(out.hiBand).toBe(9);
  // eslint-disable-next-line no-console
  console.log(`[enemy-scaling perf] median renderer.info.render.calls: band0=${out.callsBand0} band9=${out.callsBand9}`);
  expect(Math.abs(out.callsBand9 - out.callsBand0)).toBeLessThanOrEqual(2);
}

test('enemy-scaling: fresh vs leveled bands, portal re-arrival, draw parity (desktop)', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await boot(page);
  const out = await runScalingAssertions(page);
  checkAssertions(out);
  expect(errors).toEqual([]);
});

test('enemy-scaling: fresh vs leveled bands, portal re-arrival, draw parity (360x780)', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await boot(page);
  const out = await runScalingAssertions(page);
  checkAssertions(out);
  expect(errors).toEqual([]);
});
