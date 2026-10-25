/**
 * COMBAT-ABILITIES (upgrade loop) — live player page e2e.
 *
 * Desktop: boot the deterministic "Forgotten Valley" tp-action scene
 * (seed 20261012, 6 walkers) -> draw-call baseline -> dash-strike via
 * the REAL Z hotkey (cast -> exact damage asserted against the manager's
 * recorded damageDealt, cooldown enforced, dash movement asserted) ->
 * shockwave via C (exact total damage + target count) -> mend via V
 * (exact 45 heal over 3s, far from enemies) -> cooldown re-cast refused
 * -> energy-gated cast refused -> ability bar renders -> draw-call
 * re-sample (pooled VFX only: expect no draw regression).
 *
 * Mobile (360x780, hasTouch): touch overlay active, STRIKE/WAVE/MEND
 * buttons >= 28px, inside the viewport, pairwise non-overlapping with
 * every other touch button, and a real tap on STRIKE casts.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to the enemy (never the reverse), and all waits poll from
 * Node. Enemies chase the player, so a frontal placement stays frontal.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint
// builds the item kit (parity with the skills spec). Walker HP is raised
// 30 -> 1000 so ability hits never kill the target mid-assertion (a dead
// enemy's corpse sweep would shift the roster under the exact-damage
// check); no kills means objectives/XP never advance during the test.
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  spec.enemies = (spec.enemies ?? []).map((e: any) => ({ ...e, health: 1000 }));
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

type X = any;

async function waitFor(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(intervalMs);
  }
}

async function boot(page: any, errors: string[]) {
  page.on('pageerror', (e: any) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  await waitFor(page, 'boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X?.abilitiesTest?.liveManager() && X.engine.state === 'playing'
      && X.engine.portalsPlayerAvatar);
  }), 240_000);
  // NPCs are not under test; despawn so no villager prompt interferes.
  // Enemies stay: abilities need live targets.
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs') s.despawnAll();
  });
}

async function snapshot(page: any) {
  return page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const m = X.abilitiesTest.liveManager();
    const av = X.engine.portalsPlayerAvatar;
    return {
      energy: m.energy,
      cooldowns: {
        'dash-strike': m.cooldownRemaining('dash-strike'),
        'shockwave-slam': m.cooldownRemaining('shockwave-slam'),
        mend: m.cooldownRemaining('mend'),
      },
      lastCast: m.lastCast ? { id: m.lastCast.id, damageDealt: m.lastCast.damageDealt, targets: m.lastCast.targets } : null,
      hotHealed: m.hotHealed,
      avatarPos: { x: av.ctrl.position.x, y: av.ctrl.position.y, z: av.ctrl.position.z },
      avatarHealth: av.health,
      enemies: X.abilitiesTest.liveEnemies().enemies.map((e: any) => ({
        alive: e.alive, health: e.health,
        x: e.position.x, y: e.position.y, z: e.position.z,
      })),
    };
  });
}

/** Teleport the avatar 2.5m in front of the first living enemy, facing it. */
async function placeBeforeEnemy(page: any) {
  return page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    const target = X.abilitiesTest.liveEnemies().enemies.find((e: any) => e.alive);
    if (!target) throw new Error('no living enemy to place before');
    const p = target.position;
    av.ctrl.teleport({ x: p.x, y: p.y, z: p.z - 2.5 });
    // forward = (sin(yaw+PI), cos(yaw+PI)) must equal +z -> yaw = PI
    av.ctrl.yaw = Math.PI;
    return { enemyHealth: target.health, avatarPos: { x: p.x, y: p.y, z: p.z - 2.5 } };
  });
}

async function sampleDrawCalls(page: any): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 8; i++) {
    samples.push(await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.engine.renderer.info.render.calls as number;
    }));
    await page.waitForTimeout(100);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

