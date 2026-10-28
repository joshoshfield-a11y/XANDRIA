/**
 * Wandering world-boss wave — roaming boss event end to end, desktop + 360x780.
 *
 * - Generator flag: spec.custom.worldBoss (explicit opt-in) marks the map;
 *   the plan the event spawns from matches planWorldBoss(seed) exactly
 *   (boss def, spawn position ringed 55-95m, waypoint loop, lifetime).
 * - The boss is a real isBoss brute in the enemy roster: it binds the
 *   open-field encounter (no arena, no tether), the boss bar appears with
 *   the def name, and a beacon marker follows it.
 * - Patrol: with the player far away, the boss's home is steered onto the
 *   seeded waypoint loop (no EnemyAI internals touched).
 * - Telegraphs: parking the player 5m from the boss (outside melee range,
 *   inside the nova radius, chase frozen) produces telegraphed attacks —
 *   the only damage the player can take at that range.
 * - Death: the real die() path rolls the items-expansion boss loot path —
 *   rollLoot(rng, 'brute', true) replicated exactly — legendary-grade gear
 *   lands, the bar hides, the event completes, the beacon leaves.
 * - Timer: a short-lifetime map despawns the boss with no kill, no loot,
 *   and no orphan state (no roster brute, no beacon, bar hidden, event
 *   stays done and never respawns).
 * - Arena rules do NOT apply: no arena visuals exist on a world-boss map.
 * - Zero console/page errors throughout.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

/** "Forgotten Valley" tp-action spec retargeted at a wandering world boss. */
function worldBossSpecB64(lifetimeSeconds: number): string {
  const s = JSON.parse(Buffer.from(B64, 'base64').toString('utf8'));
  s.objective = { type: 'eliminate', count: 2, timeLimit: 0, description: 'Clear the valley' };
  s.enemies = [{ kind: 'walker', count: 2, health: 30, speed: 3.2, damage: 10, weapon: 'melee' }];
  s.custom = {
    ...(s.custom ?? {}),
    worldBoss: { enabled: true, bossId: 'ember-titan', lifetimeSeconds },
    items: { defs: {} }, // activate the item kit so the boss drop has a world
  };
  return Buffer.from(JSON.stringify(s)).toString('base64');
}

async function waitFor(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(1000);
  }
}

