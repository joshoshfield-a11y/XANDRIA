/**
 * Deployables wave — craft -> deploy -> aura effects in the live player
 * page (desktop AND 360x780, zero console/page errors).
 *
 * Flow: boot the deterministic "Forgotten Valley" scene (seed 20261012,
 * tp-action — the INSTANCING.md perf scene) with an empty custom.items
 * table injected (ensureCraftingItemDefs fills it at boot since crafting
 * defaults on) -> despawn NPCs (keep enemies: the trap + totem need live
 * targets) and make the player invincible -> grant tier-1 materials ->
 * craft all three deployable kits via the shipped craft() path -> tap the
 * real `deploy` action (G/Digit3 binding) three times:
 *   1. campfire: inventory decremented, heal ticks asserted EXACTLY
 *      (seeded magnitudes recomputed with the shipped roll function)
 *   2. spike trap: pinned enemy takes EXACT seeded damage ticks
 *   3. lure totem: enemy gets a lureTarget and walks toward the totem
 * -> cooldown/cap refusal asserted -> mobile leg at 360x780: the DEPLOY
 * touch button exists and a real touchscreen tap deploys.
 * A second test measures the instanced draw-call delta of 3 live
 * deployables (desktop + s25) by the INSTANCING.md method.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to the enemy (never the reverse), all waits poll from Node,
 * enemy pinning re-applies every poll slice under SwiftShader's slow
 * frames.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint
// builds the item kit (ensureCraftingItemDefs fills the crafting +
// deployable defs at boot; crafting is enabled by default).
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

const URL = `/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`;

const waitFor = async (
  page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number,
) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(200);
  }
};

const bootWait = (page: any) => waitFor(page, 'boot', () => page.evaluate(() => {
  const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
  return !!(X?.engine && X?.deployTest && X?.craftingTest && X?.blueprint?.deployables
    && X?.blueprint?.itemKit && X.engine.state === 'playing'
    && X.engine.portalsPlayerAvatar);
}), 240_000);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

test('deployables: craft -> deploy -> heal/damage/lure, desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(URL);
  await bootWait(page);

  // Keep enemies live (trap + totem need real targets); despawn NPCs for a
  // quiet field and make the player invincible so stray hits can't move the
  // health assertions.
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const invCount = (id: string): Promise<number> => page.evaluate((id) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.itemKit.inventory.count(id), id);
  const liveCount = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager().deployables.length);

  // ---- craft all three kits via the shipped craft() path ----
  const crafted = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    inv.add('mat_ore', 99); inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
    const pool = X.craftingTest.buildRecipePool(X.spec);
    const defs = X.spec.custom.items.defs;
    const out: Record<string, boolean> = {};
    for (const rid of ['recipe_deploy_campfire', 'recipe_deploy_spike_trap', 'recipe_deploy_lure_totem']) {
      const r = X.craftingTest.craft(pool, rid, { inventory: inv, defs, stations: new Set() });
      out[rid] = r.ok;
    }
    return out;
  });
  expect(crafted, 'all three deployable kits craft').toEqual({
    recipe_deploy_campfire: true, recipe_deploy_spike_trap: true, recipe_deploy_lure_totem: true,
  });
  expect(await invCount('deploy_campfire')).toBe(1);
  expect(await invCount('deploy_spike_trap')).toBe(1);
  expect(await invCount('deploy_lure_totem')).toBe(1);

  const deployKinds = (): Promise<Array<string | null>> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager()
      .deployables.map((d: any) => d.def.id));

  // ---- 1. campfire: deploy via the real input action, heal ticks exact ----
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.tap('deploy'));
  await waitFor(page, 'campfire deployed', async () => (await liveCount()) === 1, 30_000);
  expect(await deployKinds()).toEqual(['campfire']);
  expect(await invCount('deploy_campfire')).toBe(0);

  const healCheck = await page.evaluate(async () => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const avatar = X.engine.portalsPlayerAvatar;
    avatar.damage(500); // iframes are 0.8s; the first tick lands at t=1s
    const h0 = avatar.health;
    const mgr = X.deployTest.liveManager();
    const d = mgr.deployables[0];
    return { h0, seed: d.seed, defId: d.def.id };
  });
  // 3 heal ticks at 1s intervals
  await waitFor(page, '3 campfire ticks', () => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager()
      .deployables[0].tickIndex >= 3), 180_000);
  const healResult = await page.evaluate(({ seed, h0 }) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const mgr = X.deployTest.liveManager();
    const d = mgr.deployables[0];
    const def = X.deployTest.DEPLOYABLE_DEFS.find((x: any) => x.id === 'campfire');
    const expected = [0, 1, 2].map((ti) => X.deployTest.rollDeployTickMagnitude(def, seed, ti));
    return {
      health: X.engine.portalsPlayerAvatar.health,
      totalApplied: d.totalApplied,
      expectedTotal: expected.reduce((a: number, b: number) => a + b, 0),
      h0,
    };
  }, healCheck);
  expect(healResult.totalApplied, 'campfire totalApplied is the exact seeded sum')
    .toBe(healResult.expectedTotal);
  expect(healResult.health, 'player healed by exactly the seeded ticks')
    .toBe(healResult.h0 + healResult.expectedTotal);

  // ---- 2. spike trap: deploy via input, pinned enemy takes exact ticks ----
  // teleport the player next to the healthiest live enemy, then deploy
  const trapSetup = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const enemies = X.blueprint.enemies.enemies.filter((e: any) => e.alive);
    enemies.sort((a: any, b: any) => b.health - a.health);
    const e = enemies[0];
    const avatar = X.engine.portalsPlayerAvatar;
    avatar.ctrl.teleport(e.position.clone().add(new (X.engine.portalsPlayerAvatar.ctrl.position.constructor as any)(2, 0, 0)));
    return { enemyHealth: e.health, enemyIndex: X.blueprint.enemies.enemies.indexOf(e) };
  });
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.tap('deploy'));
  await waitFor(page, 'trap deployed', async () => (await liveCount()) === 2, 30_000);
  expect(await deployKinds()).toEqual(['campfire', 'spike_trap']);
  expect(await invCount('deploy_spike_trap')).toBe(0);

  // pin the enemy onto the trap every poll slice until 2 damage ticks land
  await waitFor(page, '2 trap ticks', () => page.evaluate(({ enemyIndex }) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const mgr = X.deployTest.liveManager();
    const trap = mgr.deployables[mgr.deployables.length - 1];
    const e = X.blueprint.enemies.enemies[enemyIndex];
    if (e?.alive && e.body) {
      e.body.position.set(trap.root.position.x, trap.root.position.y + 1, trap.root.position.z);
      e.body.velocity.set(0, 0, 0);
    }
    return trap.tickIndex >= 2;
  }, trapSetup), 180_000);
  const trapResult = await page.evaluate(({ enemyIndex, enemyHealth }) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const mgr = X.deployTest.liveManager();
    const trap = mgr.deployables[mgr.deployables.length - 1];
    const def = X.deployTest.DEPLOYABLE_DEFS.find((x: any) => x.id === 'spike_trap');
    const expected = [0, 1].map((ti) => X.deployTest.rollDeployTickMagnitude(def, trap.seed, ti));
    const e = X.blueprint.enemies.enemies[enemyIndex];
    return {
      enemyHealthNow: e.health,
      totalApplied: trap.totalApplied,
      expectedTotal: expected.reduce((a: number, b: number) => a + b, 0),
      enemyHealth,
    };
  }, trapSetup);
  expect(trapResult.totalApplied, 'trap totalApplied is the exact seeded sum')
    .toBe(trapResult.expectedTotal);
  expect(trapResult.enemyHealthNow, 'enemy took exactly the seeded damage ticks')
    .toBe(trapResult.enemyHealth - trapResult.expectedTotal);

  // ---- 3. lure totem: deploy via input, enemy gets lured and approaches ----
  // pick the live enemy FARTHEST from the spike trap (its ticks are still
  // live) so the lured walk to the totem never crosses the trap radius;
  // track it by object identity (window handle), never by array index —
  // the trap may kill other enemies mid-test and shift the array.
  const lureSetup = await page.evaluate(({ trapVictimIndex }) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const mgr = X.deployTest.liveManager();
    const trap = mgr.deployables.find((d: any) => d.def.id === 'spike_trap');
    const trapPos = trap.root.position;
    const enemies = X.blueprint.enemies.enemies.filter((e: any) => e.alive);
    const cands = enemies.filter((x: any) => X.blueprint.enemies.enemies.indexOf(x) !== trapVictimIndex);
    cands.sort((a: any, b: any) =>
      b.position.distanceTo(trapPos) - a.position.distanceTo(trapPos));
    const e = cands[0];
    const avatar = X.engine.portalsPlayerAvatar;
    avatar.ctrl.teleport(e.position.clone().add(new (avatar.ctrl.position.constructor as any)(8, 0, 0)));
    (window as any).__lureEnemy = e;
    return {
      trapDist: e.position.distanceTo(trapPos),
      enemyHealth: e.health,
    };
  }, { trapVictimIndex: trapSetup.enemyIndex });
  // sanity: the walk corridor (enemy -> player -> totem) stays clear of the trap
  expect(lureSetup.trapDist, 'lure enemy starts well clear of the trap').toBeGreaterThan(18);
  await page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.tap('deploy'));
  await waitFor(page, 'totem deployed', async () => (await liveCount()) === 3, 30_000);
  expect(await deployKinds()).toEqual(['campfire', 'spike_trap', 'lure_totem']);
  expect(await invCount('deploy_lure_totem')).toBe(0);

  await waitFor(page, 'enemy lured', () => page.evaluate(() => {
    const e = (window as unknown as { __lureEnemy?: any }).__lureEnemy;
    return !!(e?.alive && e.lureTarget);
  }), 30_000);
  // the lure contract, asserted on game state (not wall time — SwiftShader
  // runs the scene at ~0.05x real time): the enemy is in chase and its
  // velocity points at the totem
  const lureContract = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const e = (window as unknown as { __lureEnemy?: any }).__lureEnemy;
    const totem = X.deployTest.liveManager().deployables.find((d: any) => d.def.id === 'lure_totem');
    const toTotem = totem.root.position.clone().sub(e.position).setY(0).normalize();
    const vel = new (toTotem.constructor as any)(e.body.velocity.x, 0, e.body.velocity.z);
    const dot = vel.length() > 0.01 ? toTotem.dot(vel.clone().normalize()) : -2;
    return { state: e.state, dot, speed: vel.length() };
  });
  expect(lureContract.state, 'lured enemy is chasing').toBe('chase');
  expect(lureContract.dot, `lured enemy velocity points at the totem (dot=${lureContract.dot.toFixed(2)})`)
    .toBeGreaterThan(0.3);
  // ...and over 1.5s of GAME time it actually closes the distance
  const d0 = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const e = (window as unknown as { __lureEnemy?: any }).__lureEnemy;
    const totem = X.deployTest.liveManager().deployables.find((d: any) => d.def.id === 'lure_totem');
    return { dist: e.position.distanceTo(totem.root.position), t: X.engine.time };
  });
  await waitFor(page, '1.5s of game time elapse', () => page.evaluate((t0) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.time - t0 >= 1.5, d0.t), 240_000);
  const d1 = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const e = (window as unknown as { __lureEnemy?: any }).__lureEnemy;
    const totem = X.deployTest.liveManager().deployables.find((d: any) => d.def.id === 'lure_totem');
    return { dist: e.position.distanceTo(totem.root.position), lured: !!e.lureTarget, alive: e.alive };
  });
  expect(d1.alive, 'lure enemy survived the walk').toBe(true);
  expect(d1.lured, 'lure target still assigned').toBe(true);
  expect(d1.dist, `enemy walked toward the totem (${d0.dist.toFixed(1)}m -> ${d1.dist.toFixed(1)}m)`)
    .toBeLessThan(d0.dist - 0.5);

  // ---- cooldown refusal: all kinds on cooldown / out of stock ----
  const cooldownRefusal = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    inv.add('mat_ore', 99); inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
    const pool = X.craftingTest.buildRecipePool(X.spec);
    const defs = X.spec.custom.items.defs;
    X.craftingTest.craft(pool, 'recipe_deploy_campfire', { inventory: inv, defs, stations: new Set() });
    const before = X.deployTest.liveManager().deployables.length;
    const r = X.deployTest.liveManager().tryDeploy(); // campfire is on its 25s cooldown
    const after = X.deployTest.liveManager().deployables.length;
    return { ok: r.ok, reason: r.reason, before, after };
  });
  expect(cooldownRefusal.ok, 'cooldown deploy refused').toBe(false);
  expect(cooldownRefusal.reason).toMatch(/recharging/);
  expect(cooldownRefusal.after).toBe(cooldownRefusal.before);

  expect(errors).toEqual([]);
});

test.describe('deployables mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  test('DEPLOY touch button exists at 360x780 and a real touchscreen tap deploys', async ({ page }) => {
    test.setTimeout(900_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

    await page.goto(URL);
    await bootWait(page);
    const deployBtn = page.locator('.tbtn', { hasText: 'DEPLOY' });
    await expect(deployBtn, 'DEPLOY touch button exists').toBeVisible({ timeout: 30_000 });
    // stock a campfire kit via the shipped craft path and tap the real button
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const inv = X.blueprint.itemKit.inventory;
      inv.add('mat_ore', 99); inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
      const pool = X.craftingTest.buildRecipePool(X.spec);
      X.craftingTest.craft(pool, 'recipe_deploy_campfire',
        { inventory: inv, defs: X.spec.custom.items.defs, stations: new Set() });
    });
    const box = await deployBtn.boundingBox();
    expect(box, 'DEPLOY button has a box').toBeTruthy();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await waitFor(page, 'mobile tap deployed', () => page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager()
        .deployables.length === 1), 60_000);
    const kinds = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager()
        .deployables.map((d: any) => d.def.id));
    expect(kinds).toEqual(['campfire']);
    expect(errors).toEqual([]);
  });
});

test('deployables perf: instanced draw-call delta, desktop + s25', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const sample = async (): Promise<{ calls: number; buckets: number; registered: number }> =>
    page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const inst = (X.blueprint.enemies as unknown as { instancer?: { bucketCount: number; registeredNpcCount: number } }).instancer;
      return {
        calls: X.engine.renderer.info.render.calls,
        buckets: inst?.bucketCount ?? -1,
        registered: inst?.registeredNpcCount ?? -1,
      };
    });
  const sampleDraws = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push((await sample()).calls);
      await page.waitForTimeout(1500);
    }
    return out;
  };

  // A/B/A: base -> 3 deployables live -> despawned. The scene is quieted
  // (NPCs + enemies despawned) so the delta is attributable to the
  // deployables alone — the earlier live-scene attempt drifted +55 calls
  // from wandering entities, not from the deployables (buckets returned to
  // baseline after despawnAll while calls stayed high).
  const results: Record<string, { base: number; with: number; after: number; delta: number; newBuckets: number }> = {};
  for (const tier of ['desktop', 's25']) {
    await page.goto(`${URL}&tier=${tier}`);
    await bootWait(page);
    const resolved = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.tiers.tier);
    expect(resolved).toBe(tier);
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
      for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    });
    await page.waitForTimeout(20_000); // settle under SwiftShader
    const baseBuckets = (await sample()).buckets;
    const base = median(await sampleDraws(10));
    // one of each kind, deployed at the player's feet (all in view)
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const inv = X.blueprint.itemKit.inventory;
      inv.add('mat_ore', 99); inv.add('mat_fiber', 99); inv.add('mat_scrap', 99);
      const pool = X.craftingTest.buildRecipePool(X.spec);
      const defs = X.spec.custom.items.defs;
      for (const rid of ['recipe_deploy_campfire', 'recipe_deploy_spike_trap', 'recipe_deploy_lure_totem']) {
        X.craftingTest.craft(pool, rid, { inventory: inv, defs, stations: new Set() });
      }
      const mgr = X.deployTest.liveManager();
      mgr.tryDeploy(); mgr.tryDeploy(); mgr.tryDeploy();
    });
    const n = await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager().deployables.length);
    expect(n).toBe(3);
    const withS = await sample();
    const withD = median(await sampleDraws(10));
    await page.evaluate(() =>
      (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.deployTest.liveManager().despawnAll());
    const afterBuckets = (await sample()).buckets;
    const after = median(await sampleDraws(10));
    results[tier] = {
      base, with: withD, after,
      delta: withD - base, newBuckets: withS.buckets - baseBuckets,
    };
    // drift guard: after despawn the scene must return to baseline
    expect(Math.abs(after - base), `${tier}: no unexplained drift (base=${base} after=${after})`)
      .toBeLessThanOrEqual(10);
    expect(afterBuckets, `${tier}: buckets return to baseline`).toBe(baseBuckets);
  }
  // eslint-disable-next-line no-console
  console.log('deployables perf (median render.calls, 10 samples):', JSON.stringify(results));
  for (const [tier, r] of Object.entries(results)) {
    expect(r.delta, `${tier}: deployables actually render`).toBeGreaterThan(0);
    // 16 new instanced buckets (3 amber aura slabs + 13 prop-part buckets);
    // each draws in main + shadow pass on desktop
    expect(r.newBuckets, `${tier}: new instanced buckets disclosed`).toBe(16);
    expect(r.delta, `${tier}: no draw-call blowup`).toBeLessThan(45);
  }
  expect(errors).toEqual([]);
});
