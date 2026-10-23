/**
 * Bestiary wave — codex unlock flow in the live player page.
 *
 * Test 1 (bestiary.b64: "Forgotten Valley", seed 20261012, 6 walkers,
 * custom.bestiary.tierThresholds {studied:2, mastered:3}):
 * real LMB-melee kill -> codex entry unlocks exactly once (SEEN) ->
 * toast fires -> B opens the panel (entry card: name, SEEN, weakness,
 * honest loot rows; other entries locked) -> panel adds zero draw calls
 * -> 2 more kills -> MASTERED -> portal despawn/respawn cycle keeps the
 * same manager + counts -> page reload restores counts from the Profile ->
 * 360x780: BESTIARY chip opens a panel that fits the viewport.
 *
 * Test 2 (portal-8km.b64): a REAL portal walk keeps the same blueprint-
 * owned manager and its counts; reload preserves them.
 *
 * Desktop AND 360x780, zero console/page errors.
 *
 * Kill helpers follow tests/e2e/enemies.spec.ts (hardened: teleport the
 * player to the enemy, single-evaluate position reads, Node-side waits).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/bestiary.b64'), 'utf8').trim();
const PORTAL_B64 = readFileSync(resolve(HERE, 'fixtures/portal-8km.b64'), 'utf8').trim();

type X = { __XANDRIA__?: any };

const waitFor = async (page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(2000);
  }
};

/** install the kill helpers used by both tests; returns the canvas click point */
async function armBot(page: any) {
  const info: { cx: number; cy: number } = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9; // the bot must survive
    (window as unknown as any).__BESTIARY__ = { B: X.blueprint, av, M: X.blueprint.enemies };
    // Record every toast at fire time: the unlock toast is transient and a
    // later toast (e.g. the loot pickup from the same kill) overwrites the
    // DOM text, so polling the DOM afterwards races. The log is the source
    // of truth for "the toast fired".
    const hud = E.hud;
    const origToast = hud.toast.bind(hud);
    (window as unknown as any).__TOAST_LOG__ = [] as string[];
    hud.toast = (text: string, seconds?: number) => {
      ((window as unknown as any).__TOAST_LOG__ as string[]).push(text);
      return origToast(text, seconds);
    };
    const r = E.renderer.domElement.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  const liveIndex = (skip = -1): Promise<number> => page.evaluate((skip: number) => {
    const { M } = (window as unknown as any).__BESTIARY__;
    return M.enemies.findIndex((e: any, i: number) => i !== skip && e.alive);
  }, skip);
  const placeNear = (i: number, dist: number): Promise<void> => page.evaluate(([i, dist]: [number, number]) => {
    const { M, av } = (window as unknown as any).__BESTIARY__;
    const e = M.enemies[i];
    const p = e.position;
    const V = av.ctrl.position.constructor;
    // p.y + 0.5, NOT + 2: melee() range-checks in 3D (to.length()), so a
    // 2m vertical gap puts the enemy at 2.83m > 2.6m range and every swing
    // misses. Verified: +0.5 -> 3D dist 2.06 -> hit.
    av.ctrl.teleport(new V(p.x + dist, p.y + 0.5, p.z));
    av.ctrl.velocity?.set?.(0, 0, 0);
  }, [i, dist] as any);
  const faceEnemy = (i: number): Promise<number> => page.evaluate((i: number) => {
    const { M, av } = (window as unknown as any).__BESTIARY__;
    const e = M.enemies[i];
    const ep = e.position, pp = av.ctrl.position;
    const dx = ep.x - pp.x, dz = ep.z - pp.z;
    av.ctrl.yaw = Math.atan2(dx, dz) - Math.PI;
    return Math.hypot(dx, dz);
  }, i);
  /**
   * Swing the real LMB path until enemy i dies. SwiftShader runs the frame
   * loop at ~0.5-1 fps in this scene, so a fixed sleep can land between two
   * frames and the click edge ('attack' in input.just) sits unconsumed for
   * seconds. After each click we therefore poll until the game loop has
   * consumed the edge (just no longer holds 'attack') or the enemy dies,
   * up to 30s — still the real LMB->mousedown->attack->melee path, never a
   * direct melee() call.
   */
  const edgeConsumed = (): Promise<boolean> => page.evaluate(() =>
    !(window as unknown as any).__XANDRIA__.engine.input.just.has('attack'));
  const enemyAlive = (i: number): Promise<boolean> => page.evaluate((i: number) => {
    const { M } = (window as unknown as any).__BESTIARY__;
    return !!M.enemies[i]?.alive;
  }, i);
  const meleeKill = async () => {
    for (let k = 0; k < 12; k++) {
      // Resolve a LIVE target per swing: the corpse sweep can shift roster
      // indices between kills, so a captured index may point at a corpse or
      // a different enemy by swing time.
      const i: number = await liveIndex();
      expect(i, 'a live enemy exists to kill').toBeGreaterThanOrEqual(0);
      // Re-place before EVERY swing: the player's own melee knocks the
      // enemy back (EnemyAI.damage knockback), so a fixed teleport from
      // before the first swing can leave the enemy outside the arc.
      await placeNear(i, 2);
      const dist = await faceEnemy(i);
      expect(dist, 'enemy in melee range after re-place').toBeLessThan(4);
      await page.mouse.click(info.cx, info.cy);
      // wait for the frame loop to consume this click's edge (or the kill)
      const t0 = Date.now();
      for (;;) {
        if (!(await enemyAlive(i))) return;
        if (await edgeConsumed()) break;
        if (Date.now() - t0 > 30_000) throw new Error(`click edge never consumed for enemy ${i} (frame loop stalled?)`);
        await page.waitForTimeout(1000);
      }
      // one extra beat for the melee damage to apply after consumption
      const t1 = Date.now();
      for (;;) {
        if (!(await enemyAlive(i))) return;
        if (Date.now() - t1 > 10_000) break;
        await page.waitForTimeout(1000);
      }
    }
    throw new Error(`no kill after 12 LMB melee swings`);
  };
  return { liveIndex, placeNear, meleeKill, ...info };
}

