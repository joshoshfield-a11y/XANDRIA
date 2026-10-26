/**
 * UPGRADE LOOP (fast-travel phase): discovered-portal registry + world-map
 * panel + fast travel through the real portal pipeline.
 *
 * On the deterministic portal-8km fixture (world seed 20261014), booted
 * with test=1 + autostart:
 *  1. Boot: registry holds only the origin (0,0); the world-map panel
 *     lists exactly that row, marked YOU ARE HERE, with no travel button.
 *  2. Walk N to (0,1), S back to (0,0), E to (1,0) — registry grows to
 *     three entries; walked-arrival landmark digests + tiers are captured
 *     for (0,1) and (1,0).
 *  3. Panel lists exactly the three discovered portals with biome/tier
 *     labels; undiscovered maps ((0,-1), (2,0), (-1,0)) appear nowhere.
 *  4. Panel travel (0,0) -> (0,1): arrival state (map seed, landmark
 *     digest, draws, colliders, tier) is IDENTICAL to the walked arrival.
 *  5. Panel travel (0,1) -> (1,0) (non-adjacent): same identity check
 *     against the walked (1,0) arrival.
 *  6. Page reload: the registry survives (all three portals still listed),
 *     current map back at the origin.
 *  7. Mobile leg (360x780): chip + panel usable, all travel buttons
 *     >= 28px, chip does not overlap the quest tracker / HUD boxes,
 *     panel travel works, zero console/page errors throughout.
 *
 * Walk helper generalizes portal-traverse's: teleport just inside the
 * edge, nudge the camera rig yaw, inject forward+sprint, wait for the
 * transition counter. Movement is camera-relative; forward dirs at camYaw
 * are (−sin yaw, −cos yaw), so N(+z)=PI, S(−z)=0, E(+x)=−PI/2.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const SPECS = existsSync('/tmp/portal-specs/portal-8km.b64')
  ? '/tmp/portal-specs'
  : '/home/hatch/workspace/xandria/qa/openworld/workers-portals';

const HALF = 4000;
const INSET = 120; // must match PORTAL_ARRIVAL_INSET in PortalManager.ts
const WORLD_SEED = 20261014;

/** imul/xor hash — must match deriveMapSeed in MapGraph.ts exactly. */
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

interface PortalRow { mx: number; my: number; biome: string; tier: number; order: number }
interface ArrivalSnap {
  coord: { mx: number; my: number };
  transitions: number;
  seed: number;
  tier: number;
  registry: PortalRow[];
  landmarkDigest: string;
  landmarkPlaced: number;
  landmarkDraws: number;
  landmarkColliders: number;
  pos: { x: number; y: number; z: number };
}

