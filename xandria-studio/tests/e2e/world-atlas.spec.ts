/**
 * UPGRADE LOOP (world-atlas phase): the world atlas panel — a
 * discovered-maps overview reusing the fast-travel registry, the
 * minimap-fog discovery state, and the camp profile.
 *
 * On the deterministic portal-8km fixture (world seed 20261014), booted
 * with test=1 + autostart (materials granted via the withItems spec
 * tweak, as in the camp portal leg):
 *  1. Boot: atlas lists only the origin (tier 1, no camp built, fog %
 *     in range, 4 uncharted neighbors); no neighbor rows render.
 *  2. Build the camp chest on the origin via the shipped manager path.
 *  3. Walk N to (0,1), S back, E to (1,0) — walked-arrival digests
 *     captured for (0,1) and (1,0).
 *  4. Atlas lists exactly the three discovered maps with registry
 *     tiers, camp flags (origin built, others site-only), and fog %
 *     equal to the live minimap seam; undiscovered maps appear nowhere;
 *     uncharted-neighbor count is 7; Esc closes without pausing.
 *  5. Atlas JUMP (1,0) -> (0,1) and (0,1) -> (1,0): arrival state
 *     IDENTICAL to the walked arrivals (seed, tier, landmark digest,
 *     placed count, draws, colliders) at the same edge-center arrival.
 *  6. Page reload: rows, tiers, and camp flags preserved; fog %s still
 *     equal the live seam (session fog re-derives on the current map).
 *  7. Mobile leg (360x780): chip >= 28px, in viewport, no overlap with
 *     HUD boxes or the MAP chip; JUMP buttons >= 28px; atlas jump works.
 *  8. Title screen: engine.toTitle() keeps the atlas usable — the chip
 *     sits above the title overlay and the panel lists all three maps.
 *  Perf: opening the DOM-only atlas adds no WebGL draw calls (median
 *  renderer.info.render.calls, panel closed vs open, delta <= 2).
 *
 * Walk helper generalizes portal-traverse's: teleport just inside the
 * edge, nudge the camera rig yaw, inject forward+sprint, wait for the
 * transition counter. Movement is camera-relative; forward dirs at
 * camYaw are (−sin yaw, −cos yaw), so N(+z)=PI, S(−z)=0, E(+x)=−PI/2.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SPECS = '/home/hatch/workspace/xandria/qa/openworld/workers-portals';

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

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};

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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

test('world atlas: discovered maps, fog, camps, jumps, reload, mobile, title screen', async ({ page }) => {
  test.setTimeout(1_800_000);
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const b64 = withItems(readFileSync(`${SPECS}/portal-8km.b64`, 'utf8').trim());
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
    return !!(X?.engine?.portalManager && X?.atlasTest && X?.campTest && X?.blueprint?.itemKit
      && X.engine.portalsPlayerAvatar && X.engine.state === 'playing');
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

  /** Live fog % per map from the shipped minimap seam (the atlas's source). */
  const liveFog = (): Promise<Record<string, number>> => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const out: Record<string, number> = {};
    for (const p of X.engine.portalManager.discovered.list()) {
      out[`${p.mx},${p.my}`] = Math.round(X.engine.minimap.coverageFor(p.mx, p.my) * 100);
    }
    return out;
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

  const atlasRows = async (): Promise<Array<{ mx: number; my: number; tier: number; biome: string; fog: number; camp: number; text: string }>> => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#xandria-world-atlas-panel [data-mx]')];
    return rows.map((r) => ({
      mx: Number(r.getAttribute('data-mx')),
      my: Number(r.getAttribute('data-my')),
      tier: Number(r.getAttribute('data-tier')),
      biome: r.getAttribute('data-biome') ?? '',
      fog: Number(r.getAttribute('data-fog')),
      camp: Number(r.getAttribute('data-camp')),
      text: (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));
  });

  const openAtlas = async () => {
    await page.locator('#xandria-world-atlas-chip').click();
    await page.waitForFunction(() => {
      const p = document.getElementById('xandria-world-atlas-panel') as HTMLElement | null;
      return !!p && p.style.display !== 'none';
    }, null, { timeout: 15_000 });
  };

  const atlasClosed = async (): Promise<boolean> => page.evaluate(() => {
    const p = document.getElementById('xandria-world-atlas-panel') as HTMLElement | null;
    return !p || p.style.display === 'none';
  });

  const jumpViaAtlas = async (mx: number, my: number, fromTransitions: number) => {
    await openAtlas();
    await page.locator(`#xandria-world-atlas-panel [data-mx="${mx}"][data-my="${my}"] button`).click();
    await waitFor(`atlas jump to (${mx},${my})`, async () => {
      const s = await snap();
      return s.coord.mx === mx && s.coord.my === my && s.transitions >= fromTransitions + 1;
    }, 300_000);
    await page.waitForTimeout(3000);
    expect(await atlasClosed(), 'atlas closes on jump').toBe(true);
  };

  const sampleCalls = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.renderer.info.render.calls));
      await page.waitForTimeout(300);
    }
    return out;
  };

  // ---- 1. boot: only the origin is discovered; perf baseline ----
  let s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 0 });
  expect(s.registry.map((p) => [p.mx, p.my])).toEqual([[0, 0]]);
  expect(s.registry[0].tier).toBe(1);
  try {
    await waitFor('stream drain at boot', async () => page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.terrain.getStreamStats().queue === 0;
    }), 120_000);
  } catch { /* non-fatal */ }
  const closedCalls = median(await sampleCalls(7));
  await openAtlas();
  const openCalls = median(await sampleCalls(7));
  console.log(`[world-atlas] perf: draw calls closed=${closedCalls} open=${openCalls}`);
  expect(openCalls, 'opening the DOM-only atlas adds no WebGL draw calls').toBeLessThanOrEqual(closedCalls + 2);
  let rows = await atlasRows();
  expect(rows.map((r) => [r.mx, r.my])).toEqual([[0, 0]]);
  expect(rows[0].tier).toBe(1);
  expect(rows[0].camp, 'no camp built on the origin yet').toBe(0);
  expect(rows[0].fog, 'fog % is an integer percent').toBeGreaterThanOrEqual(0);
  expect(rows[0].fog).toBeLessThanOrEqual(100);
  expect(rows[0].text).toContain('YOU ARE HERE');
  expect(rows[0].text).toMatch(/Tier 1/);
  expect(rows[0].text).toMatch(/Fog revealed \d+%/);
  expect(rows[0].text).toContain('Camp site only');
  const unchartedBoot = await page.locator('#xandria-atlas-uncharted').textContent();
  expect(unchartedBoot).toContain('4 neighboring maps still uncharted');
  for (const [mx, my] of [[0, 1], [1, 0], [0, -1], [-1, 0]] as const) {
    expect(await page.locator(`#xandria-world-atlas-panel [data-mx="${mx}"][data-my="${my}"]`).count(),
      `undiscovered (${mx},${my}) must not render`).toBe(0);
  }
  await page.locator('#xandria-world-atlas-panel button').first().click(); // × close
  await waitFor('atlas closed', atlasClosed, 15_000);

  // ---- 2. build the camp chest on the origin (shipped manager path) ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    inv.add('mat_ore', 99); inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
  });
  const builtChest = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const mgr = X.campTest.liveManager();
    return { ok: mgr.buildStructure('chest').ok, built: [...mgr.built] };
  });
  expect(builtChest.ok, 'camp chest builds on the origin').toBe(true);
  expect(builtChest.built).toContain('chest');

  // ---- 3. discover (0,1), back to (0,0), then (1,0) by walking ----
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

  // ---- 4. atlas lists exactly the discovered maps, enriched ----
  await openAtlas();
  rows = await atlasRows();
  expect(rows.map((r) => [r.mx, r.my])).toEqual([[0, 0], [0, 1], [1, 0]]);
  const registry = (await snap()).registry;
  for (const r of rows) {
    const reg = registry.find((p) => p.mx === r.mx && p.my === r.my)!;
    expect(r.tier, `row (${r.mx},${r.my}) tier matches the registry`).toBe(reg.tier);
    expect(r.biome, `row (${r.mx},${r.my}) biome matches the registry`).toBe(reg.biome);
    expect(r.text, `row (${r.mx},${r.my}) carries a biome/tier label`).toMatch(/Tier \d/);
    expect(r.text).toMatch(/Fog revealed \d+%/);
  }
  const fog = await liveFog();
  for (const r of rows) {
    expect(r.fog, `row (${r.mx},${r.my}) fog % equals the live minimap seam`).toBe(fog[`${r.mx},${r.my}`]);
  }
  expect(rows[0].camp, 'origin row shows the built chest').toBe(1);
  expect(rows[0].text).toContain('1 structure built');
  expect(rows[1].camp, '(0,1) has no built camp').toBe(0);
  expect(rows[2].camp, '(1,0) has no built camp').toBe(0);
  expect(rows[1].text).toContain('Camp site only');
  const uncharted = await page.locator('#xandria-atlas-uncharted').textContent();
  expect(uncharted).toContain('7 neighboring maps still uncharted');
  for (const [mx, my] of [[0, -1], [2, 0], [-1, 0], [1, 1]] as const) {
    expect(await page.locator(`#xandria-world-atlas-panel [data-mx="${mx}"][data-my="${my}"]`).count(),
      `undiscovered (${mx},${my}) must not render`).toBe(0);
  }
  // Esc closes the atlas without pausing the game (capture-phase handler).
  await page.keyboard.press('Escape');
  await waitFor('atlas closed via Esc', atlasClosed, 15_000);
  const stateAfterEsc = await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.state);
  expect(stateAfterEsc, 'closing the atlas with Esc does not pause').toBe('playing');

  // ---- 5. atlas jumps reproduce the walked arrivals exactly ----
  await jumpViaAtlas(0, 1, s.transitions);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 1 });
  expect(s.seed).toBe(walked01.seed);
  expect(s.tier).toBe(walked01.tier);
  expect(s.landmarkDigest).toBe(walked01.landmarkDigest);
  expect(s.landmarkPlaced).toBe(walked01.landmarkPlaced);
  expect(s.landmarkDraws).toBe(walked01.landmarkDraws);
  expect(s.landmarkColliders).toBe(walked01.landmarkColliders);
  expect(Math.abs(s.pos.z - (-(HALF - INSET)))).toBeLessThan(80);
  expect(Math.abs(s.pos.x)).toBeLessThan(80);

  await jumpViaAtlas(1, 0, s.transitions);
  s = await snap();
  expect(s.coord).toEqual({ mx: 1, my: 0 });
  expect(s.seed).toBe(walked10.seed);
  expect(s.tier).toBe(walked10.tier);
  expect(s.landmarkDigest).toBe(walked10.landmarkDigest);
  expect(s.landmarkPlaced).toBe(walked10.landmarkPlaced);
  expect(s.landmarkDraws).toBe(walked10.landmarkDraws);
  expect(s.landmarkColliders).toBe(walked10.landmarkColliders);

  // ---- 6. reload preserves rows, tiers, and camp flags ----
  await page.goto(url);
  await waitFor('reboot', booted, 240_000);
  s = await snap();
  expect(s.coord).toEqual({ mx: 0, my: 0 });
  expect(s.registry.map((p) => [p.mx, p.my])).toEqual([[0, 0], [0, 1], [1, 0]]);
  await openAtlas();
  rows = await atlasRows();
  expect(rows.map((r) => [r.mx, r.my])).toEqual([[0, 0], [0, 1], [1, 0]]);
  for (const r of rows) {
    const reg = s.registry.find((p) => p.mx === r.mx && p.my === r.my)!;
    expect(r.tier).toBe(reg.tier);
    expect(r.biome).toBe(reg.biome);
  }
  expect(rows[0].camp, 'origin camp flag survives reload via the profile').toBe(1);
  const fogAfterReload = await liveFog();
  for (const r of rows) {
    expect(r.fog).toBe(fogAfterReload[`${r.mx},${r.my}`]);
  }
  await page.locator('#xandria-world-atlas-panel button').first().click();
  await waitFor('atlas closed after reload', atlasClosed, 15_000);

  // ---- 7. mobile leg: chip, overlap, touch targets, jump ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  const chipBox = await page.evaluate(() => {
    const el = document.getElementById('xandria-world-atlas-chip') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  expect(chipBox.w).toBeGreaterThanOrEqual(28);
  expect(chipBox.h).toBeGreaterThanOrEqual(28);
  expect(chipBox.x).toBeGreaterThanOrEqual(0);
  expect(chipBox.x + chipBox.w).toBeLessThanOrEqual(360);
  const overlap = await page.evaluate(() => {
    const chip = document.getElementById('xandria-world-atlas-chip') as HTMLElement;
    const c = chip.getBoundingClientRect();
    const hits: string[] = [];
    for (const sel of ['#xandria-quest-tracker', '.xhud .score', '.xhud .objective', '.xhud .bars',
      '#xandria-fast-travel-chip', '#xandria-fast-travel-panel']) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el || el.getBoundingClientRect().width === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      const intersects = c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top;
      if (intersects) hits.push(sel);
    }
    return hits;
  });
  expect(overlap, 'ATLAS chip must not overlap HUD boxes or the MAP chip/panel on mobile').toEqual([]);
  await openAtlas();
  const btnSizes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#xandria-world-atlas-panel button')];
    return btns.map((b) => {
      const r = (b as HTMLElement).getBoundingClientRect();
      return { text: (b.textContent ?? '').trim(), w: r.width, h: r.height };
    });
  });
  for (const b of btnSizes) {
    if (b.text === 'JUMP') {
      expect(b.h, 'JUMP button >= 28px tall').toBeGreaterThanOrEqual(28);
      expect(b.w, 'JUMP button >= 28px wide').toBeGreaterThanOrEqual(28);
    }
  }
  const tBefore = (await snap()).transitions;
  await page.locator('#xandria-world-atlas-panel [data-mx="0"][data-my="1"] button').click();
  await waitFor('mobile atlas jump to (0,1)', async () => {
    const cur = await snap();
    return cur.coord.mx === 0 && cur.coord.my === 1 && cur.transitions >= tBefore + 1;
  }, 300_000);
  s = await snap();
  expect(s.landmarkDigest).toBe(walked01.landmarkDigest);
  expect(s.tier).toBe(walked01.tier);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(1000);

  // ---- 8. title screen: the atlas stays usable from the title ----
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.toTitle());
  await waitFor('title state', async () => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.state === 'title'), 60_000);
  await openAtlas();
  rows = await atlasRows();
  expect(rows.map((r) => [r.mx, r.my])).toEqual([[0, 0], [0, 1], [1, 0]]);
  expect(rows[0].camp, 'camp flag visible from the title screen').toBe(1);
  await page.locator('#xandria-world-atlas-panel button').first().click();
  await waitFor('atlas closed on title', atlasClosed, 15_000);

  expect(errors, 'zero console/page errors').toEqual([]);
});
