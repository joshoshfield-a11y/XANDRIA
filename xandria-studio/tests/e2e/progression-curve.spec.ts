/**
 * UPGRADE LOOP (progression-curve phase): the player leveling curve, live.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012):
 *  1. The 50-row PROGRESSION_TABLE is intact in the page: identity row at
 *     level 1, symmetric derivation from ENEMY_LEVEL_BANDS at every level.
 *  2. Kill -> XP -> level-up -> stat growth, asserted EXACTLY against the
 *     table: 150 kills (20 XP each) take the player 1 -> 6; maxHealth,
 *     damageMult and spec.player.speed match levelRow(6) ratios.
 *  3. Craft XP flows through the same additive path (grantCraftXp, +15).
 *  4. Fresh player (level 1) vs the leveled player (level 6) on the SAME
 *     map seed: enemy bands differ exactly as the table + band ladder
 *     predict (band 0 vs band 1), positions/kinds identical.
 *
 * Desktop AND 360x780, zero console/page errors. The level-up modal itself
 * is covered by hud-polish.spec.ts; here the notify applies the same stat
 * growth the modal flow applies, without opening the modal.
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
    return !!(X?.engine && X.engine.state === 'playing' && X?.progressionTest?.liveProgression()
      && X?.enemyTest?.EnemyManager);
  }), 240_000);
  // God-mode: the harness must not be mauled mid-assertion (enemies are live).
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  return errors;
}

async function runProgressionAssertions(page: any) {
  return page.evaluate((testSpecs: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const PT = X.progressionTest;
    const prog = PT.liveProgression();
    const avatar = PT.liveAvatar();
    const out: any = {};

    // (1) table integrity in-page
    out.tableLen = PT.PROGRESSION_TABLE.length;
    out.cap = PT.LEVEL_CAP;
    const r1 = PT.levelRow(1);
    out.row1 = { xp: r1.xpToNext, dmg: r1.dmgMult, hp: r1.hpMult, spd: r1.speedMult };
    const r6 = PT.levelRow(6);
    out.row6 = { xp: r6.xpToNext, dmg: r6.dmgMult, hp: r6.hpMult, spd: r6.speedMult };
    const r50 = PT.levelRow(50);
    out.row50 = { dmg: r50.dmgMult, hp: r50.hpMult };
    out.enabled = prog.enabled;
    out.levelBefore = prog.level;
    out.xpBefore = prog.xp;
    out.maxHealthBefore = avatar.maxHealth;
    out.dmgBefore = prog.damageMult();
    out.speedBefore = X.spec.player.speed;

    // (2) kill -> XP -> level-up -> stat growth, exactly.
    // notify mirrors makeLevelUpFlow minus the modal: applies growth per gain.
    const notify = (gain: any) => { if (gain) prog.applyLevelStatGrowth(avatar, X.spec); };
    for (let i = 0; i < 150; i++) PT.grantKillXp(prog, notify, 1); // 150 * 20 = 3000 XP
    out.levelAfter = prog.level;
    out.xpAfter = prog.xp;
    out.maxHealthAfter = avatar.maxHealth;
    out.healthAfter = avatar.health;
    out.dmgAfter = prog.damageMult();
    out.speedAfter = X.spec.player.speed;

    // (3) craft XP on the same additive path
    const xpPreCraft = prog.xp;
    PT.grantCraftXp(prog, () => {});
    out.craftXpDelta = prog.xp - xpPreCraft;
    out.craftXpPer = prog.xpPerCraft();

    // (4) fresh (level 1) vs leveled (level 6) on the same map seed
    const S = X.enemyTest.enemyScaling;
    const mk = (level: number) => new X.enemyTest.EnemyManager(
      E, null, { onPlayerHit() {}, onDeath() {} },
      { specs: testSpecs, playerLevel: () => level },
    );
    const mapSeed = X.spec.meta.seed;
    const fresh = mk(1);
    const leveled = mk(prog.level);
    fresh.spawnForMap(mapSeed);
    leveled.spawnForMap(mapSeed);
    const snap = (m: any) => m.enemies.map((e: any) => ({
      x: e.position.x, z: e.position.z, kind: e.spec.kind,
      hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult, band: e.scalingBand,
    }));
    out.fresh = snap(fresh);
    out.leveled = snap(leveled);
    out.band1 = S.ENEMY_LEVEL_BANDS[1];
    fresh.despawnAll();
    leveled.despawnAll();
    return out;
  }, TEST_SPECS);
}

function checkAssertions(out: any) {
  // (1) table
  expect(out.enabled, 'progression enabled in fixture').toBe(true);
  expect(out.tableLen).toBe(50);
  expect(out.cap).toBe(50);
  expect(out.row1).toEqual({ xp: 100, dmg: 1, hp: 1, spd: 1 });
  expect(out.row6.xp).toBe(Math.round(100 * Math.pow(6, 1.5)));
  expect(out.row6.dmg).toBe(1.25); // band 6-10 hpMult
  expect(out.row6.hp).toBe(1.15); // band 6-10 dmgMult
  expect(out.row6.spd).toBeCloseTo(1.02, 9); // 1 + 0.004*5
  expect(out.row50.dmg).toBe(6.8);
  expect(out.row50.hp).toBe(3.4);

  // (2) 3000 XP: thresholds 100+283+520+800+1118 = 2821 -> level 6, 179 left
  expect(out.levelBefore).toBe(1);
  expect(out.levelAfter).toBe(6);
  expect(out.xpAfter).toBe(3000 - (100 + 283 + 520 + 800 + 1118));
  // stat growth exactly per the table
  expect(out.maxHealthAfter).toBe(Math.round(out.maxHealthBefore * 1.15));
  // the gain was healed, not a full heal: health rose by exactly the gain
  expect(out.healthAfter).toBe(out.maxHealthBefore + (out.maxHealthAfter - out.maxHealthBefore));
  expect(out.dmgAfter).toBeCloseTo(out.dmgBefore * 1.25, 9);
  expect(out.speedAfter).toBeCloseTo(out.speedBefore * 1.02, 9);

  // (3) craft XP additive on the same path
  expect(out.craftXpPer).toBe(15);
  expect(out.craftXpDelta).toBe(15);

  // (4) fresh vs leveled: same roster, different bands
  expect(out.fresh.length).toBe(3);
  expect(out.leveled.length).toBe(3);
  for (let i = 0; i < 3; i++) {
    const f = out.fresh[i];
    const l = out.leveled[i];
    expect(f.band).toBe(0);
    expect(f.hp).toBe(30);
    expect(l.band).toBe(1);
    expect(l.x).toBeCloseTo(f.x, 9);
    expect(l.z).toBeCloseTo(f.z, 9);
    expect(l.kind).toBe(f.kind);
    expect(l.xp).toBe(out.band1.xpMult);
    const hpC = 30 * out.band1.hpMult;
    expect(l.hp).toBeGreaterThanOrEqual(hpC * (1 - out.band1.variance));
    expect(l.hp).toBeLessThanOrEqual(hpC * (1 + out.band1.variance));
    expect(l.hp).toBeGreaterThan(f.hp);
  }
}

test('progression-curve: kill→XP→level-up→stat growth, craft XP, fresh vs leveled bands (desktop)', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await boot(page);
  const out = await runProgressionAssertions(page);
  checkAssertions(out);
  expect(errors, 'zero console/page errors').toEqual([]);
});

test('progression-curve: kill→XP→level-up→stat growth, craft XP, fresh vs leveled bands (360x780)', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await boot(page);
  const out = await runProgressionAssertions(page);
  checkAssertions(out);
  expect(errors, 'zero console/page errors').toEqual([]);
});
