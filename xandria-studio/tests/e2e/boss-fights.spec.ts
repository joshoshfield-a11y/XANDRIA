/**
 * Boss-fights wave — boss encounters end to end, desktop + 360x780.
 *
 * - Generator flag: spec.custom.boss marks the boss map; the arena the
 *   encounter places matches planBossArena(seed) exactly (deterministic
 *   per world seed), ringed 70-110m from the spawn.
 * - The boss brute binds on arrival: teleported into the arena, health
 *   scaled by the def, boss bar (DOM #xandria-boss-bar) appears with the
 *   boss name.
 * - Telegraphs: parking the player 5m from the boss (outside the 2.6m
 *   melee range, inside the nova radius) produces telegraphed attacks —
 *   stats.attacksStarted/attacksResolved advance and the player takes
 *   damage only a telegraph can deal at that range.
 * - Phases: damaging the boss to <=66% flips the bar phase label to
 *   ENRAGED (and the brute's own phase transition fires).
 * - Death: the boss death rolls the items-expansion boss path —
 *   rollLoot(rng, 'brute', true) replicated exactly — legendary-grade
 *   gear drops as a world item; the bar hides.
 * - Zero console/page errors throughout.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

/** "Forgotten Valley" tp-action spec retargeted at a boss fight. */
function bossSpecB64(): string {
  const s = JSON.parse(Buffer.from(B64, 'base64').toString('utf8'));
  s.objective = { type: 'boss', count: 1, timeLimit: 0, description: 'Defeat THE WARDEN' };
  s.enemies = [{ kind: 'brute', count: 1, health: 120, speed: 4.5, damage: 12, weapon: 'melee' }];
  s.custom = {
    ...(s.custom ?? {}),
    boss: { enabled: true, bossId: 'the-warden' },
    items: { defs: {} }, // activate the item kit so the legendary drop has a world
  };
  return Buffer.from(JSON.stringify(s)).toString('base64');
}

