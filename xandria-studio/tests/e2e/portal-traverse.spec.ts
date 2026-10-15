/**
 * Portals workstream B: a scripted bot walks through a portal and arrives at
 * the correct opposite edge of the correct neighboring map — TWICE in a row
 * (there and back) — with zero console/page errors, on desktop AND mobile
 * viewports.
 *
 * Procedure per leg: teleport the bot just inside the edge (streamFocus is
 * pinned to the teleport target so the spawn-first path builds ground under
 * it), face it at the edge, hold W (injected 'forward'), and let the
 * PortalTrigger fire. Arrival is asserted from the manager's own state
 * (coord, transitions, lastArrival) plus the live spec seed.
 *
 * Leg plan: (0,0) --N--> (0,1) [desktop], (0,1) --S--> (0,0) [desktop],
 * then resize to 360x780 and (0,0) --N--> (0,1) [mobile].
 *
 * Timing note: testMode steps 10 sim-substeps per rendered frame, so the
 * ~100m walks take seconds of wall time even under SwiftShader.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const SPECS = existsSync('/tmp/portal-specs/portal-8km.b64')
  ? '/tmp/portal-specs'
  : '/home/hatch/workspace/xandria/qa/openworld/workers-portals';

const HALF = 4000;
const INSET = 120; // must match PORTAL_ARRIVAL_INSET in PortalManager.ts
const WORLD_SEED = 20261014;

interface Snap {
  coord: { mx: number; my: number };
  transitions: number;
  seed: number;
  pos: { x: number; y: number; z: number };
  arrival: { mx: number; my: number; x: number; y: number; z: number } | null;
  streamQueue: number;
}

/** imul/xor hash — must match deriveMapSeed in MapGraph.ts exactly (no (0,0) special case: the origin map is derived like every other map) */
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

test('portal traverse: there and back, zero errors, desktop + mobile', async ({ page }) => {
  test.setTimeout(1_800_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const b64 = readFileSync(`${SPECS}/portal-8km.b64`, 'utf8').trim();
  await page.goto(`/player.html?spec=${encodeURIComponent(b64)}&test=1&autostart=1&splash=0`);

  // NOTE: page.waitForFunction's RAF polling proved unreliable in this
  // environment (it can miss state changes the game itself makes on RAF),
  // so all waits below poll from Node via evaluate() in a loop.
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

  const snap = (): Promise<Snap> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const pm = E.portalManager;
    const p = E.portalsPlayerAvatar.ctrl.position;
    return {
      coord: { ...pm.coord },
      transitions: pm.transitions,
      seed: X.spec.meta.seed,
      pos: { x: p.x, y: p.y, z: p.z },
      arrival: pm.lastArrival
        ? { mx: pm.lastArrival.coord.mx, my: pm.lastArrival.coord.my,
            x: pm.lastArrival.pos.x, y: pm.lastArrival.pos.y, z: pm.lastArrival.pos.z }
        : null,
      streamQueue: E.terrain.getStreamStats().queue,
    };
  });

  /** teleport just inside `edge`, face it, and hold forward until a transition fires */
  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate((edge) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const HALF = 4000;
      const tx = 100;
      // 11m from the edge plane: a short walk (SwiftShader renders ~1fps
      // while the chunk queue drains, so sim-time crawls — the sustained
      // crossing itself is what the trigger debounce must see)
      const tz = edge === 'N' ? HALF - 11 : -(HALF - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      const av = E.portalsPlayerAvatar;
      av.ctrl.teleport(new V(tx, y, tz));
      av.health = av.maxHealth = 1e9; // keep the bot alive — test-only
      // Movement is camera-relative and the blueprint overwrites ctrl.camYaw
      // every frame from the camera rig (camYaw = camRig.yaw + PI), so steer
      // by nudging the rig: yaw -= look.x * 0.0026, consumed one-shot by the
      // next frame. Target camYaw: PI to walk +z (north), 0 to walk -z (south).
      const want = edge === 'N' ? Math.PI : 0;
      let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      E.input.look.x = -d / 0.0026;
    }, edge);
    // let the look nudge apply (a couple of slow SwiftShader frames)
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
    // let the stream queue settle around the arrival point (best-effort:
    // the assertions below don't need a fully drained queue)
    try {
      const drained = (): Promise<boolean> => page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.engine.terrain.getStreamStats().queue === 0;
      });
      await waitFor('stream drain', drained, 120_000);
    } catch {
      /* queue still draining under SwiftShader — non-fatal */
    }
  };

  // ---- leg 1 (desktop): (0,0) --N--> (0,1), arrive at the S edge ----
  await walkThrough('N', 0);
  let s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 1 });
  expect(s.transitions).toBe(1);
  expect(s.seed).toBe(deriveMapSeed(WORLD_SEED, 0, 1));
  expect(s.arrival).not.toBeNull();
  expect(Math.abs(s.pos.z - (-(HALF - INSET)))).toBeLessThan(80);
  expect(Math.abs(s.pos.x)).toBeLessThan(HALF - INSET + 40);

  // ---- leg 2 (desktop): (0,1) --S--> (0,0), arrive at the N edge ----
  await walkThrough('S', 1);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 0 });
  expect(s.transitions).toBe(2);
  expect(s.seed).toBe(deriveMapSeed(WORLD_SEED, 0, 0)); // back at the origin map (derived like every map)
  expect(Math.abs(s.pos.z - (HALF - INSET))).toBeLessThan(80);

  // ---- leg 3 (mobile viewport): (0,0) --N--> (0,1) again ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await walkThrough('N', 2);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 1 });
  expect(s.transitions).toBe(3);
  expect(s.seed).toBe(deriveMapSeed(WORLD_SEED, 0, 1));
  expect(Math.abs(s.pos.z - (-(HALF - INSET)))).toBeLessThan(80);

  await page.screenshot({ path: '/tmp/portal-arrival-mobile.png' });
  expect(errors).toEqual([]);
});
