/**
 * UPGRADE LOOP (difficulty-modes phase): data-driven difficulty modes,
 * live player.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012):
 *  1. Blueprint initial-build roster (fresh profile = normal mode) spawns
 *     with stats byte-identical to the authored spec (normal = identity).
 *  2. Same seeded map on Story vs Hard via the EnemyManager seam: exact
 *     stat bands asserted per DIFFICULTY_TABLE (level 1 = band 0, variance
 *     0, so exact equality, not ranges); positions/kinds identical.
 *  3. Same (seed, difficulty) spawned twice -> identical stats.
 *  4. engine.setDifficultyMode changes the live roster's spawn stats and
 *     persists across portal arrivals (spawnForMap) and a full page
 *     reload (profile persistence).
 *  5. Settings UI: pause -> SETTINGS shows a DIFFICULTY select with the
 *     three modes; changing it changes engine.getDifficultyMode().
 *  6. Perf (INSTANCING.md method): median renderer.info.render.calls over
 *     10 frames with a story roster vs a hard roster of the same
 *     count/specs — difficulty is spawn-time only, draws must not move.
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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.enemyTest?.difficulty);
  }), 240_000);
  return errors;
}

async function runDifficultyAssertions(page: any) {
  return page.evaluate(async (testSpecs: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const D = X.enemyTest.difficulty;
    const av = E.portalsPlayerAvatar;
    const M = av.enemies;
    const mapSeed = X.spec.meta.seed;
    const out: any = {};

    // (1) blueprint roster: normal mode = identity, stats == authored spec
    out.defaultMode = E.getDifficultyMode();
    out.blueprintRoster = M.enemies.map((e: any) => ({
      hp: e.maxHealth, specHp: e.spec.health, dmg: e.spec.damage, xp: e.xpMult, kind: e.spec.kind,
    }));
    out.authoredByKind = {};
    for (const s of X.spec.enemies ?? []) {
      if (!(s.kind in out.authoredByKind)) { out.authoredByKind[s.kind] = { hp: s.health, dmg: s.damage }; }
    }

    // (2) story vs hard on the same map seed, portal-arrival path
    const mk = (difficulty: string) => new X.enemyTest.EnemyManager(
      E, null, { onPlayerHit() {}, onDeath() {} },
      { specs: testSpecs, playerLevel: () => 1, difficulty: () => difficulty },
    );
    const story = mk('story');
    const hard = mk('hard');
    story.spawnForMap(mapSeed);
    hard.spawnForMap(mapSeed);
    const snap = (m: any) => m.enemies.map((e: any) => ({
      x: e.position.x, z: e.position.z, kind: e.spec.kind,
      hp: e.maxHealth, dmg: e.spec.damage, xp: e.xpMult,
    }));
    out.story = snap(story);
    out.hard = snap(hard);
    out.storyTable = D.difficultyById('story');
    out.hardTable = D.difficultyById('hard');

    // (3) same (seed, difficulty) twice -> identical
    const hard2 = mk('hard');
    hard2.spawnForMap(mapSeed);
    out.hardAgain = snap(hard2);

    // (4) combat lock: the live roster is aggro'd -> the change is refused;
    // then despawn the live roster (out of combat) -> the change is accepted
    // and portal arrivals (spawnForMap) use the new mode
    const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while (!E.inCombat() && Date.now() - t0 < 30000) await waitMs(500);
    out.inCombat = E.inCombat();
    out.setDuringCombat = E.setDifficultyMode('hard');
    M.despawnAll();
    out.inCombatAfterDespawn = E.inCombat();
    out.setAfterCalm = E.setDifficultyMode('hard');
    const live = new X.enemyTest.EnemyManager(
      E, null, { onPlayerHit() {}, onDeath() {} },
      { specs: testSpecs, playerLevel: () => 1, difficulty: () => E.getDifficultyMode() },
    );
    live.spawnForMap(mapSeed);
    out.liveHard = snap(live);
    out.modeAfterSet = E.getDifficultyMode();
    story.despawnAll(); hard.despawnAll(); hard2.despawnAll(); live.despawnAll();

    // (6) perf: median draw calls, story roster vs hard roster, same count
    const sampleCalls = async (n: number): Promise<number[]> => {
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        vals.push(E.renderer.info.render.calls);
        await new Promise((r) => setTimeout(r, 100));
      }
      return vals.sort((a, b) => a - b);
    };
    const median = (v: number[]) => v[Math.floor(v.length / 2)];
    const s2 = mk('story'); s2.spawnForMap(mapSeed);
    out.callsStory = median(await sampleCalls(10));
    s2.despawnAll();
    const h2 = mk('hard'); h2.spawnForMap(mapSeed);
    out.callsHard = median(await sampleCalls(10));
    h2.despawnAll();
    return out;
  }, TEST_SPECS);
}

function checkAssertions(out: any) {
  // (1) default mode is normal; blueprint roster byte-identical to authored spec
  expect(out.defaultMode).toBe('normal');
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
  // (2) story vs hard: exact per-table stats (band 0, variance 0)
  expect(out.story.length).toBe(3);
  expect(out.hard.length).toBe(3);
  const st = out.storyTable, ht = out.hardTable;
  for (let i = 0; i < 3; i++) {
    const s = out.story[i], h = out.hard[i];
    // positions/kinds identical across difficulties
    expect(s.x).toBeCloseTo(h.x, 9);
    expect(s.z).toBeCloseTo(h.z, 9);
    expect(s.kind).toBe(h.kind);
    // exact stat bands per the table
    expect(s.hp).toBeCloseTo(30 * st.enemyHpMult, 9);
    expect(s.dmg).toBeCloseTo(10 * st.enemyDmgMult * st.playerDamageTakenMult, 9);
    expect(s.xp).toBeCloseTo(st.enemyXpMult, 9);
    expect(h.hp).toBeCloseTo(30 * ht.enemyHpMult, 9);
    expect(h.dmg).toBeCloseTo(10 * ht.enemyDmgMult * ht.playerDamageTakenMult, 9);
    expect(h.xp).toBeCloseTo(ht.enemyXpMult, 9);
    // exact inter-mode ratios
    expect(h.hp / s.hp).toBeCloseTo(ht.enemyHpMult / st.enemyHpMult, 9);
    expect(h.dmg / s.dmg).toBeCloseTo(
      (ht.enemyDmgMult * ht.playerDamageTakenMult) / (st.enemyDmgMult * st.playerDamageTakenMult), 9);
  }
  // (3) same (seed, difficulty) twice -> identical
  expect(out.hardAgain).toEqual(out.hard);
  // (4) combat lock refused; calm accepted; live arrivals use the new mode
  expect(out.inCombat).toBe(true);
  expect(out.setDuringCombat).toEqual({ ok: false, reason: 'cannot change difficulty in combat' });
  expect(out.inCombatAfterDespawn).toBe(false);
  expect(out.setAfterCalm).toEqual({ ok: true });
  expect(out.modeAfterSet).toBe('hard');
  expect(out.liveHard.length).toBe(3);
  for (let i = 0; i < 3; i++) {
    expect(out.liveHard[i].hp).toBeCloseTo(out.hard[i].hp, 9);
    expect(out.liveHard[i].dmg).toBeCloseTo(out.hard[i].dmg, 9);
  }
  // (6) perf: difficulty is spawn-time only — draws must not move
  expect(out.callsStory).toBe(out.callsHard);
}

test('difficulty modes: stat bands, persistence, settings UI', async ({ page }) => {
  await difficultyFlow(page);
});

test('difficulty modes: mobile 360x780 leg', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await difficultyFlow(page);
});

async function difficultyFlow(page: any) {
  const errors = await boot(page);
  const out = await runDifficultyAssertions(page);
  checkAssertions(out);

  // (5a) difficulty survives a full page reload (profile persistence)
  await page.reload();
  const errors2: string[] = [];
  page.on('pageerror', (e: Error) => errors2.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors2.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  await page.waitForFunction(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing');
  }, null, { timeout: 240_000 });
  const modeAfterReload = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.getDifficultyMode());
  expect(modeAfterReload).toBe('hard');

  // (5b) settings UI: despawn the live roster (out of combat), then
  // pause -> SETTINGS -> DIFFICULTY select, change it
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.engine.portalsPlayerAvatar.enemies.despawnAll();
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'paused', null, { timeout: 5000 });
  await page.getByRole('button', { name: 'SETTINGS' }).click();
  const dsel = page.getByLabel('Difficulty');
  await expect(dsel).toBeVisible();
  await expect(dsel).toBeEnabled();
  const options = await dsel.locator('option').allTextContents();
  expect(options).toEqual(['STORY', 'NORMAL', 'HARD']);
  await expect(dsel).toHaveValue('hard'); // persisted value shown
  await dsel.selectOption('story');
  const modeAfterUi = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.getDifficultyMode());
  expect(modeAfterUi).toBe('story');

  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
}
