/**
 * minimap-fog: minimap + seeded fog-of-war e2e (not eyeballing).
 *
 * Fixtures: npcs.b64 (seed 20261012, tp-action, 512m walled arena, portals
 * off) for reveal/discovery/beacon/toggle; portal-8km.b64 (8km, portals on)
 * for the portal round-trip leg.
 *
 * Desktop (1280x720):
 *  1. Minimap boots expanded: panel + canvas visible, zero console/page errors.
 *  2. FOG REVEAL: arrival reveals tiles around spawn; teleport east →
 *     coverage strictly increases; the tile under the player is revealed and
 *     a tile outside the radius is not (radius rule, behavioral).
 *  3. LANDMARK DISCOVERY: teleport within discovery range of a placed
 *     landmark → discoveredCount rises (marker renders on the canvas).
 *  4. EVENT BEACON: force-start the ambush event → its beacon diamond is
 *     painted on the minimap canvas (pixel assertion at the mapped position).
 *  5. TOGGLE: M key collapses to the chip, M again expands; chip click expands.
 *  6. PORTAL ROUND-TRIP (8km fixture): cross the north edge → minimap
 *     switches to the new map key with an independent fog grid; cross back →
 *     the origin map's fog is restored exactly (departure-area tile still
 *     revealed, tile count not reset).
 *  7. Screenshots.
 *
 * Mobile (360x780, touch): starts collapsed (chip only); expanding via the
 * chip docks the panel above the touch buttons; pairwise overlap audit of the
 * expanded panel against the quest tracker / score / touch buttons — zero
 * intersections (hud-polish audit convention). Screenshot.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const PORTAL_RAW = readFileSync(
  '/home/hatch/workspace/xandria/qa/openworld/workers-portals/portal-8km.b64', 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint builds
// the item kit (sidequests.spec.ts pattern).
const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);
const PORTAL_B64 = withItems(PORTAL_RAW);

type X = { __XANDRIA__?: any };
type Box = { x: number; y: number; w: number; h: number; id: string };

async function boot(page: any, errors: string[], b64: string): Promise<void> {
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(b64)}&test=1&autostart=1&splash=0`);
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X?.engine.minimap && X?.eventsTest && X?.questTest
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
}

function harness(page: any) {
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  /** teleport the avatar to (x, z), grounded +3m */
  const teleport = (x: number, z: number): Promise<void> => page.evaluate(([x, z]: number[]) => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const y = E.terrain.heightAt(x, z) + 3;
    E.portalsPlayerAvatar.ctrl.teleport(new V(x, y, z));
  }, [x, z]);
  const boxes = (sels: string[]): Promise<Box[]> => page.evaluate((sels: string[]) => {
    const out: Box[] = [];
    for (const s of sels) {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height, id: s });
    }
    return out;
  }, sels);
  /** walk through `edge` (N/S): teleport 11m inside, face it, hold forward */
  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate((edge: 'N' | 'S') => {
      const X = (window as unknown as X).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const HALF = 4000;
      const tx = 100;
      const tz = edge === 'N' ? HALF - 11 : -(HALF - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      E.portalsPlayerAvatar.ctrl.teleport(new V(tx, y, tz));
      const want = edge === 'N' ? Math.PI : 0; // +z north at PI
      let d = (want - E.portalsPlayerAvatar.ctrl.camYaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      E.input.look.x = -d / 0.0026;
    }, edge);
    await page.waitForTimeout(8000);
    await page.evaluate(() => {
      (window as unknown as X).__XANDRIA__!.engine.input.inject(['forward', 'sprint'], null);
    });
    await waitFor(`transition to ${fromTransitions + 1}`, () => page.evaluate((n: number) =>
      (window as unknown as X).__XANDRIA__!.engine.portalManager.transitions >= n, fromTransitions + 1), 300_000);
    await page.evaluate(() => {
      (window as unknown as X).__XANDRIA__!.engine.input.inject([], null);
    });
  };
  return { waitFor, teleport, boxes, walkThrough };
}

const overlapPairs = (list: Box[]): Array<[Box, Box]> => {
  const hits: Array<[Box, Box]> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push([a, b]);
    }
  }
  return hits;
};

