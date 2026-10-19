/**
 * Enemies wave, workstream C — full combat loop in the live player page:
 * spawn (blueprint roster) -> player approaches -> aggro (chase) ->
 * enemy attacks (player health drops) -> player kills via the real
 * LMB -> melee path -> death FX + corpse tumble -> roster sweep.
 * Desktop AND 360x780, zero console/page errors.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to the enemy (never the reverse), position reads and
 * teleports happen inside a single evaluate, and all waits poll from
 * Node (page.waitForFunction's RAF polling is unreliable here).
 * The enemy's chase/attack movement is the deterministic part under
 * test, so it is NOT frozen — only the player's placement is scripted.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// "Forgotten Valley" tp-action spec, seed 20261012, 6 walkers — the same
// deterministic scene the INSTANCING.md perf method uses.
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

test('enemies: aggro -> attack -> LMB melee kill -> death FX + corpse sweep, desktop + mobile', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);

  // Blueprint's own EnemyManager (the one tpAction ticks and the avatar's
  // melee() iterates). Spy on deathFX to prove the death reads.
  const rosterSize: number = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    const M = av.enemies;
    av.health = av.maxHealth = 1e9; // the bot must survive the attack phase
    let deathFx = 0;
    const orig = E.juice.deathFX.bind(E.juice);
    E.juice.deathFX = (...a: any[]) => { deathFx++; return orig(...a); };
    (window as unknown as { __ENEMIES__?: any }).__ENEMIES__ = {
      M, av, deathFx: () => deathFx,
    };
    return M.enemies.length;
  });
  expect(rosterSize).toBeGreaterThanOrEqual(2);

  /** first live enemy index (optionally skipping one) */
  const liveIndex = (skip = -1): Promise<number> => page.evaluate((skip) => {
    const { M } = (window as unknown as { __ENEMIES__?: any }).__ENEMIES__;
    return M.enemies.findIndex((e: any, i: number) => i !== skip && e.alive);
  }, skip);

  /** teleport the player `dist`m east of enemy i; returns enemy health/alive */
  const placeNear = (i: number, dist: number): Promise<{ health: number; alive: boolean }> =>
    page.evaluate(([i, dist]) => {
      const { M, av } = (window as unknown as { __ENEMIES__?: any }).__ENEMIES__;
      const e = M.enemies[i];
      const p = e.position;
      const V = av.ctrl.position.constructor;
      av.ctrl.teleport(new V(p.x + dist, p.y + 2, p.z));
      av.ctrl.velocity?.set?.(0, 0, 0);
      return { health: e.health, alive: e.alive };
    }, [i, dist] as any);

  const enemyState = (i: number): Promise<string> => page.evaluate((i) => {
    const { M } = (window as unknown as { __ENEMIES__?: any }).__ENEMIES__;
    return M.enemies[i]?.state ?? 'gone';
  }, i);

  const playerHealth = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __ENEMIES__?: any }).__ENEMIES__.av.health);

  /** face the avatar at enemy i (melee arc aims off ctrl.yaw) */
  const faceEnemy = (i: number): Promise<number> => page.evaluate((i) => {
    const { M, av } = (window as unknown as { __ENEMIES__?: any }).__ENEMIES__;
    const e = M.enemies[i];
    const ep = e.position, pp = av.ctrl.position;
    const dx = ep.x - pp.x, dz = ep.z - pp.z;
    av.ctrl.yaw = Math.atan2(dx, dz) - Math.PI;
    return Math.hypot(dx, dz);
  }, i);

  const enemyStatus = (i: number): Promise<{ health: number; alive: boolean }> =>
    page.evaluate((i) => {
      const { M } = (window as unknown as { __ENEMIES__?: any }).__ENEMIES__;
      const e = M.enemies[i];
      return { health: e.health, alive: e.alive };
    }, i);

  /** swing the real LMB path until enemy i dies (or out of clicks) */
  const meleeKill = async (i: number, cx: number, cy: number) => {
    for (let k = 0; k < 10; k++) {
      const dist = await faceEnemy(i);
      expect(dist, 'enemy stays in melee range while it attacks').toBeLessThan(4);
      await page.mouse.click(cx, cy); // mousedown on canvas -> 'attack' -> avatar.melee()
      await page.waitForTimeout(2500);
      const s = await enemyStatus(i);
      if (!s.alive) return s;
    }
    throw new Error(`enemy ${i} survived 10 LMB melee swings`);
  };

  /** wait for the corpse tumble to finish and the roster sweep to drop it.
   * The victim OBJECT is captured once: after the sweep, roster indices
   * shift, so re-reading M.enemies[i] per poll would latch onto a live
   * enemy and never observe the sweep. */
  const awaitSweep = async (i: number): Promise<boolean> => {
    await page.evaluate((i) => {
      const { M } = (window as unknown as { __ENEMIES__?: any }).__ENEMIES__;
      (window as unknown as any).__VICTIM__ = M.enemies[i];
      (window as unknown as any).__SAW_TUMBLE__ = false;
    }, i);
    await waitFor(`corpse sweep of enemy ${i}`, () => page.evaluate(() => {
      const { M } = (window as unknown as { __ENEMIES__?: any }).__ENEMIES__;
      const v = (window as unknown as any).__VICTIM__;
      if (v && (v as any).corpseDone) (window as unknown as any).__SAW_TUMBLE__ = true;
      return !M.enemies.includes(v);
    }), 120_000);
    return page.evaluate(() => !!(window as unknown as any).__SAW_TUMBLE__);
  };

  const deathFxCount = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __ENEMIES__?: any }).__ENEMIES__.deathFx());

  // ---- desktop leg: full loop on enemy 0 ----
  const i0 = await liveIndex();
  expect(i0).toBeGreaterThanOrEqual(0);

  // aggro: 20m is inside the 30m aggro radius, outside the 2.2m attack radius
  await placeNear(i0, 20);
  await waitFor('aggro (chase)', async () => (await enemyState(i0)) === 'chase', 60_000);

  // attack: 2m — the enemy closes in and swings (attackCd 1.2s, hits < 2.6m)
  const hpBefore = await playerHealth();
  await placeNear(i0, 2);
  await waitFor('enemy hits player', async () => (await playerHealth()) < hpBefore, 120_000);

  // kill via the real LMB -> melee path (25 dmg/swing vs 30 HP walker)
  const fxBefore = await deathFxCount();
  const killed = await meleeKill(i0, 640, 360);
  expect(killed.alive).toBe(false);
  expect(killed.health).toBeLessThanOrEqual(0);
  expect(await deathFxCount(), 'death FX fired').toBeGreaterThan(fxBefore);

  // corpse tumble ran its course, then the roster sweep dropped it
  const sawTumble = await awaitSweep(i0);
  expect(sawTumble, 'corpse tumble ran before the sweep').toBe(true);
  const sizeAfterDesktop: number = await page.evaluate(() =>
    (window as unknown as { __ENEMIES__?: any }).__ENEMIES__.M.enemies.length);
  expect(sizeAfterDesktop).toBe(rosterSize - 1);

  // ---- mobile leg: 360x780, aggro -> attack -> kill -> sweep on a fresh enemy ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  const i1 = await liveIndex(i0);
  expect(i1).toBeGreaterThanOrEqual(0);
  await placeNear(i1, 20);
  await waitFor('mobile aggro (chase)', async () => (await enemyState(i1)) === 'chase', 60_000);
  const hpBeforeM = await playerHealth();
  await placeNear(i1, 2);
  await waitFor('mobile enemy hits player', async () => (await playerHealth()) < hpBeforeM, 120_000);
  const killedM = await meleeKill(i1, 180, 390);
  expect(killedM.alive).toBe(false);
  expect(await awaitSweep(i1), 'mobile corpse tumble ran before the sweep').toBe(true);

  await page.screenshot({ path: '/tmp/enemies-combat-mobile.png' });
  expect(errors).toEqual([]);
});