async function boot(page: any, lifetimeSeconds: number): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e: any) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(worldBossSpecB64(lifetimeSeconds))}&test=1&autostart=1&splash=0`);
  await waitFor(page, 'boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.worldBossTest && X.lootTest);
  }), 240_000);
  return errors;
}

test('world-boss: plan -> patrol -> telegraphs -> legendary death, desktop + mobile', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await boot(page, 600);

  // ---- leg 1: plan replication + one boss, no arena ----
  const plan = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const W = X.worldBossTest;
    const seed = X.spec.meta.seed as number;
    const planned = W.planWorldBoss(seed, X.spec);
    const live = W.liveWorldBoss();
    const boss = live?.liveBoss;
    const arenaEnc = X.bossTest.liveEncounter();
    return {
      seed,
      enabled: W.resolveWorldBossEnabled(X.spec),
      planned,
      livePlan: live?.livePlan ?? null,
      status: live?.liveStatus ?? null,
      boss: boss ? {
        isBoss: !!boss.isBoss,
        x: boss.position.x as number,
        z: boss.position.z as number,
        maxHealth: boss.maxHealth as number,
        inRoster: (X.blueprint.enemies.enemies as unknown[]).includes(boss),
      } : null,
      rosterBosses: (X.blueprint.enemies.enemies as any[]).filter((e: any) => e.isBoss).length,
      beacon: !!live?.liveBeacon,
      arenaActive: !!arenaEnc?.isActive,
      arena: arenaEnc?.liveArena ?? null,
    };
  });
  expect(plan.enabled, 'world-boss flag opts the map in').toBe(true);
  expect(plan.livePlan, 'event spawned a plan').not.toBeNull();
  expect(plan.livePlan).toEqual(plan.planned);
  expect(plan.planned.bossId).toBe('ember-titan');
  expect(plan.status).toBe('active');
  const spawnDist = Math.hypot(plan.planned.x, plan.planned.z);
  expect(spawnDist, 'spawn ringed 55-95m from the origin').toBeGreaterThanOrEqual(55);
  expect(spawnDist).toBeLessThanOrEqual(95);
  expect(plan.livePlan!.lifetimeSeconds).toBe(600);
  expect(plan.livePlan!.waypoints.length).toBe(5);
  expect(plan.boss, 'one boss brute spawned').not.toBeNull();
  expect(plan.boss!.isBoss, 'spawned brute carries the boss flag').toBe(true);
  expect(plan.boss!.inRoster, 'boss is in the enemy roster').toBe(true);
  expect(plan.rosterBosses, 'one active world boss per map max').toBe(1);
  const spawnDrift = Math.hypot(plan.boss!.x - plan.planned.x, plan.boss!.z - plan.planned.z);
  expect(spawnDrift, 'boss spawns at the planned position (AI wander drifts it a few metres)').toBeLessThan(5);
  expect(plan.boss!.maxHealth, 'health scaled by the def (120 x 1.6)').toBe(192);
  expect(plan.beacon, 'beacon marker follows the boss').toBe(true);
  expect(plan.arenaActive, 'arena rules do NOT apply here').toBe(false);
  expect(plan.arena, 'no arena placed on a world-boss map').toBeNull();

  // ---- leg 2: boss bar shows the def name ----
  await waitFor(page, 'boss bar', () => page.evaluate(() => {
    const bar = document.getElementById('xandria-boss-bar');
    return !!bar && bar.style.display !== 'none'
      && (bar.querySelector('.bb-name') as HTMLElement)?.textContent === 'EMBER TITAN';
  }), 60_000);

  // ---- leg 3: patrol steering — player far away, home lands on a waypoint ----
  const patrol = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const W = X.worldBossTest;
    const live = W.liveWorldBoss();
    const boss = live.liveBoss;
    const av = X.engine.portalsPlayerAvatar;
    const V = av.ctrl.position.constructor;
    // park the player 120m from the boss: beyond telegraph range, so the
    // encounter steers the patrol loop instead of fighting
    av.ctrl.teleport(new V(boss.position.x + 120, boss.position.y + 1, boss.position.z));
    (window as unknown as any).__BOSS__ = boss;
    return { waypoints: live.livePlan.waypoints as { x: number; z: number }[] };
  });
  // give the encounter a few ticks to steer, then read the home position
  await page.waitForTimeout(5000);
  const home = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const boss = (window as unknown as any).__BOSS__;
    const live = X.worldBossTest.liveWorldBoss();
    return {
      home: { x: boss.home.x as number, z: boss.home.z as number },
      waypoints: live.livePlan.waypoints as { x: number; z: number }[],
    };
  });
  const homeOnLoop = home.waypoints.some((w) => Math.hypot(home.home.x - w.x, home.home.z - w.z) < 2);
  expect(homeOnLoop, 'boss home steered onto the seeded waypoint loop').toBe(true);

  // ---- leg 4: telegraphed attacks damage the player at 5m (out of melee) ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9; // the bot must survive the observation
    const boss = (window as unknown as any).__BOSS__;
    const V = av.ctrl.position.constructor;
    // freeze the chase so the boss can never close to melee — any damage
    // in this leg is telegraphed
    boss.spec.speed = 0;
    av.ctrl.teleport(new V(boss.position.x + 5, boss.position.y + 1, boss.position.z));
    const enc = X.worldBossTest.liveEncounter();
    (window as unknown as any).__T0__ = { health0: av.health as number, started0: enc.stats.attacksStarted as number };
  });
  await waitFor(page, 'telegraphed attack resolves', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    const enc = X.worldBossTest.liveEncounter();
    return enc.stats.attacksResolved > 0 && av.health < 1e9;
  }), 180_000);
  const telegraphDone = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const enc = X.worldBossTest.liveEncounter();
    const t0 = (window as unknown as any).__T0__;
    return {
      started: (enc.stats.attacksStarted as number) - t0.started0,
      resolved: enc.stats.attacksResolved as number,
      health: X.engine.portalsPlayerAvatar.health as number,
    };
  });
  expect(telegraphDone.started, 'telegraphs were shown').toBeGreaterThan(0);
  expect(telegraphDone.resolved, 'attacks resolved').toBeGreaterThan(0);
  expect(telegraphDone.health, 'telegraphed attack damaged the player at 5m').toBeLessThan(1e9);

  // ---- leg 5: real kill -> boss loot lands exactly, event completes ----
  const death = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const L = X.lootTest;
    const W = L.liveItemWorld();
    const before = W.liveItems.length;
    const boss = (window as unknown as any).__BOSS__;
    const seed = X.spec.meta.seed as number;
    const rng = L.buildLootRng(seed);
    const expected = L.rollLoot(rng, 'brute', true);
    boss.damage(99999); // the real die() path (damage -> die -> onDeath -> loot roll)
    if (boss.corpseT > 0.01) boss.corpseT = 0.01; // test-only: shorten the SwiftShader-slow tumble
    const newDrops = W.liveItems.slice(before).map((i: any) => ({ itemId: i.id as string, count: i.count as number }));
    return {
      expected: expected.map((d: any) => `${d.itemId}x${d.count}`).sort(),
      actual: newDrops.map((d: any) => `${d.itemId}x${d.count}`).sort(),
    };
  });
  expect(death.actual, 'boss drops match the seeded boss-path roll exactly').toEqual(death.expected);
  const gear = death.actual.find((d: string) => d.startsWith('loot_void_edge') || d.startsWith('loot_star_aegis'));
  expect(gear, 'boss death grants legendary-grade gear (epic+ boss table)').toBeTruthy();
  await waitFor(page, 'event completes', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const live = X.worldBossTest.liveWorldBoss();
    const bar = document.getElementById('xandria-boss-bar');
    return live.liveStatus === 'done' && live.liveBeacon === null
      && (!bar || (bar as HTMLElement).style.display === 'none');
  }), 60_000);

  // ---- leg 6: toast fires through the real path on a fresh spawn ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const live = X.worldBossTest.liveWorldBoss();
    live.spawnForMap(X.spec.meta.seed);
  });
  await waitFor(page, 'world-boss toast', async () => {
    const txt = await page.evaluate(() => {
      const el = document.querySelector('.xhud .toast');
      return el ? (el.textContent ?? '') : '';
    });
    return txt.includes('WORLD BOSS');
  }, 15_000);
  const respawn = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const live = X.worldBossTest.liveWorldBoss();
    return { status: live.liveStatus, beacon: !!live.liveBeacon, bosses: (X.blueprint.enemies.enemies as any[]).filter((e: any) => e.isBoss && e.alive).length };
  });
  expect(respawn.status).toBe('active');
  expect(respawn.beacon).toBe(true);
  // exactly one LIVE boss after re-spawn: the felled brute's corpse was
  // swept by the roster, and the re-spawn adds exactly one brute
  expect(respawn.bosses).toBe(1);

  // ---- leg 7: perf — draw delta of the active boss + beacon (INSTANCING.md method) ----
  const perf = await page.evaluate(async () => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const live = X.worldBossTest.liveWorldBoss();
    const boss = live.liveBoss;
    const av = X.engine.portalsPlayerAvatar;
    const V = av.ctrl.position.constructor;
    // park the player 12m from the boss so the boss + beacon are in view
    av.health = av.maxHealth = 1e9;
    if (boss) boss.spec.speed = 0;
    av.ctrl.teleport(new V(boss.position.x + 12, boss.position.y + 1, boss.position.z));
    const renderer = X.engine.renderer;
    const med = async () => {
      const calls: number[] = [];
      for (let i = 0; i < 10; i++) {
        calls.push(renderer.info.render.calls);
        await new Promise((r) => setTimeout(r, 300));
      }
      calls.sort((a: number, b: number) => a - b);
      return calls[4] + (calls[5] - calls[4]) / 2;
    };
    const withBoss = await med();
    live.despawnAll();
    X.blueprint.enemies.despawnAll(); // remove the roster brute for the without-leg
    await new Promise((r) => setTimeout(r, 3000)); // let the corpse sweep settle
    const without = await med();
    live.spawnForMap(X.spec.meta.seed);
    await new Promise((r) => setTimeout(r, 3000)); // let the fresh boss + beacon settle
    const respawned = await med();
    return { withBoss, without, respawned };
  });
  // A-B-A: report the medians; the gate is gross-regression only — at
  // ~4fps SwiftShader the 300ms samples straddle frame boundaries, so
  // single-digit call noise is expected on a small base count.
  console.log('[world-boss perf] withBoss=%s without=%s respawned=%s', perf.withBoss, perf.without, perf.respawned);
  expect(Math.abs(perf.respawned - perf.withBoss) / perf.withBoss).toBeLessThan(0.25);

  // ---- mobile leg: 360x780, bar element present + zero errors ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(3000);
  const mobileBar = await page.evaluate(() => {
    const bar = document.getElementById('xandria-boss-bar');
    return bar ? 'present' : 'missing';
  });
  expect(mobileBar).not.toBe('missing');

  expect(errors, 'zero console/page errors').toEqual([]);
});

test('world-boss: timer despawn leaves no orphan state', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await boot(page, 30);

  await waitFor(page, 'boss active', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const live = X.worldBossTest.liveWorldBoss();
    return live?.liveStatus === 'active' && !!live.liveBoss;
  }), 60_000);
  const before = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return {
      items: X.lootTest.liveItemWorld().liveItems.length,
      bosses: (X.blueprint.enemies.enemies as any[]).filter((e: any) => e.isBoss && e.alive).length,
      remaining: X.worldBossTest.liveWorldBoss().remainingSeconds,
    };
  });
  expect(before.bosses).toBe(1);
  // the clamp floor is 30s (a 10s request clamps up); assert the floor held
  expect(before.remaining, 'lifetime override honoured at the clamp floor').toBeLessThanOrEqual(30);
  expect(before.remaining).toBeGreaterThan(0);

  // the 30s timer expires with no kill: retreat, no loot, no orphans.
  // SwiftShader runs game time ~16x slower than wall time here (dt clamp),
  // so 30 game-seconds need up to ~8 wall-minutes.
  await waitFor(page, 'timer retreat', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const live = X.worldBossTest.liveWorldBoss();
    return live.liveStatus === 'done' && live.liveBoss === null && live.liveBeacon === null
      && !live.liveEncounter.isActive;
  }), 600_000);
  const after = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const bar = document.getElementById('xandria-boss-bar');
    return {
      items: X.lootTest.liveItemWorld().liveItems.length,
      bosses: (X.blueprint.enemies.enemies as any[]).filter((e: any) => e.isBoss && e.alive).length,
      barHidden: !bar || (bar as HTMLElement).style.display === 'none',
    };
  });
  expect(after.items, 'timer despawn grants no loot').toBe(before.items);
  expect(after.bosses, 'no roster brute remains after retreat').toBe(0);
  expect(after.barHidden, 'boss bar hidden after retreat').toBe(true);

  // the event never respawns on its own
  await page.waitForTimeout(12000);
  const settled = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.worldBossTest.liveWorldBoss().liveStatus;
  });
  expect(settled).toBe('done');

  expect(errors, 'zero console/page errors').toEqual([]);
});
