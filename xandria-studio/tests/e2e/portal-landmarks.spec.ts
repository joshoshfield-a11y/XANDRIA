/**
 * Portal-backlog wave: the arrival path regenerates the FULL map-local
 * landmark set (landmarks + structure sets), deterministically per map
 * seed — and the departed map's landmarks are fully retired (no leak).
 *
 * Before this wave: blueprints built landmarks once at boot; portal
 * arrivals rebuilt only terrain, so every map after the first had NO
 * landmarks, and the origin map's landmarks leaked into every later map.
 *
 * Procedure: boot the portal-8km spec, snapshot the origin landmark roster
 * digest; walk N to (0,1) and assert the arrival map has a full landmark
 * set; walk S back to (0,0) and assert the origin digest is bit-identical
 * (deterministic rebuild) with matching collider/draw counts; repeat one
 * leg at 360x780. Zero console/page errors throughout.
 *
 * Walk machinery copied from portal-traverse.spec.ts (same trigger
 * debounce constraints under SwiftShader).
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const SPECS = existsSync('/tmp/portal-specs/portal-8km.b64')
  ? '/tmp/portal-specs'
  : '/home/hatch/workspace/xandria/qa/openworld/workers-portals';

const HALF = 4000;
const INSET = 120; // must match PORTAL_ARRIVAL_INSET in PortalManager.ts
const WORLD_SEED = 20261014;

interface LandmarkSnap {
  registered: boolean;
  mapSeed: number | null;
  placed: number;
  digest: string;
  draws: number;
  colliders: number;
  bodies: number;
}

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

test('portal landmarks: full set regenerates per map, deterministic, no leak', async ({ page }) => {
  test.setTimeout(1_800_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const b64 = readFileSync(`${SPECS}/portal-8km.b64`, 'utf8').trim();
  await page.goto(`/player.html?spec=${encodeURIComponent(b64)}&test=1&autostart=1&splash=0`);

  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  const booted = (): Promise<boolean> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine?.portalManager && X.engine.portalsPlayerAvatar && X.engine.state === 'playing');
  });
  await waitFor('boot', booted, 240_000);

  const landmarkSnap = (): Promise<LandmarkSnap> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const sys = (E.portalEntities.systems as any[]).find((s) => s.id === 'landmarks');
    const placed = (sys?.placed ?? []) as Array<{ kind: string; pos: { x: number; z: number } }>;
    const digest = placed
      .map((p) => `${p.kind}@${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)}`)
      .sort()
      .join('|');
    return {
      registered: !!sys,
      mapSeed: sys?.mapSeed ?? null,
      placed: placed.length,
      digest,
      draws: sys ? sys.drawCalls() : 0,
      colliders: sys ? sys.colliderCount : 0,
      bodies: E.physics.world.bodies.length,
    };
  });

  const coord = (): Promise<{ mx: number; my: number; transitions: number; seed: number }> =>
    page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const pm = X.engine.portalManager;
      return {
        mx: pm.coord.mx, my: pm.coord.my,
        transitions: pm.transitions,
        seed: X.spec.meta.seed,
      };
    });

  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate((edge) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const HALF = 4000;
      const tx = 100;
      const tz = edge === 'N' ? HALF - 11 : -(HALF - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      const av = E.portalsPlayerAvatar;
      av.ctrl.teleport(new V(tx, y, tz));
      av.health = av.maxHealth = 1e9;
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
    const reached = (): Promise<boolean> => page.evaluate((n) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.portalManager.transitions >= n;
    }, fromTransitions + 1);
    await waitFor(`transition to ${fromTransitions + 1}`, reached, 300_000);
    await page.evaluate(() => {
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.inject([], null);
    });
    try {
      const drained = (): Promise<boolean> => page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.terrain.getStreamStats().queue === 0;
      });
      await waitFor('stream drain', drained, 120_000);
    } catch { /* queue still draining under SwiftShader — non-fatal */ }
  };

  // ---- origin map (0,0): the landmarks system is registered and built ----
  let lm = await landmarkSnap();
  expect(lm.registered).toBe(true);
  expect(lm.placed).toBeGreaterThan(0);
  expect(lm.draws).toBeGreaterThan(0);
  expect(lm.colliders).toBeGreaterThan(0);
  expect(lm.mapSeed).toBe(deriveMapSeed(WORLD_SEED, 0, 0));
  const originDigest = lm.digest;
  const originDraws = lm.draws;
  const originColliders = lm.colliders;

  // ---- leg 1 (desktop): (0,0) --N--> (0,1) — the arrival map gets the FULL set ----
  await walkThrough('N', 0);
  let c = await coord();
  expect(c.mx).toBe(0); expect(c.my).toBe(1);
  expect(c.seed).toBe(deriveMapSeed(WORLD_SEED, 0, 1));
  lm = await landmarkSnap();
  expect(lm.registered).toBe(true);
  expect(lm.mapSeed).toBe(deriveMapSeed(WORLD_SEED, 0, 1));
  expect(lm.placed).toBeGreaterThan(0); // ← the bug: used to be 0 (no regeneration)
  expect(lm.draws).toBeGreaterThan(0);
  expect(lm.colliders).toBeGreaterThan(0);
  const arrivalDigest = lm.digest;

  // ---- leg 2 (desktop): (0,1) --S--> (0,0) — origin roster is bit-identical (LRU hit, deterministic rebuild) ----
  await walkThrough('S', 1);
  c = await coord();
  expect(c.mx).toBe(0); expect(c.my).toBe(0);
  expect(c.seed).toBe(deriveMapSeed(WORLD_SEED, 0, 0));
  lm = await landmarkSnap();
  expect(lm.mapSeed).toBe(deriveMapSeed(WORLD_SEED, 0, 0));
  expect(lm.digest).toBe(originDigest); // identical roster after departure + revisit
  expect(lm.draws).toBe(originDraws);
  expect(lm.colliders).toBe(originColliders);

  // ---- leg 3 (mobile 360x780): (0,0) --N--> (0,1) — arrival set present, no errors ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await walkThrough('N', 2);
  c = await coord();
  expect(c.mx).toBe(0); expect(c.my).toBe(1);
  lm = await landmarkSnap();
  expect(lm.placed).toBeGreaterThan(0);
  expect(lm.digest).toBe(arrivalDigest); // same seed → same roster on mobile too
  expect(lm.draws).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