test('bestiary: kill -> unlock -> panel -> tier-up -> portal cycle -> reload, desktop + 360x780', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  const booted = (): Promise<boolean> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && (X as any).blueprint?.bestiary);
  });
  await waitFor(page, 'boot', booted, 240_000);

  const { liveIndex, placeNear, meleeKill } = await armBot(page);
  const tierCount = (): Promise<{ tier: number; count: number }> => page.evaluate(() => {
    const { B } = (window as unknown as any).__BESTIARY__;
    return { tier: B.bestiary.tierOf('walker'), count: B.bestiary.countOf('walker') };
  });

  // ---- kill 1: the entry unlocks exactly once ----
  const i0 = await liveIndex();
  expect(i0).toBeGreaterThanOrEqual(0);
  await placeNear(i0, 2);
  await meleeKill();
  let tc = await tierCount();
  expect(tc, 'first kill unlocks the walker entry').toEqual({ tier: 1, count: 1 });

  // unlock toast fired with the entry name (read from the fire-time log —
  // the DOM text is overwritten by the later loot-pickup toast)
  await waitFor(page, 'bestiary unlock toast', () => page.evaluate(() =>
    ((window as unknown as any).__TOAST_LOG__ as string[]).some((t) => t.includes('Ashen Walker'))), 30_000);

  // ---- the codex panel: unlocked card + locked cards ----
  await page.keyboard.press('b');
  await waitFor(page, 'bestiary panel opens', () => page.evaluate(() =>
    (document.getElementById('xandria-bestiary-panel') as HTMLElement)?.style.display === 'flex'), 30_000);
  const panelText: string = await page.evaluate(() =>
    document.getElementById('xandria-bestiary-panel')!.textContent ?? '');
  expect(panelText).toContain('Ashen Walker');
  expect(panelText).toContain('SEEN');
  expect(panelText).toContain('Melee reach is short (2.2m)');
  expect(panelText).toContain('Ember Shard');       // codex loot rows, item names from the def table
  expect(panelText).toContain('Ironfang Blade');
  expect(panelText).toContain('??? — unknown foe'); // the other five entries stay locked
  expect(panelText).toContain('1 / 6 identified');
  await page.screenshot({ path: '/tmp/bestiary-codex-desktop.png' });

  // ---- perf: the DOM panel adds zero draw calls ----
  const drawCalls = (): Promise<number> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.engine.renderer.info.render.calls;
  });
  const med = async (): Promise<number> => {
    const xs: number[] = [];
    for (let k = 0; k < 5; k++) { xs.push(await drawCalls()); await page.waitForTimeout(400); }
    xs.sort((a, b) => a - b);
    return xs[2];
  };
  const openCalls = await med();
  await page.keyboard.press('Escape');
  await waitFor(page, 'panel closes', () => page.evaluate(() =>
    (document.getElementById('xandria-bestiary-panel') as HTMLElement)?.style.display === 'none'), 30_000);
  const closedCalls = await med();
  expect(Math.abs(openCalls - closedCalls), `panel adds zero draws (open=${openCalls}, closed=${closedCalls})`).toBeLessThanOrEqual(3);

  // ---- kills 2+3: tier-up to MASTERED at the fixture thresholds ----
  const i1 = await liveIndex(i0);
  expect(i1).toBeGreaterThanOrEqual(0);
  await placeNear(i1, 2);
  await meleeKill();
  tc = await tierCount();
  expect(tc.tier, 'second kill -> STUDIED').toBe(2);
  const i2 = await liveIndex(i1);
  expect(i2).toBeGreaterThanOrEqual(0);
  await placeNear(i2, 2);
  await meleeKill();
  tc = await tierCount();
  // Tier is the design contract; the exact count can exceed 3 because one
  // melee ARC swing can fell two clustered enemies (correct game behavior).
  expect(tc.tier, 'third kill -> MASTERED').toBe(3);
  expect(tc.count, 'at least three kills registered').toBeGreaterThanOrEqual(3);
  const killsAfter3 = tc.count;

  // ---- portal despawn/respawn cycle: same manager, counts intact ----
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void; spawnForMap(s: number): void }>;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.spawnForMap(X.spec.meta.seed);
  });
  const cycled = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const B = (X as any).blueprint;
    return {
      same: B.bestiary === (window as unknown as any).__BESTIARY__.B.bestiary,
      count: B.bestiary.countOf('walker'),
      tier: B.bestiary.tierOf('walker'),
    };
  });
  expect(cycled.same, 'same manager object after the portal cycle').toBe(true);
  expect(cycled.count, 'counts survive the portal cycle').toBe(killsAfter3);
  expect(cycled.tier, 'tiers survive the portal cycle').toBe(3);

  // ---- page reload: counts restore from the Profile ----
  await page.reload();
  await waitFor(page, 'reboot after reload', booted, 240_000);
  const reloaded: { tier: number; count: number } = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const B = (X as any).blueprint;
    return { tier: B.bestiary.tierOf('walker'), count: B.bestiary.countOf('walker') };
  });
  expect(reloaded.tier, 'reload restores the walker tier from the profile').toBe(3);
  expect(reloaded.count, 'reload restores the walker count from the profile').toBe(killsAfter3);

  // ---- mobile leg: 360x780 — the BESTIARY chip opens a fitting panel ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await page.locator('#xandria-bestiary-chip').click();
  await waitFor(page, 'codex opens on mobile', () => page.evaluate(() =>
    (document.getElementById('xandria-bestiary-panel') as HTMLElement)?.style.display === 'flex'), 30_000);
  const box = await page.evaluate(() => {
    const el = document.getElementById('xandria-bestiary-panel') as HTMLElement | null;
    return el ? el.getBoundingClientRect().toJSON() : null;
  });
  expect(box, 'codex has a box on mobile').toBeTruthy();
  expect(box!.left).toBeGreaterThanOrEqual(0);
  expect(box!.right).toBeLessThanOrEqual(360);
  await page.screenshot({ path: '/tmp/bestiary-codex-mobile.png' });

  expect(errors, 'zero console/page errors').toEqual([]);
});