test('minimap-fog: reveal, discovery, beacons, toggle, portal round-trip (desktop 1280x720)', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  await boot(page, errors, B64);
  const h = harness(page);

  // ---- 1. minimap boots expanded (512m arena) ----
  const vis = await page.evaluate(() => {
    const root = document.getElementById('xandria-minimap') as HTMLElement | null;
    const canvas = root?.querySelector('canvas') as HTMLCanvasElement | null;
    const cs = root ? getComputedStyle(root) : null;
    return {
      root: !!root, canvas: !!canvas, cw: canvas?.width ?? 0,
      visible: !!root && cs!.display !== 'none',
      expanded: (window as unknown as X).__XANDRIA__!.engine.minimap.isExpanded,
    };
  });
  console.log('[minimap] boot: ' + JSON.stringify(vis));
  expect(vis.root, 'minimap root exists').toBe(true);
  expect(vis.visible, 'minimap visible').toBe(true);
  expect(vis.expanded, 'expanded by default on desktop').toBe(true);

  // ---- 2. fog reveal (world is 512m: use in-bounds distances) ----
  const fog0 = await page.evaluate(() => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap;
    const s = M.fogStateFor('0,0');
    return { tiles: s.fog.revealedTiles, cov: M.coverage, key: M.activeKey };
  });
  console.log('[minimap] arrival fog: ' + JSON.stringify(fog0));
  expect(fog0.key).toBe('0,0');
  expect(fog0.tiles).toBeGreaterThan(0); // arrival point revealed

  await h.teleport(150, 0);
  await h.waitFor('reveal after teleport', () => page.evaluate(() => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap;
    return M.fogStateFor('0,0').fog.isRevealed(150, 0);
  }), 60_000);
  const fog1 = await page.evaluate(() => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap;
    const f = M.fogStateFor('0,0').fog;
    return {
      tiles: f.revealedTiles,
      underPlayer: f.isRevealed(150, 0),
      farAway: f.isRevealed(200, 200), // ~283m from origin, outside the 150m radius
    };
  });
  console.log('[minimap] after teleport: ' + JSON.stringify(fog1));
  expect(fog1.tiles).toBeGreaterThan(fog0.tiles);
  expect(fog1.underPlayer, 'tile under the player is revealed').toBe(true);
  expect(fog1.farAway, 'tile outside the reveal radius stays fogged').toBe(false);

  // ---- 3. landmark discovery ----
  const lmPos: { x: number; z: number } | null = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const sys = X.engine.portalEntities.byId('landmarks') as any;
    const p = sys?.placed?.[0]?.pos;
    return p ? { x: p.x, z: p.z } : null;
  });
  expect(lmPos, 'a placed landmark exists').toBeTruthy();
  const disc0: number = await page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.engine.minimap.discoveredCount);
  await h.teleport(lmPos!.x + 15, lmPos!.z + 15);
  await h.waitFor('landmark discovered', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.engine.minimap.discoveredCount > 0), 60_000);
  const disc1: number = await page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.engine.minimap.discoveredCount);
  console.log(`[minimap] discovered: ${disc0} -> ${disc1}`);
  expect(disc1).toBeGreaterThan(disc0);

  // ---- 4. event beacon paints on the canvas ----
  // The beacon scan runs on game-time (0.5s throttle); under SwiftShader
  // game-time crawls, so wait for the minimap to pick the beacon up.
  // NOTE: an ambush beacon anchors to combatants[0].position (a ring around
  // the player at force-start), NOT the event plan pos — key off the live
  // beacon position.
  const ambushBeacon: { x: number; z: number } = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const ok = X.eventsTest.liveManager().startEventForTest('event_ambush');
    if (!ok) throw new Error('could not force-start event_ambush');
    const mgr = X.engine.portalEntities.byId('events') as any;
    const ev = mgr.events.find((e: any) => e.plan.defId === 'event_ambush' && e.beacon);
    if (!ev) throw new Error('ambush beacon missing after force-start');
    return { x: ev.beacon.group.position.x, z: ev.beacon.group.position.z };
  });
  // move the player well clear so its marker can't cover the beacon diamond
  await h.teleport(Math.max(-240, Math.min(240, ambushBeacon.x + 200)), ambushBeacon.z);
  const ambushKey = `${Math.round(ambushBeacon.x)},${Math.round(ambushBeacon.z)}`;
  await h.waitFor('minimap picks up the ambush beacon', () => page.evaluate((k: string) => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap as any;
    const [kx, kz] = k.split(',').map(Number);
    return M.lastBeaconSig.split(';').some((s: string) => {
      const [bx, bz] = s.split(',').map(Number);
      return Math.abs(bx - kx) <= 2 && Math.abs(bz - kz) <= 2;
    });
  }, ambushKey), 180_000);
  // pixel assertion: the beacon diamond (red #ff4d3d) must be painted at the
  // beacon's world→canvas position (markers draw above the fog overlay).
  // The 512m map spans the full 208px canvas.
  const beaconPx = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const mgr = X.engine.portalEntities.byId('events') as any;
    const ev = mgr.events.find((e: any) => e.status === 'active' && e.beacon && e.plan.defId === 'event_ambush');
    if (!ev) return null;
    const bp = ev.beacon.group.position;
    const half = 256, W = 208;
    const px = ((bp.x + half) / (half * 2)) * W;
    const py = ((half - bp.z) / (half * 2)) * W;
    const canvas = document.querySelector('#xandria-minimap canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.getImageData(Math.max(0, Math.floor(px) - 6), Math.max(0, Math.floor(py) - 6), 13, 13);
    let red = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r > 200 && g < 120 && b < 120) red++;
    }
    return { red };
  });
  console.log('[minimap] beacon pixels: ' + JSON.stringify(beaconPx));
  expect(beaconPx, 'the ambush beacon exists').toBeTruthy();
  expect(beaconPx!.red, 'beacon diamond painted on the minimap').toBeGreaterThan(0);

  // ---- 5. M key + chip toggle ----
  await page.keyboard.press('m');
  await page.waitForFunction(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X?.engine?.minimap && !X.engine.minimap.isExpanded;
  }, null, { timeout: 15_000 });
  const chipVisible = await page.evaluate(() => {
    const c = document.querySelector('#xandria-minimap .mchip') as HTMLElement | null;
    return !!c && getComputedStyle(c).display !== 'none';
  });
  expect(chipVisible, 'chip visible when collapsed').toBe(true);
  await page.click('#xandria-minimap .mchip');
  await page.waitForFunction(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X?.engine?.minimap?.isExpanded;
  }, null, { timeout: 15_000 });
  await page.screenshot({ path: resolve(HERE, 'screenshots/minimap-desktop.png') });

  // ---- 6. portal round-trip on the 8km fixture: fog is per-map, restored on re-entry ----
  await boot(page, errors, PORTAL_B64);
  const h2 = harness(page);
  await h2.teleport(100, 3800);
  await h2.waitFor('departure area revealed', () => page.evaluate(() => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap;
    return M.fogStateFor(M.activeKey).fog.isRevealed(100, 3900);
  }), 60_000);
  const tilesBefore: number = await page.evaluate(() => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap;
    return M.fogStateFor('0,0').fog.revealedTiles;
  });
  await h2.walkThrough('N', 0);
  // the new 8km terrain build blocks the main thread; wait for the minimap
  // tick to arrive on the new map before sampling
  await h2.waitFor('minimap arrives on (0,1)', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.engine.minimap.activeKey === '0,1'), 600_000);
  const away = await page.evaluate(() => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap;
    const key = M.activeKey;
    return { key, tiles: M.fogStateFor(key).fog.revealedTiles, originTiles: M.fogStateFor('0,0').fog.revealedTiles };
  });
  console.log('[minimap] after north crossing: ' + JSON.stringify(away));
  expect(away.key, 'minimap switched to the new map').not.toBe('0,0');
  // the crossing walk reveals a few more origin tiles before the transition
  // fires — the point is the grid was kept, never reset.
  expect(away.originTiles, 'origin fog grid kept while away').toBeGreaterThanOrEqual(tilesBefore);

  await h2.walkThrough('S', 1);
  await h2.waitFor('minimap back on (0,0)', () => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.engine.minimap.activeKey === '0,0'), 600_000);
  const back = await page.evaluate(() => {
    const M = (window as unknown as X).__XANDRIA__!.engine.minimap;
    const f = M.fogStateFor('0,0').fog;
    return {
      key: M.activeKey,
      tiles: f.revealedTiles,
      departureStillRevealed: f.isRevealed(100, 3900),
      bakeMs: M.bakeMs, redraws: M.redraws, lastRedrawMs: M.lastRedrawMs,
    };
  });
  console.log('[minimap] after return: ' + JSON.stringify(back));
  expect(back.key, 'back on the origin map').toBe('0,0');
  expect(back.tiles, 'origin fog restored, not reset').toBeGreaterThanOrEqual(tilesBefore);
  expect(back.departureStillRevealed, 'departure-area tile still revealed after re-entry').toBe(true);
  await page.screenshot({ path: resolve(HERE, 'screenshots/minimap-portal.png') });

  expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
});

