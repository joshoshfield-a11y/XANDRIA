/**
 * Enemies wave, workstream C — portal lifecycle in the live player page:
 * departure despawns everything (live enemies AND mid-tumble corpses;
 * physics body + scene mesh counts return to baseline), and a real
 * portal round-trip respawns the identical roster for the same mapSeed.
 *
 * Phase 1 drives the enemy manager's own departure/arrival functions
 * (the exact functions PortalTransition.begin/finish invoke) with a
 * mid-tumble corpse in the roster. Phase 2 walks two real portal legs
 * (there and back, portal-traverse.spec.ts pattern) and proves the
 * arrival path regenerates the identical roster for the origin mapSeed.
 * Desktop + 360x780, zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Portal legs need portals enabled: the proven 8km portal fixture
// (same one portal-traverse.spec.ts walks). Phase 1 (departure/arrival
// functions) is scene-independent.
const SPECS = existsSync('/tmp/portal-specs/portal-8km.b64')
  ? '/tmp/portal-specs'
  : '/home/hatch/workspace/xandria/qa/openworld/workers-portals';
const B64 = readFileSync(resolve(SPECS, 'portal-8km.b64'), 'utf8').trim();

const HALF = 4000;
const WORLD_SEED = 20261014;

/** must match deriveMapSeed in MapGraph.ts (copied from portal-traverse.spec.ts) */
function deriveMapSeed(worldSeed: number, mx: number, my: number): number {
  let h = (worldSeed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (mx | 0), 0x85ebca6b);
  h = Math.imul(h ^ (my | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEED_00 = deriveMapSeed(WORLD_SEED, 0, 0);

test('enemies portal: departure to baseline, round-trip respawns identical roster', async ({ page }) => {
  test.setTimeout(1_800_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);

  // Node-side polling (page.waitForFunction's RAF polling is unreliable here).
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
    return !!(X?.engine?.portalManager && X.engine.portalsPlayerAvatar && X.engine.state === 'playing');
  }), 240_000);

  const counts = (): Promise<{ bodies: number; meshes: number }> => page.evaluate(() => {
    const E = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine;
    let meshes = 0;
    E.scene.traverse((o: any) => { if (o.isMesh && o.visible && !o.isInstancedMesh) meshes++; });
    let inst = 0;
    E.scene.traverse((o: any) => { if (o.isInstancedMesh) inst++; });
    return { bodies: E.physics.world.bodies.length, meshes: meshes + inst };
  });
  const signature = (): Promise<string> => page.evaluate(() => {
    const M = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.enemies;
    return M.enemies
      .map((e: any) => `${e.spec.kind}@${e.home.x.toFixed(3)},${e.home.z.toFixed(3)}`)
      .sort().join(';');
  });
  const rosterSize = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.enemies.enemies.length);

  // Keep the bot alive for the walking legs (enemies will aggro en route).
  await page.evaluate(() => {
    const av = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9;
  });

  // ---- phase 1: the real departure/arrival functions, mid-tumble corpse in the roster ----
  // Start from a clean slate: the blueprint's initial-build roster goes first.
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.enemies.despawnAll();
  });
  const base = await counts();
  expect(await rosterSize()).toBe(0);

  // Arrival path for the origin map seed (exactly what PortalTransition.finish runs).
  await page.evaluate((seed) => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.enemies.spawnForMap(seed);
  }, SEED_00);
  const s1 = await signature();
  expect(s1.length).toBeGreaterThan(0);
  const withEnemies = await counts();
  expect(withEnemies.bodies).toBeGreaterThan(base.bodies);
  expect(withEnemies.meshes).toBeGreaterThan(base.meshes);

  // Kill one enemy and despawn in the SAME synchronous evaluate: no frame
  // elapses, so the corpse is guaranteed mid-tumble (body gone, rig still
  // animating) when the departure path runs. The blueprint's onDeath side
  // effects (score/pickup spawns) are stubbed for this synthetic kill so
  // the payload counts stay exact — Enemy.die() itself is untouched.
  const departed = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.engine.portalsPlayerAvatar.enemies;
    (M as any).events.onDeath = () => {};
    const d = M.enemies[0];
    d.damage(10000);
    const midTumble = !d.alive && !(d as any).corpseDone && M.enemies.includes(d);
    M.despawnAll(); // the exact departure function PortalTransition.begin invokes
    return { midTumble, roster: M.enemies.length };
  });
  expect(departed.midTumble, 'corpse was mid-tumble at departure').toBe(true);
  expect(departed.roster).toBe(0);
  const afterDepart = await counts();
  expect(afterDepart.bodies, 'physics bodies return to baseline').toBe(base.bodies);
  expect(afterDepart.meshes, 'scene meshes return to baseline').toBe(base.meshes);

  // Same seed -> identical roster (deterministic respawn).
  await page.evaluate((seed) => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar.enemies.spawnForMap(seed);
  }, SEED_00);
  expect(await signature()).toBe(s1);

  // ---- phase 2: real portal round-trip; the arrival path must regenerate s1 ----
  /** teleport just inside `edge`, face it, and hold forward until a transition fires */
  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate((edge) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const HALF = 4000; // 8km portal fixture
      const tx = 100;
      const tz = edge === 'N' ? HALF - 11 : -(HALF - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      const av = E.portalsPlayerAvatar;
      av.ctrl.teleport(new V(tx, y, tz));
      // Movement is camera-relative and the blueprint overwrites ctrl.camYaw
      // every frame from the camera rig, so steer by nudging the rig yaw.
      const want = edge === 'N' ? Math.PI : 0;
      let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      E.input.look.x = -d / 0.0026;
    }, edge);
    await page.waitForTimeout(8000);
    await page.evaluate(() => {
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
    });
    await waitFor(`transition to ${fromTransitions + 1}`, () => page.evaluate((n) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.portalManager.transitions >= n && !X.engine.portalManager.transitioning;
    }, fromTransitions + 1), 300_000);
    await page.evaluate(() => {
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.inject([], null);
    });
    // the arrival path spawns synchronously inside finish(); wait for the roster
    await waitFor('arrival roster', async () => (await rosterSize()) > 0, 120_000);
  };

  const coord = (): Promise<{ mx: number; my: number }> => page.evaluate(() => {
    const pm = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalManager;
    return { mx: pm.coord.mx, my: pm.coord.my };
  });

  // leg 1 (desktop): (0,0) --N--> (0,1)
  await walkThrough('N', 0);
  expect(await coord()).toEqual({ mx: 0, my: 1 });
  const sNorth = await signature();
  expect(sNorth.length).toBeGreaterThan(0);

  // leg 2 (mobile viewport): (0,1) --S--> (0,0) — the origin mapSeed's
  // arrival roster must be identical to the manual spawnForMap(SEED_00)
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await walkThrough('S', 1);
  expect(await coord()).toEqual({ mx: 0, my: 0 });
  expect(await signature(), 'portal arrival respawns the identical roster for the same mapSeed')
    .toBe(s1);

  await page.screenshot({ path: '/tmp/enemies-portal-arrival.png' });
  expect(errors).toEqual([]);
});