test('bestiary: a REAL portal walk keeps the same manager and its counts', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(PORTAL_B64)}&test=1&autostart=1&splash=0`);
  const booted = (): Promise<boolean> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine?.portalManager && (X as any).blueprint?.bestiary
      && X.engine.portalsPlayerAvatar && X.engine.state === 'playing');
  });
  await waitFor(page, 'boot', booted, 240_000);

  const { liveIndex, placeNear, meleeKill } = await armBot(page);
  const i0 = await liveIndex();
  expect(i0).toBeGreaterThanOrEqual(0);
  await placeNear(i0, 2);
  await meleeKill();
  const countBefore: number = await page.evaluate(() =>
    (window as unknown as any).__BESTIARY__.B.bestiary.countOf('walker'));
  expect(countBefore).toBe(1);

  // Real portal walk (portal-traverse.spec.ts pattern): teleport just inside
  // the N edge, face it, hold W until the trigger fires.
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
    const want = Math.PI; // walk +z (north)
    let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    E.input.look.x = -d / 0.0026;
  });
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
  });
  await waitFor(page, 'portal transition fires', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.engine.portalManager.transitions >= 1;
  }), 300_000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject([], null);
  });

  const afterWalk = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const B = (X as any).blueprint;
    return {
      same: B.bestiary === (window as unknown as any).__BESTIARY__.B.bestiary,
      count: B.bestiary.countOf('walker'),
      coord: { ...X.engine.portalManager.coord },
    };
  });
  expect(afterWalk.same, 'same bestiary manager after the real transition').toBe(true);
  expect(afterWalk.count, 'counts survive the real transition').toBe(1);
  expect(afterWalk.coord).toEqual({ mx: 0, my: 1 });

  // reload: the counts restore from the Profile (cross-run store)
  await page.reload();
  await waitFor(page, 'reboot after reload', booted, 240_000);
  const reloaded: number = await page.evaluate(() =>
    (window as unknown as X).__XANDRIA__ && ((window as unknown as X).__XANDRIA__ as any).blueprint.bestiary.countOf('walker'));
  expect(reloaded, 'reload restores the kill count from the profile').toBe(1);

  expect(errors, 'zero console/page errors').toEqual([]);
});