test('combat-abilities: hotkeys, exact damage/heal, gates, bar, perf (desktop)', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  await boot(page, errors);

  const drawsBefore = await sampleDrawCalls(page);
  console.log('[combat-abilities] draw calls before: ' + drawsBefore);

  // ---- dash-strike via the real Z hotkey ----
  const placed = await placeBeforeEnemy(page);
  const beforeDash = await snapshot(page);
  await page.keyboard.press('z');
  await waitFor(page, 'dash-strike cast', async () => {
    const s = await snapshot(page);
    return s.lastCast?.id === 'dash-strike';
  }, 60_000);
  const afterDash = await snapshot(page);
  expect(afterDash.lastCast!.damageDealt).toBeGreaterThan(0);
  // exact damage: total health lost across the roster equals the recorded
  // amount (other chasers may wander into the arc — sum, don't single out)
  let dashDrop = 0;
  let dashHits = 0;
  for (let i = 0; i < beforeDash.enemies.length; i++) {
    const drop = beforeDash.enemies[i].health - afterDash.enemies[i].health;
    if (drop > 0) {
      dashDrop += drop;
      dashHits++;
    }
  }
  expect(dashHits).toBe(afterDash.lastCast!.targets);
  expect(dashDrop).toBe(afterDash.lastCast!.damageDealt);
  // the placed target itself was hit
  expect(placed.enemyHealth - afterDash.enemies[0].health).toBeGreaterThan(0);
  expect(afterDash.lastCast!.targets).toBeGreaterThanOrEqual(1);
  expect(afterDash.cooldowns['dash-strike']).toBeGreaterThan(0);
  expect(afterDash.cooldowns['dash-strike']).toBeLessThanOrEqual(6);
  expect(afterDash.energy).toBeLessThan(beforeDash.energy);
  // dash movement: avatar moved forward (+z) by at least 2m
  expect(afterDash.avatarPos.z - beforeDash.avatarPos.z).toBeGreaterThan(2);

  // ---- shockwave via the real C hotkey ----
  const beforeWave = await snapshot(page);
  await page.keyboard.press('c');
  await waitFor(page, 'shockwave cast', async () => {
    const s = await snapshot(page);
    return s.lastCast?.id === 'shockwave-slam';
  }, 60_000);
  const afterWave = await snapshot(page);
  expect(afterWave.lastCast!.targets).toBeGreaterThanOrEqual(1);
  let totalDrop = 0;
  let hitCount = 0;
  for (let i = 0; i < beforeWave.enemies.length; i++) {
    const drop = beforeWave.enemies[i].health - afterWave.enemies[i].health;
    if (drop > 0) {
      totalDrop += drop;
      hitCount++;
    }
  }
  expect(hitCount).toBe(afterWave.lastCast!.targets);
  expect(totalDrop).toBe(afterWave.lastCast!.damageDealt);
  expect(afterWave.cooldowns['shockwave-slam']).toBeGreaterThan(0);

  // NOTE on perf (see the same-spot leg after the energy gate): a
  // before/after pair across the dash+shockwave legs is NOT a valid
  // INSTANCING.md comparison — teleporting the camera changes terrain
  // chunk visibility, which moved the count by -271 on its own. The
  // valid comparison is same-spot, VFX-active vs settled, below.

  // ---- mend via the real V hotkey ----
  // Despawn enemies first: with no damage sources the HoT assertion is
  // exact. (Teleporting far away was tried first — it starved chunk
  // streaming and froze frames so the game-time HoT never completed.)
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'enemies') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = 50;
  });
  await page.keyboard.press('v');
  await waitFor(page, 'mend cast', async () => {
    const s = await snapshot(page);
    return s.lastCast?.id === 'mend';
  }, 60_000);
  // HoT is 3 GAME seconds; test-mode dt is a fixed 1/60 per frame and
  // SwiftShader frames are slow, so poll for completion instead of
  // waiting wall-clock seconds (4 wall seconds was only ~0.3 game seconds).
  await waitFor(page, 'mend HoT completes', async () => {
    const s = await snapshot(page);
    return s.hotHealed >= 45;
  }, 240_000, 2000);
  const afterMend = await snapshot(page);
  // close-to, not exact: per-frame 15*(1/60) ticks drift ~1e-13 in float
  expect(afterMend.avatarHealth).toBeCloseTo(95, 6);
  expect(afterMend.hotHealed).toBeCloseTo(45, 6);

  // ---- cooldown re-cast refused ----
  const cdBefore = (await snapshot(page)).cooldowns.mend;
  expect(cdBefore).toBeGreaterThan(0);
  await page.keyboard.press('v');
  // Poll for the cooldown to tick down: SwiftShader frames are slow, so
  // one wall second may contain zero game frames. The re-cast must NOT
  // have reset it (it stays well under the 12s cooldown, ticking down).
  let cdAfter = await snapshot(page);
  await waitFor(page, 'mend cooldown ticks down after refused re-cast', async () => {
    cdAfter = await snapshot(page);
    return cdAfter.cooldowns.mend < cdBefore;
  }, 120_000, 2000);
  expect(cdAfter.lastCast!.id).toBe('mend');
  expect(cdAfter.cooldowns.mend).toBeGreaterThan(0);

  // ---- energy-gated cast refused ----
  // First wait out the dash cooldown in GAME time (only ~5 game seconds
  // have elapsed since the dash cast — the wall-clock legs above are
  // shorter in game time than they look under SwiftShader). Otherwise a
  // refused 'z' here would prove the cooldown gate, not the energy gate.
  await waitFor(page, 'dash cooldown expires before energy gate', async () => {
    const s = await snapshot(page);
    return s.cooldowns['dash-strike'] === 0;
  }, 180_000, 2000);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.abilitiesTest.liveManager().energy = 10;
  });
  await page.keyboard.press('z');
  await page.waitForTimeout(1000);
  const gated = await snapshot(page);
  expect(gated.lastCast!.id).toBe('mend');
  expect(gated.cooldowns['dash-strike']).toBe(0);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.abilitiesTest.liveManager().energy = 100;
  });

  // ---- perf: same-spot, VFX-active vs settled (INSTANCING.md method) ----
  // At this point dash is off cooldown and energy is full, so a real 'z'
  // cast is available with no other scene change: same camera spot, the
  // only difference is the cast's pooled burst (14 particles, 0.5s life)
  // being alive. Under SwiftShader frames the burst stays alive for
  // several wall seconds, so the active sample below genuinely catches
  // it. Expectation: active - settled <= 5 (pools pre-exist in the scene).
  const drawsSettled = await sampleDrawCalls(page);
  await page.keyboard.press('z');
  await waitFor(page, 'perf dash cast', async () => {
    const s = await snapshot(page);
    return s.lastCast?.id === 'dash-strike';
  }, 60_000);
  const drawsActive = await sampleDrawCalls(page);
  console.log('[combat-abilities] draw calls boot-baseline: ' + drawsBefore + ', settled: ' + drawsSettled + ', VFX-active: ' + drawsActive + ' (active-settled delta ' + (drawsActive - drawsSettled) + ')');
  expect(drawsActive - drawsSettled).toBeLessThanOrEqual(5);

  // ---- ability bar renders with all three chips ----
  const barText = await page.evaluate(() =>
    document.getElementById('xandria-ability-bar')?.textContent ?? '');
  expect(barText).toContain('Dash Strike');
  expect(barText).toContain('Shockwave Slam');
  expect(barText).toContain('Mend');

  expect(errors, 'zero console/page errors').toEqual([]);
});