test('boss-fights: arena -> telegraphs -> phases -> legendary death, desktop + mobile', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(bossSpecB64())}&test=1&autostart=1&splash=0`);

  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(1000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.bossTest && X.lootTest);
  }), 240_000);

  // ---- leg 1: generator flag + deterministic arena placement ----
  const arena = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const B = X.bossTest;
    const seed = X.spec.meta.seed as number;
    const planned = B.planBossArena(seed, 26);
    const enc = B.liveEncounter();
    return {
      seed,
      enabled: B.bossEnabled(X.spec),
      defId: B.resolveBossDef(X.spec).id,
      planned,
      live: enc?.liveArena ? { x: enc.liveArena.x, z: enc.liveArena.z, radius: enc.liveArena.radius } : null,
      active: !!enc?.isActive,
    };
  });
  expect(arena.enabled, 'generator flag marks the boss map').toBe(true);
  expect(arena.defId).toBe('the-warden');
  expect(arena.active).toBe(true);
  expect(arena.live, 'encounter placed an arena').not.toBeNull();
  expect(arena.live!.x).toBeCloseTo(arena.planned.x, 6);
  expect(arena.live!.z).toBeCloseTo(arena.planned.z, 6);
  const arenaDist = Math.hypot(arena.live!.x, arena.live!.z);
  expect(arenaDist, 'arena ringed 70-110m from the spawn').toBeGreaterThanOrEqual(70);
  expect(arenaDist).toBeLessThanOrEqual(110);

  // ---- leg 2: the boss binds, teleports into the arena, bar appears ----
  await waitFor('boss bind', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!X.bossTest.liveEncounter()?.liveBoss;
  }), 60_000);
  const bind = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const enc = X.bossTest.liveEncounter();
    const boss = enc.liveBoss;
    const a = enc.liveArena;
    const bar = document.getElementById('xandria-boss-bar');
    return {
      isBoss: !!boss.isBoss,
      distToArena: Math.hypot(boss.position.x - a.x, boss.position.z - a.z),
      arenaRadius: a.radius,
      maxHealth: boss.maxHealth as number,
      barVisible: !!bar && bar.style.display !== 'none',
      barName: (bar?.querySelector('.bb-name') as HTMLElement)?.textContent ?? null,
    };
  });
  expect(bind.isBoss, 'bound enemy is the boss brute').toBe(true);
  expect(bind.distToArena, 'boss teleported into the arena').toBeLessThanOrEqual(bind.arenaRadius);
  expect(bind.maxHealth, 'health scaled by the def (120 x 1.25)').toBe(150);
  expect(bind.barVisible, 'boss bar shown').toBe(true);
  expect(bind.barName).toBe('THE WARDEN');

  // ---- leg 3: telegraphed attacks damage the player at 5m (out of melee) ----
  const telegraph = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9; // the bot must survive the observation
    const enc = X.bossTest.liveEncounter();
    const boss = enc.liveBoss;
    const V = av.ctrl.position.constructor;
    // hold 5m from the boss: outside brute melee (2.6m), inside nova (9m).
    // Test-only: freeze the brute's chase speed so it can never close to
    // melee — any damage the player takes in this leg is telegraphed.
    boss.spec.speed = 0;
    av.ctrl.teleport(new V(boss.position.x + 5, boss.position.y + 1, boss.position.z));
    (window as unknown as any).__T0__ = { health0: av.health as number, started0: enc.stats.attacksStarted as number };
    return (window as unknown as any).__T0__;
  });
  // the scheduler works on its own now (boss frozen at 5m)
  await waitFor('telegraphed attack resolves', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    const enc = X.bossTest.liveEncounter();
    return enc.stats.attacksResolved > 0 && av.health < 1e9;
  }), 180_000);
  const telegraphDone = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const enc = X.bossTest.liveEncounter();
    const t0 = (window as unknown as any).__T0__;
    return {
      started: (enc.stats.attacksStarted as number) - t0.started0,
      resolved: enc.stats.attacksResolved as number,
      health: X.engine.portalsPlayerAvatar.health as number,
    };
  });
  expect(telegraphDone.started, 'telegraphs were shown').toBeGreaterThan(0);
  expect(telegraphDone.resolved, 'attacks resolved').toBeGreaterThan(0);
  expect(telegraphDone.health, 'telegraphed attack damaged the player at 5m').toBeLessThan(telegraph.health0);

  // ---- leg 4: phase transition flips the bar label ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const boss = X.bossTest.liveEncounter().liveBoss;
    (window as unknown as any).__BOSS__ = boss;
    boss.damage(boss.maxHealth * 0.4); // 60% -> enraged
  });
  await waitFor('phase label', () => page.evaluate(() => {
    const bar = document.getElementById('xandria-boss-bar');
    return (bar?.querySelector('.bb-phase') as HTMLElement)?.textContent === 'ENRAGED';
  }), 60_000);
  const phase = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return { bossPhase: (window as unknown as any).__BOSS__.bossPhase as number };
  });
  expect(phase.bossPhase, "brute's own phase transition fired").toBe(1);

  // ---- leg 5: boss death -> legendary-grade roll on the items-expansion path ----
  const death = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const L = X.lootTest;
    const W = L.liveItemWorld();
    const before = W.liveItems.length;
    const boss = (window as unknown as any).__BOSS__;
    const seed = X.spec.meta.seed as number;
    // replicate the boss loot roll: first (only) kill on a fresh stream
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
  // the bar hides on the next encounter tick after the death (unbind is
  // update-driven, not synchronous with damage())
  await waitFor('boss bar hides', () => page.evaluate(() => {
    const bar = document.getElementById('xandria-boss-bar');
    return !bar || (bar as HTMLElement).style.display === 'none';
  }), 60_000);

  // ---- mobile leg: 360x780, bar layout + zero errors ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(3000);
  const mobileBar = await page.evaluate(() => {
    const bar = document.getElementById('xandria-boss-bar');
    if (!bar) return 'missing';
    const r = bar.getBoundingClientRect();
    return `w=${Math.round(r.width)}`;
  });
  expect(mobileBar).not.toBe('missing');

  expect(errors, 'zero console/page errors').toEqual([]);
});