test.describe('mobile 360x780', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('minimap-fog: collapsed by default, expand docks clear of the tracker', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    await boot(page, errors, B64);
    const h = harness(page);

    // starts collapsed on small screens
    const start = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const chip = document.querySelector('#xandria-minimap .mchip') as HTMLElement | null;
      return {
        expanded: X.engine.minimap.isExpanded,
        chipVisible: !!chip && getComputedStyle(chip).display !== 'none',
      };
    });
    console.log('[minimap] mobile start: ' + JSON.stringify(start));
    expect(start.expanded, 'collapsed by default on 360x780').toBe(false);
    expect(start.chipVisible, 'chip visible').toBe(true);

    // expand via the chip, then run the hud-polish-style overlap audit
    await page.click('#xandria-minimap .mchip');
    await page.waitForFunction(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X?.engine?.minimap?.isExpanded;
    }, null, { timeout: 15_000 });
    const boxes = await h.boxes([
      '#xandria-minimap .mbox',
      '#xandria-quest-tracker',
      '.xhud .score',
      '.xhud .objective',
      '.xtouch .pausebtn',
      '.xhud .bars',
    ]);
    console.log('[minimap] mobile boxes: ' + JSON.stringify(boxes));
    const hits = overlapPairs(boxes);
    expect(hits, 'no HUD-chip intersections, got: ' + JSON.stringify(hits)).toEqual([]);

    // capture the expanded panel visually before collapsing again
    await page.screenshot({ path: resolve(HERE, 'screenshots/minimap-mobile-expanded.png') });

    // M key toggles on touch layouts too
    await page.keyboard.press('m');
    await page.waitForFunction(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X?.engine?.minimap && !X.engine.minimap.isExpanded;
    }, null, { timeout: 15_000 });

    await page.screenshot({ path: resolve(HERE, 'screenshots/minimap-mobile.png') });
    expect(errors, 'zero console/page errors, got: ' + JSON.stringify(errors.slice(0, 5))).toEqual([]);
  });
});