test.describe('combat-abilities mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('combat-abilities: touch buttons + tap-to-cast (360x780, touch)', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    await boot(page, errors);

    const touchActive = await page.evaluate(() => !!(window as unknown as X).__XANDRIA__?.engine?.touch?.active);
    console.log('[combat-abilities] touch overlay active: ' + touchActive);
    expect(touchActive, 'touch controls active on the touch context').toBe(true);

    // button audit: ability buttons present, >= 28px, in viewport, no overlaps
    const audit = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.xtouch .tbtn')).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { text: (el as HTMLElement).textContent ?? '', x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const overlaps: Array<[string, string]> = [];
      for (let i = 0; i < btns.length; i++) {
        for (let j = i + 1; j < btns.length; j++) {
          const a = btns[i];
          const b = btns[j];
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
            overlaps.push([a.text, b.text]);
          }
        }
      }
      const bar = document.getElementById('xandria-ability-bar')?.getBoundingClientRect() ?? null;
      return { btns, overlaps, bar: bar ? { right: bar.right, left: bar.left } : null };
    });
    console.log('[combat-abilities] touch buttons: ' + JSON.stringify(audit.btns));
    for (const label of ['STRIKE', 'WAVE', 'MEND']) {
      const b = audit.btns.find((x) => x.text === label);
      expect(b, `ability button ${label} exists`).toBeTruthy();
      expect(b!.w, `${label} width >= 28px`).toBeGreaterThanOrEqual(28);
      expect(b!.h, `${label} height >= 28px`).toBeGreaterThanOrEqual(28);
      expect(b!.x + b!.w, `${label} fits in 360px viewport`).toBeLessThanOrEqual(360);
    }
    expect(audit.overlaps, 'no touch-button collisions').toEqual([]);
    expect(audit.bar, 'ability bar renders on mobile').toBeTruthy();
    expect(audit.bar!.right, 'ability bar fits in 360px viewport').toBeLessThanOrEqual(360);
    expect(audit.bar!.left, 'ability bar fits in 360px viewport').toBeGreaterThanOrEqual(0);

    // real tap on STRIKE casts dash-strike
    const placed = await placeBeforeEnemy(page);
    await page.locator('.xtouch .tbtn', { hasText: 'STRIKE' }).click({ force: true, timeout: 15000 });
    await waitFor(page, 'tap dash-strike cast', async () => {
      const s = await snapshot(page);
      return s.lastCast?.id === 'dash-strike';
    }, 60_000);
    const after = await snapshot(page);
    expect(after.lastCast!.damageDealt).toBeGreaterThan(0);
    expect(placed.enemyHealth - after.enemies[0].health).toBeGreaterThan(0);

    expect(errors, 'zero console/page errors').toEqual([]);
  });
});
