/**
 * UPGRADE LOOP (new-game-plus phase): New Game+ / prestige run cycles,
 * live player.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012):
 *  1. Blueprint initial-build roster (fresh profile = cycle 0) spawns with
 *     stats byte-identical to the authored spec (cycle 0 = identity).
 *  2. Same seeded map at NG+1 vs NG+2 via the EnemyManager seam: exact
 *     stat bands asserted per NG_PLUS_TABLE (level 1 = band 0, variance 0,
 *     normal difficulty = identity); positions/kinds identical.
 *  3. Same (seed, cycle) spawned twice -> identical stats.
 *  4. Full flow: complete a run (engine.win) -> end screen offers
 *     NEW GAME+ 1 -> click -> cycle 1, NG+ chip visible, live spawns use
 *     the NG+1 table, profile preserved except ngPlusCycle; repeat to
 *     NG+2 (stacking); world seed preserved and world tier back at 1
 *     (map progress reset to the origin).
 *  5. Cycle persists across a full page reload (profile persistence) and
 *     the chip re-syncs at boot.
 *  6. Perf (INSTANCING.md method): median renderer.info.render.calls over
 *     10 frames with a cycle-0 roster vs a cycle-2 roster of the same
 *     count/specs — NG+ is spawn-time only, draws must not move.
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

// MERGE note: never page.waitForFunction here — RAF polling stalls on this
// box (the tutorial spec header documents it) and the wait dies while the
// polled state is already true. Poll from Node like every other spec.
async function waitEval(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitEval timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(500);
  }
}

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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.enemyTest?.ngPlus);
  }), 240_000);
  return errors;
}

async function runNgPlusAssertions(page: any) {
  return page.evaluate(async (testSpecs: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const N = X.enemyTest.ngPlus;
    const av = E.portalsPlayerAvatar;
    const M = av.enemies;
    const mapSeed = X.spec.meta.seed;
    const out: any = {};

    // (1) blueprint roster: cycle 0 = identity, stats == authored spec
    out.cycleAtBoot = E.getNgPlusCycle();
    out.blueprintRoster = M.enemies.map((e: any) => ({
      hp: e.maxHealth, specHp: e.spec.health, dmg: e.spec.damage, xp: e.xpMult, kind: e.spec.kind,
    }));
    out.authoredByKind = {};
    for (const s of X.spec.enemies ?? []) {
      if (!(s.kind in out.authoredByKind)) { out.authoredByKind[s.kind] = { hp: s.health, dmg: s.damage }; }
    }
    out.seedAtBoot = mapSeed;
    out.tierAtBoot = E.worldTier;

    // (2) NG+1 vs NG+2 on the same map seed, portal-arrival path
    const mk = (cycle: number) => new X.enemyTest.EnemyManager(
      E, null, { onPlayerHit() {}, onDeath() {} },
      { specs: testSpecs, playerLevel: () => 1, difficulty: () => 'normal', ngPlus: () => cycle },
    );
    const ng1 = mk(1);
    const ng2 = mk(2);
    ng1.spawnForMap(mapSeed);
    ng2.spawnForMap(mapSeed);
    const snap = (m: any) => m.enemies.map((e: any) => ({
      x: e.position.x, z: e.position.z, kind: e.spec.kind,
      hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult,
    }));
    out.ng1 = snap(ng1);
    out.ng2 = snap(ng2);
    out.ng1Table = N.ngPlusByCycle(1);
    out.ng2Table = N.ngPlusByCycle(2);
    out.ngPlusTable = N.NG_PLUS_TABLE;

    // (3) same (seed, cycle) twice -> identical
    const ng2b = mk(2);
    ng2b.spawnForMap(mapSeed);
    out.ng2Again = snap(ng2b);
    ng1.despawnAll(); ng2.despawnAll(); ng2b.despawnAll();

    // (6) perf: median draw calls, cycle-0 roster vs cycle-2 roster
    const sampleCalls = async (n: number): Promise<number[]> => {
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        vals.push(E.renderer.info.render.calls);
        await new Promise((r) => setTimeout(r, 100));
      }
      return vals.sort((a, b) => a - b);
    };
    const median = (v: number[]) => v[Math.floor(v.length / 2)];
    const c0 = mk(0); c0.spawnForMap(mapSeed);
    out.callsCycle0 = median(await sampleCalls(10));
    c0.despawnAll();
    const c2 = mk(2); c2.spawnForMap(mapSeed);
    out.callsCycle2 = median(await sampleCalls(10));
    c2.despawnAll();

    return out;
  }, TEST_SPECS);
}

function checkAssertions(out: any) {
  // (1) cycle 0 at boot; blueprint roster byte-identical to authored spec
  expect(out.cycleAtBoot).toBe(0);
  expect(out.blueprintRoster.length).toBeGreaterThan(0);
  for (const e of out.blueprintRoster) {
    expect(e.hp).toBe(e.specHp);
    expect(e.xp).toBe(1);
    const authored = out.authoredByKind[e.kind];
    if (authored) {
      expect(e.specHp).toBe(authored.hp);
      expect(e.dmg).toBe(authored.dmg);
    }
  }
  // (2) NG+1 vs NG+2: exact per-table stats (band 0, variance 0)
  expect(out.ng1.length).toBe(3);
  expect(out.ng2.length).toBe(3);
  const t1 = out.ng1Table, t2 = out.ng2Table;
  for (let i = 0; i < 3; i++) {
    const a = out.ng1[i], b = out.ng2[i];
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.z).toBeCloseTo(b.z, 9);
    expect(a.kind).toBe(b.kind);
    expect(a.hp).toBeCloseTo(30 * t1.enemyHpMult, 9);
    expect(a.dmg).toBeCloseTo(10 * t1.enemyDmgMult, 9);
    expect(a.xp).toBeCloseTo(t1.enemyXpMult, 9);
    expect(b.hp).toBeCloseTo(30 * t2.enemyHpMult, 9);
    expect(b.dmg).toBeCloseTo(10 * t2.enemyDmgMult, 9);
    expect(b.xp).toBeCloseTo(t2.enemyXpMult, 9);
    // stacking: NG+2 strictly above NG+1 on every axis
    expect(b.hp).toBeGreaterThan(a.hp);
    expect(b.dmg).toBeGreaterThan(a.dmg);
    expect(b.xp).toBeGreaterThan(a.xp);
  }
  // (3) same (seed, cycle) twice -> identical
  expect(out.ng2Again).toEqual(out.ng2);
  // (6) perf: NG+ is spawn-time only — draws must not move
  expect(out.callsCycle0).toBe(out.callsCycle2);
}

const SEEDED_PROFILE = {
  version: 1, merit: 77, owned: ['vitality', 'power'], loadout: ['vitality'],
  runsPlayed: { 'fps-arena': 5 }, runsWon: { 'fps-arena': 3 },
  bestScore: {}, bestLevel: {}, totalKills: 42, totalPlaytime: 3600,
  dailyBest: {}, achievements: ['first-blood'], difficulty: 'normal',
  bestiaryKills: { walker: 10 }, dailyResults: {}, ngPlusCycle: 0,
};

async function enterNgPlusFlow(page: any, targetCycle: number, seedProfile: any = null) {
  // NOTE: recordRunResult is deliberately skipped in testMode (the engine
  // never pollutes player stats from automated runs), so the pre-click
  // profile cannot come from the win itself. Seed a full player profile
  // directly instead: the click must then preserve every field verbatim
  // except ngPlusCycle. The second leg needs no re-seed — the NG+1 save
  // already wrote a real profile, and the second win writes nothing.
  if (seedProfile) {
    await page.evaluate((p: any) => {
      // MERGE (save-slots): seed the ACTIVE slot — loadProfile() reads the
      // slot store once it exists, and the legacy key is migration-only input.
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      if (active) {
        active.profile = p;
        localStorage.setItem('xandria.slots.v1', JSON.stringify(st));
      }
    }, seedProfile);
  }
  const before = await page.evaluate(() => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      return active?.profile ?? null;
    } catch { return null; }
  });
  const btn = page.locator('button.ngplus-btn');
  await expect(btn).toHaveText(`NEW GAME+ ${targetCycle}`, { timeout: 30_000 });
  await btn.click();
  await waitEval(page, 'ngplus cycle', () => page.evaluate((cycle: number) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.getNgPlusCycle() === cycle);
  }, targetCycle), 120_000);
  const after = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    // MERGE (save-slots): read the active slot's profile, not the legacy key.
    let profile: any = null;
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      profile = active?.profile ?? null;
    } catch { profile = null; }
    const chip = document.querySelector('.score .ngplus');
    return {
      profile,
      cycle: X.engine.getNgPlusCycle(),
      tier: X.engine.worldTier,
      seed: X.spec.meta.seed,
      chipText: chip ? (chip as HTMLElement).textContent : null,
      chipVisible: chip ? (chip as HTMLElement).style.display !== 'none' : false,
    };
  });
  // Only the cycle moves: gear (loadout/owned), merit, achievements,
  // difficulty and every other profile field are preserved verbatim.
  expect(after.profile).not.toBeNull();
  expect(before).not.toBeNull();
  for (const k of Object.keys(before)) {
    if (k === 'ngPlusCycle' || k === 'version') continue;
    expect(after.profile[k]).toEqual(before[k]);
  }
  expect(after.profile.ngPlusCycle).toBe(targetCycle);
  expect(after.cycle).toBe(targetCycle);
  expect(after.chipText).toBe(`NG+ ${targetCycle}`);
  expect(after.chipVisible).toBe(true);
  expect(after.tier).toBe(1);
  return after;
}

async function ngPlusFlow(page: any) {
  const errors = await boot(page);
  const out = await runNgPlusAssertions(page);
  checkAssertions(out);

  // (4) complete a run -> enter NG+1 -> NG+2 stacks
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.win();
  });
  await expect(page.locator('button.ngplus-btn')).toHaveText('NEW GAME+ 1', { timeout: 30_000 });
  const after1 = await enterNgPlusFlow(page, 1, SEEDED_PROFILE);
  expect(after1.seed).toBe(out.seedAtBoot);
  // live spawns now use the NG+1 table via the engine cycle closure
  const live1 = await page.evaluate((testSpecs: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const m = new X.enemyTest.EnemyManager(
      E, null, { onPlayerHit() {}, onDeath() {} },
      { specs: testSpecs, playerLevel: () => 1, difficulty: () => 'normal', ngPlus: () => E.getNgPlusCycle() },
    );
    m.spawnForMap(X.spec.meta.seed);
    const snap = m.enemies.map((e: any) => ({ hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult }));
    m.despawnAll();
    return snap;
  }, TEST_SPECS);
  expect(live1.length).toBe(3);
  for (const e of live1) {
    expect(e.hp).toBeCloseTo(30 * out.ng1Table.enemyHpMult, 9);
    expect(e.dmg).toBeCloseTo(10 * out.ng1Table.enemyDmgMult, 9);
    expect(e.xp).toBeCloseTo(out.ng1Table.enemyXpMult, 9);
  }
  // second completion -> NG+2
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.win();
  });
  await expect(page.locator('button.ngplus-btn')).toHaveText('NEW GAME+ 2', { timeout: 30_000 });
  const after2 = await enterNgPlusFlow(page, 2);
  expect(after2.seed).toBe(out.seedAtBoot);

  // (5) cycle persists across a full page reload; chip re-syncs at boot
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  await waitEval(page, 'reboot after reload', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing');
  }), 240_000);
  const reloaded = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const chip = document.querySelector('.score .ngplus');
    return {
      cycle: X.engine.getNgPlusCycle(),
      chipText: chip ? (chip as HTMLElement).textContent : null,
      chipVisible: chip ? (chip as HTMLElement).style.display !== 'none' : false,
    };
  });
  expect(reloaded.cycle).toBe(2);
  expect(reloaded.chipText).toBe('NG+ 2');
  expect(reloaded.chipVisible).toBe(true);
  expect(errors).toEqual([]);
}

test('new game+: stat bands, NG+1/NG+2 flow, persistence', async ({ page }) => {
  test.setTimeout(900_000);
  await ngPlusFlow(page);
});

test('new game+: mobile 360x780 leg', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 360, height: 780 });
  await ngPlusFlow(page);
});
