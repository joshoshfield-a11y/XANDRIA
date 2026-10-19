/**
 * Crafting wave, workstream C — portal lifecycle for the crafting layer in
 * the live player page: departure despawns nodes + stations (scene meshes
 * return to baseline; the shared instancer keeps every other layer's
 * buckets), and a real portal round-trip respawns the identical roster for
 * the same mapSeed. Desktop + 360x780, zero console/page errors.
 *
 * Phase 1 drives the exact functions PortalTransition.begin/finish invoke
 * (portalEntities.despawnAll / spawnForMap). Phase 2 walks two real portal
 * legs (there and back, the enemies-portal.spec.ts pattern) and proves the
 * arrival path regenerates the identical roster for the origin mapSeed.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Portal legs need portals enabled: the proven 8km portal fixture
// (same one enemies-portal.spec.ts walks), with an empty item table
// injected so the blueprint builds the item kit uniformly.
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(
    readFileSync(resolve(HERE, 'fixtures/portal-8km.b64'), 'utf8').trim(), 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

const HALF = 4000;
const WORLD_SEED = 20261014;

/** must match deriveMapSeed in MapGraph.ts (copied from enemies-portal.spec.ts) */
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

test('crafting portal: departure to baseline, round-trip respawns identical node + station rosters', async ({ page }) => {
  test.setTimeout(1_800_000);
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
    return !!(X?.engine?.portalManager && X.engine.portalsPlayerAvatar && X.engine.state === 'playing'
      && X?.gatheringTest?.liveManager() && X?.craftingTest?.liveStations());
  }), 240_000);

  const counts = (): Promise<{ meshes: number; registry: number }> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    let meshes = 0;
    E.scene.traverse((o: any) => { if (o.isMesh && o.visible && !o.isInstancedMesh) meshes++; });
    let inst = 0;
    E.scene.traverse((o: any) => { if (o.isInstancedMesh) inst++; });
    return { meshes: meshes + inst, registry: E.npcInteractions.size };
  });
  /** deterministic roster signatures: kinds/names + positions, sorted */
  const signature = (): Promise<{ nodes: string; stations: string }> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const nodes = (X.gatheringTest.liveManager().nodes as any[])
      .map((n: any) => `${n.kind}@${n.root.position.x.toFixed(3)},${n.root.position.z.toFixed(3)}`)
      .sort().join(';');
    const stations = (X.craftingTest.liveStations().stations as any[])
      .map((s: any) => `${s.stationId}:${s.name}@${s.root.position.x.toFixed(3)},${s.root.position.z.toFixed(3)}`)
      .sort().join(';');
    return { nodes, stations };
  });
  const nodeCount = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.gatheringTest.liveManager().nodes.length);
  const stationCount = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.craftingTest.liveStations().stations.length);

  // Keep the bot alive for the walking legs.
  await page.evaluate(() => {
    const av = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9;
  });

  // ---- phase 1: the real departure/arrival functions ----
  // Clean slate: the exact departure call PortalTransition.begin invokes.
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalEntities.despawnAll();
  });
  const base = await counts();
  expect(await nodeCount()).toBe(0);
  expect(await stationCount()).toBe(0);

  // Arrival path for the origin map seed (exactly what PortalTransition.finish runs).
  await page.evaluate((seed) => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalEntities.spawnForMap(seed);
  }, SEED_00);
  const s1 = await signature();
  expect(s1.nodes.length, 'node roster respawned').toBeGreaterThan(0);
  expect(s1.stations.length, 'station roster respawned').toBeGreaterThan(0);
  expect(await stationCount()).toBe(4);
  const withLayer = await counts();
  expect(withLayer.meshes, 'layer adds scene meshes').toBeGreaterThan(base.meshes);

  // Departure again: everything returns to baseline (idempotent, portal-safe).
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalEntities.despawnAll();
  });
  const afterDepart = await counts();
  expect(afterDepart.meshes, 'scene meshes return to baseline').toBe(base.meshes);
  expect(afterDepart.registry, 'interaction registry returns to baseline').toBe(base.registry);

  // Same seed -> identical rosters (deterministic respawn).
  await page.evaluate((seed) => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalEntities.spawnForMap(seed);
  }, SEED_00);
  expect(await signature()).toEqual(s1);

  // ---- phase 2: real portal round-trip; the arrival path must regenerate s1 ----
  /** teleport just inside `edge`, face it, and hold forward until a transition fires */
  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate(([edge, half]) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const tx = 100;
      const tz = edge === 'N' ? half - 11 : -(half - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      const av = E.portalsPlayerAvatar;
      av.ctrl.teleport(new V(tx, y, tz));
      const want = edge === 'N' ? Math.PI : 0;
      let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      E.input.look.x = -d / 0.0026;
    }, [edge, HALF] as const);
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
    await waitFor('arrival roster', async () => (await nodeCount()) > 0 && (await stationCount()) === 4, 120_000);
  };

  const coord = (): Promise<{ mx: number; my: number }> => page.evaluate(() => {
    const pm = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalManager;
    return { mx: pm.coord.mx, my: pm.coord.my };
  });

  // leg 1 (desktop): (0,0) --N--> (0,1)
  await walkThrough('N', 0);
  expect(await coord()).toEqual({ mx: 0, my: 1 });

  // leg 2 (mobile viewport): (0,1) --S--> (0,0) — the origin mapSeed's
  // arrival roster must be identical to the manual spawnForMap(SEED_00)
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await walkThrough('S', 1);
  expect(await coord()).toEqual({ mx: 0, my: 0 });
  expect(await signature(), 'portal arrival respawns the identical node + station rosters for the same mapSeed')
    .toEqual(s1);

  expect(errors).toEqual([]);
});