test('fast travel: discover, panel, travel-identical arrivals, reload, mobile', async ({ page }) => {
  test.setTimeout(1_800_000);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const b64 = readFileSync(`${SPECS}/portal-8km.b64`, 'utf8').trim();
  const url = `/player.html?spec=${encodeURIComponent(b64)}&test=1&autostart=1&splash=0`;
  await page.goto(url);

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

  const snap = (): Promise<ArrivalSnap> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const pm = E.portalManager;
    const sys = (E.portalEntities.systems as any[]).find((s) => s.id === 'landmarks');
    const placed = (sys?.placed ?? []) as Array<{ kind: string; pos: { x: number; z: number } }>;
    const digest = placed
      .map((p) => `${p.kind}@${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)}`)
      .sort()
      .join('|');
    const pos = E.portalsPlayerAvatar.ctrl.position;
    return {
      coord: { mx: pm.coord.mx, my: pm.coord.my },
      transitions: pm.transitions,
      seed: X.spec.meta.seed,
      tier: E.worldTier,
      registry: pm.discovered.list(),
      landmarkDigest: digest,
      landmarkPlaced: placed.length,
      landmarkDraws: sys ? sys.drawCalls() : 0,
      landmarkColliders: sys ? sys.colliderCount : 0,
      pos: { x: pos.x, y: pos.y, z: pos.z },
    };
  });

  const walkThrough = async (edge: 'N' | 'S' | 'E', fromTransitions: number) => {
    await page.evaluate((edge) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const HALF = 4000;
      const tx = edge === 'E' ? HALF - 11 : 100;
      const tz = edge === 'N' ? HALF - 11 : edge === 'S' ? -(HALF - 11) : 100;
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      const av = E.portalsPlayerAvatar;
      av.ctrl.teleport(new V(tx, y, tz));
      av.health = av.maxHealth = 1e9;
      const want = edge === 'N' ? Math.PI : edge === 'S' ? 0 : -Math.PI / 2;
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

  const panelRows = async (): Promise<Array<{ mx: number; my: number; text: string }>> => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#xandria-fast-travel-panel [data-mx]')];
    return rows.map((r) => ({
      mx: Number(r.getAttribute('data-mx')),
      my: Number(r.getAttribute('data-my')),
      text: (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));
  });

  const travelViaPanel = async (mx: number, my: number, fromTransitions: number) => {
    await page.locator('#xandria-fast-travel-chip').click();
    await page.waitForFunction(() => {
      const p = document.getElementById('xandria-fast-travel-panel') as HTMLElement | null;
      return !!p && p.style.display !== 'none';
    }, null, { timeout: 15_000 });
    await page.locator(`#xandria-fast-travel-panel [data-mx="${mx}"][data-my="${my}"] button`).click();
    await waitFor(`fast travel to (${mx},${my})`, async () => {
      const s = await snap();
      return s.coord.mx === mx && s.coord.my === my && s.transitions >= fromTransitions + 1;
    }, 300_000);
    // panel closes on travel start; the arrival overlay reveals after
    await page.waitForTimeout(3000);
  };

  // ---- 1. boot: only the origin is discovered ----
  let s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 0 });
  expect(s.registry.map((p) => [p.mx, p.my])).toEqual([[0, 0]]);
  expect(s.registry[0].tier).toBe(1);
  await page.locator('#xandria-fast-travel-chip').click();
  await page.waitForFunction(() => {
    const p = document.getElementById('xandria-fast-travel-panel') as HTMLElement | null;
    return !!p && p.style.display !== 'none';
  }, null, { timeout: 15_000 });
  let rows = await panelRows();
  expect(rows.map((r) => [r.mx, r.my])).toEqual([[0, 0]]);
  expect(rows[0].text).toContain('YOU ARE HERE');
  expect(await page.locator('#xandria-fast-travel-panel button').count(), 'origin row has no TRAVEL button, only the × close').toBe(1);
  await page.locator('#xandria-fast-travel-panel button').first().click(); // × close

  // ---- 2. discover (0,1), back to (0,0), then (1,0) by walking ----
  await walkThrough('N', s.transitions);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 1 });
  expect(s.seed).toBe(deriveMapSeed(WORLD_SEED, 0, 1));
  const walked01 = { ...s };
  expect(s.registry.map((p) => [p.mx, p.my])).toEqual([[0, 0], [0, 1]]);

  await walkThrough('S', s.transitions);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 0 });

  await walkThrough('E', s.transitions);
  s = await snap();
  expect(s.coord).toEqual({ mx: 1, my: 0 });
  expect(s.seed).toBe(deriveMapSeed(WORLD_SEED, 1, 0));
  const walked10 = { ...s };
  expect(s.registry.map((p) => [p.mx, p.my])).toEqual([[0, 0], [0, 1], [1, 0]]);

  // ---- 3. panel lists exactly the discovered portals; undiscovered hidden ----
  await page.locator('#xandria-fast-travel-chip').click();
  await page.waitForFunction(() => {
    const p = document.getElementById('xandria-fast-travel-panel') as HTMLElement | null;
    return !!p && p.style.display !== 'none';
  }, null, { timeout: 15_000 });
  rows = await panelRows();
  expect(rows.map((r) => [r.mx, r.my])).toEqual([[0, 0], [0, 1], [1, 0]]);
  for (const r of rows) {
    expect(r.text, `row (${r.mx},${r.my}) carries a biome/tier label`).toMatch(/Tier \d/);
  }
  for (const [mx, my] of [[0, -1], [2, 0], [-1, 0]] as const) {
    expect(await page.locator(`#xandria-fast-travel-panel [data-mx="${mx}"][data-my="${my}"]`).count(),
      `undiscovered (${mx},${my}) must not render`).toBe(0);
  }
  await page.keyboard.press('Escape');

  // ---- 4. panel travel (1,0) -> (0,1): identical to the walked arrival ----
  await travelViaPanel(0, 1, s.transitions);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 1 });
  expect(s.seed).toBe(walked01.seed);
  expect(s.tier).toBe(walked01.tier);
  expect(s.landmarkDigest).toBe(walked01.landmarkDigest);
  expect(s.landmarkPlaced).toBe(walked01.landmarkPlaced);
  expect(s.landmarkDraws).toBe(walked01.landmarkDraws);
  expect(s.landmarkColliders).toBe(walked01.landmarkColliders);
  // Fast travel from (1,0) to (0,1) heads north on the dominant axis
  // (tie → N/S): arrives at the S edge, edge-center, facing north —
  // the same edge a walked N crossing would arrive at.
  expect(Math.abs(s.pos.z - (-(HALF - INSET)))).toBeLessThan(80);
  expect(Math.abs(s.pos.x)).toBeLessThan(80);

  // ---- 5. panel travel (0,1) -> (1,0), non-adjacent: identical again ----
  await travelViaPanel(1, 0, s.transitions);
  s = await snap();
  expect(s.coord).toEqual({ mx: 1, my: 0 });
  expect(s.seed).toBe(walked10.seed);
  expect(s.tier).toBe(walked10.tier);
  expect(s.landmarkDigest).toBe(walked10.landmarkDigest);
  expect(s.landmarkPlaced).toBe(walked10.landmarkPlaced);
  expect(s.landmarkDraws).toBe(walked10.landmarkDraws);
  expect(s.landmarkColliders).toBe(walked10.landmarkColliders);

  // ---- 6. reload preserves the registry; current map is the origin ----
  await page.goto(url);
  await waitFor('reboot', booted, 240_000);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 0 });
  expect(s.registry.map((p) => [p.mx, p.my])).toEqual([[0, 0], [0, 1], [1, 0]]);

  // ---- 7. mobile leg: chip + panel usable, touch targets, no overlap ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  const chipBox = await page.evaluate(() => {
    const el = document.getElementById('xandria-fast-travel-chip') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  expect(chipBox.w).toBeGreaterThanOrEqual(28);
  expect(chipBox.h).toBeGreaterThanOrEqual(28);
  expect(chipBox.x).toBeGreaterThanOrEqual(0);
  expect(chipBox.x + chipBox.w).toBeLessThanOrEqual(360);
  // Chip must not overlap any visible HUD box (tracker, score, objective, bars).
  const overlap = await page.evaluate(() => {
    const chip = document.getElementById('xandria-fast-travel-chip') as HTMLElement;
    const c = chip.getBoundingClientRect();
    const hits: string[] = [];
    for (const sel of ['#xandria-quest-tracker', '.xhud .score', '.xhud .objective', '.xhud .bars']) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el || el.getBoundingClientRect().width === 0) continue;
      const r = el.getBoundingClientRect();
      const intersects = c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top;
      if (intersects) hits.push(sel);
    }
    return hits;
  });
  expect(overlap, 'MAP chip must not overlap HUD boxes on mobile').toEqual([]);
  await page.locator('#xandria-fast-travel-chip').click();
  await page.waitForFunction(() => {
    const p = document.getElementById('xandria-fast-travel-panel') as HTMLElement | null;
    return !!p && p.style.display !== 'none';
  }, null, { timeout: 15_000 });
  const btnSizes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#xandria-fast-travel-panel button')];
    return btns.map((b) => {
      const r = (b as HTMLElement).getBoundingClientRect();
      return { text: (b.textContent ?? '').trim(), w: r.width, h: r.height };
    });
  });
  for (const b of btnSizes) {
    if (b.text === 'TRAVEL') {
      expect(b.h, 'travel button >= 28px tall').toBeGreaterThanOrEqual(28);
      expect(b.w, 'travel button >= 28px wide').toBeGreaterThanOrEqual(28);
    }
  }
  const tBefore = (await snap()).transitions;
  await page.locator('#xandria-fast-travel-panel [data-mx="0"][data-my="1"] button').click();
  await waitFor('mobile fast travel to (0,1)', async () => {
    const cur = await snap();
    return cur.coord.mx === 0 && cur.coord.my === 1 && cur.transitions >= tBefore + 1;
  }, 300_000);
  s = await snap();
  expect(s.landmarkDigest).toBe(walked01.landmarkDigest);
  expect(s.tier).toBe(walked01.tier);

  expect(errors, 'zero console/page errors').toEqual([]);
});
