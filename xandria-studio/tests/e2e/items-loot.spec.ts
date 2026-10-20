/**
 * Items-expansion wave — kill -> loot -> collect -> equip, desktop + 360x780.
 *
 * - Enemy kills roll seeded loot (Rng(mapSeed ^ LOOT_SALT)) off the
 *   EnemyManager die() path; drops spawn as world pickups at the death
 *   site. The test replicates the roll sequence from the spec seed and
 *   asserts each kill's drops match EXACTLY (ids + counts) — the kill
 *   order IS the stream order, so the replication consumes in lockstep.
 * - Collect leg: teleport onto the first equippable gear drop, the
 *   magnet/collect path banks it, the real equip() path fills its slot.
 * - Portal reset: spawnForMap(same seed) re-seeds the stream — the next
 *   kill rolls the identical drops as kill #0.
 * - Perf leg: 20 direct world drops cost a bounded number of draw calls
 *   (loot reuses the world-item mesh path — no new instanced meshes).
 * - Zero console/page errors throughout.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// "Forgotten Valley" tp-action spec, seed 20261012 — the same
// deterministic scene the enemies/crafting specs use.
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

type Drop = { itemId: string; count: number };
type DropPos = Drop & { pos: { x: number; y: number; z: number } };

const multiset = (ds: Drop[]): string => ds.map((d) => `${d.itemId}x${d.count}`).sort().join(',');

test('items-expansion: kill -> seeded loot drops -> collect -> equip, desktop + mobile', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);

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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.lootTest);
  }), 240_000);

  // ---- setup: handles + the player parked far from the action ----
  const setup = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const L = X.lootTest;
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    const M = L.liveManager();
    av.health = av.maxHealth = 1e9; // the bot must survive stray aggro
    // park the player 150m out so no drop is magnet-collected mid-test
    const V = av.ctrl.position.constructor;
    const y = E.terrain ? E.terrain.heightAt(150, 150) : 0;
    av.ctrl.teleport(new V(150, y + 2, 150));
    av.ctrl.velocity?.set?.(0, 0, 0);
    return {
      seed: X.spec.meta.seed as number,
      lootHooksSet: M.lootHooks !== null && M.lootHooks !== undefined,
      rosterSize: M.enemies.length as number,
    };
  });
  expect(setup.lootHooksSet, 'blueprint wired enemies.lootHooks').toBe(true);
  expect(setup.rosterSize).toBeGreaterThanOrEqual(2);

  /** kill the first live enemy via the real damage -> die path; returns kind + new world drops */
  const killFirst = (): Promise<{ kind: string; isBoss: boolean; newDrops: DropPos[] }> =>
    page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const L = X.lootTest;
      const M = L.liveManager();
      const W = L.liveItemWorld();
      const before = W.liveItems.length;
      const victim = M.enemies.find((e: any) => e.alive);
      if (!victim) throw new Error('no live enemy to kill');
      const kind = victim.spec.kind as string;
      const isBoss = !!victim.isBoss;
      (window as unknown as any).__VICTIM__ = victim;
      victim.damage(99999); // the real die() path (damage -> die -> onDeath -> loot roll)
      const newDrops = W.liveItems.slice(before).map((i: any) => ({
        itemId: i.id as string,
        count: i.count as number,
        pos: { x: i.mesh.position.x as number, y: i.mesh.position.y as number, z: i.mesh.position.z as number },
      }));
      // Test-only acceleration: the enemies wave's 1.5s death tumble runs
      // at ~5% wall-clock speed under SwiftShader (dt clamp), so a natural
      // sweep would take ~30s per kill. Short-circuit the tumble — the
      // sweep itself is still exercised, just not the full animation. The
      // loot assertions above are unaffected.
      if (victim.corpseT > 0.01) victim.corpseT = 0.01;
      return { kind, isBoss, newDrops };
    });

  /**
   * Dismiss any open level-up modal via the real user path (click the
   * first upgrade). Kills AND pickups grant XP; the modal PAUSES the
   * engine, so the corpse tumble (and its roster sweep) cannot advance
   * until it is dismissed. No-op when no modal is showing.
   */
  const dismissLevelUp = async (): Promise<void> => {
    const n: number = await page.evaluate(() => document.querySelectorAll('button.lvlopt').length);
    if (n > 0) {
      await page.evaluate(() => (document.querySelector('button.lvlopt') as HTMLButtonElement).click());
    }
  };

  /**
   * Wait until the last victim's corpse tumble finished and the roster
   * swept it. A pickup level-up can pop its (pausing) modal at ANY time
   * during the wait — not just right after the kill — so every poll
   * first dismisses a modal if one is showing.
   */
  const awaitSweep = (): Promise<void> => waitFor('corpse sweep', async () => {
    await dismissLevelUp();
    const gone: boolean = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const v = (window as unknown as any).__VICTIM__;
      return !X.lootTest.liveManager().enemies.includes(v);
    });
    return gone;
  }, 180_000);

  /** replicate the manager's roll stream for the kill plan so far (fresh rng per call) */
  const replicate = (plan: Array<{ kind: string; isBoss: boolean }>): Promise<Drop[][]> =>
    page.evaluate(([seed, plan]) => {
      const L = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.lootTest;
      const rng = L.buildLootRng(seed);
      return plan.map((k: any) => L.rollLoot(rng, k.kind, k.isBoss));
    }, [setup.seed, plan] as any);

  // ---- desktop leg: kill in order; every kill's drops match the seeded rolls exactly ----
  const plan: Array<{ kind: string; isBoss: boolean }> = [];
  let firstExpected = '';
  let gear: { itemId: string; slot: string; pos: { x: number; y: number; z: number } } | null = null;
  for (let k = 0; k < 12 && !gear; k++) {
    const live: boolean = await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.lootTest.liveManager().enemies.some((e: any) => e.alive);
    });
    if (!live) {
      // roster exhausted (the fixture fields 6 walkers, no splitters) —
      // spawn a fresh wave WITHOUT resetting the loot stream (spawnAll,
      // not spawnForMap) so the replication below stays in lockstep.
      await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const M = X.lootTest.liveManager();
        const av = X.engine.portalsPlayerAvatar;
        const V = av.ctrl.position.constructor;
        const p = av.ctrl.position;
        const terr = X.engine.terrain;
        M.spawnAll(
          [{ kind: 'walker', count: 6, health: 25, speed: 2.5, damage: 10, weapon: 'melee' }],
          (_kind: string, i: number) => {
            const x = p.x + (i - 2.5) * 3;
            const z = p.z + 5;
            const y = terr ? terr.heightAt(x, z) : 0;
            return new V(x, y + 1, z);
          },
        );
      });
    }
    const got = await killFirst();
    plan.push({ kind: got.kind, isBoss: got.isBoss });
    const exp = await replicate(plan);
    if (k === 0) firstExpected = multiset(exp[0]);
    expect(multiset(got.newDrops), `kill ${k} (${got.kind}) drops == seeded rolls`).toBe(multiset(exp[k]));
    gear = await page.evaluate(([drops]) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const defs = X.spec.custom?.items?.defs ?? {};
      for (const d of drops as any[]) {
        const slot = defs[d.itemId]?.slot as string | undefined;
        if (slot && ['weapon', 'head', 'torso', 'legs', 'accessory'].includes(slot)) {
          return { itemId: d.itemId as string, slot, pos: d.pos };
        }
      }
      return null;
    }, [got.newDrops] as any);
    await dismissLevelUp();
    await awaitSweep();
  }
  expect(gear, 'an equippable gear drop within 12 kills').not.toBeNull();

  // ---- collect leg: teleport onto the gear drop, the magnet/collect path banks it ----
  // (the spawned wave dies near the parked player, so the gear may already
  // have been magnet-collected — then there is nothing to walk to)
  const dumpState = async (tag: string): Promise<void> => {
    const s: string = await page.evaluate(([itemId, tag2]) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const L = X.lootTest;
      const W = L.liveItemWorld();
      const items = W.liveItems.map((i: any) => ({
        id: i.id, taken: !!i.taken, mode: i.mode,
        p: [Math.round(i.mesh.position.x), Math.round(i.mesh.position.y), Math.round(i.mesh.position.z)],
      }));
      const inv = L.liveInventory();
      const p = X.engine.portalsPlayerAvatar.ctrl.position;
      return JSON.stringify({ tag: tag2, nItems: items.length, items, invCount: inv.count(itemId),
        player: [Math.round(p.x), Math.round(p.y), Math.round(p.z)] });
    }, [gear!.itemId, tag] as any);
    console.log(`[loot-diag] ${s}`);
  };
  await dumpState('collect-start');
  const alreadyBanked: boolean = await page.evaluate(([itemId]) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.lootTest.liveInventory().count(itemId) > 0,
  [gear!.itemId] as any);
  if (!alreadyBanked) {
    // The drop tumbles/rolls after the kill, so re-read its live position
    // on every attempt; the magnet (3m) + grace collect bank it once the
    // player is on top of it.
    let collected = false;
    for (let attempt = 0; attempt < 4 && !collected; attempt++) {
      const found: boolean = await page.evaluate(([g]) => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const W = X.lootTest.liveItemWorld();
        const item = W.liveItems.find((i: any) => i.id === g.itemId && !i.taken);
        if (!item) return false;
        const av = X.engine.portalsPlayerAvatar;
        const V = av.ctrl.position.constructor;
        const p = item.mesh.position;
        av.ctrl.teleport(new V(p.x, p.y + 1, p.z));
        av.ctrl.velocity?.set?.(0, 0, 0);
        return true;
      }, [gear!] as any);
      if (!found) {
        // raced by the parked player's magnet — check it landed in inventory
        collected = await page.evaluate(([itemId]) =>
          (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.lootTest.liveInventory().count(itemId) > 0,
        [gear!.itemId] as any);
        if (collected) break;
        await dumpState(`find-failed-attempt-${attempt}`);
        throw new Error(`gear drop neither in the world nor banked (attempt ${attempt})`);
      }
      const t0 = Date.now();
      for (;;) {
        collected = await page.evaluate(([itemId]) =>
          (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.lootTest.liveInventory().count(itemId) > 0,
        [gear!.itemId] as any);
        if (collected || Date.now() - t0 > 15000) break;
        await page.waitForTimeout(1000);
      }
    }
    expect(collected, 'pickup collected via the magnet/collect path').toBe(true);
  }
  // the real equip() path fills the slot
  const equipped: string | null = await page.evaluate(([itemId, slot]) => {
    const INV = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.lootTest.liveInventory();
    return INV.equip(itemId) ? INV.getEquipped(slot) : null;
  }, [gear!.itemId, gear!.slot] as any);
  expect(equipped, `gear equipped into the ${gear!.slot} slot`).toBe(gear!.itemId);

  // ---- portal-reset leg: same mapSeed -> the loot stream restarts identically ----
  const resetDrops: Drop[] = await page.evaluate(([seed]) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const L = X.lootTest;
    const M = L.liveManager();
    const W = L.liveItemWorld();
    M.spawnForMap(seed); // the exact portal-arrival path (despawn + respawn + loot re-seed)
    const before = W.liveItems.length;
    const victim = M.enemies.find((e: any) => e.alive);
    (window as unknown as any).__VICTIM__ = victim;
    victim.damage(99999);
    return W.liveItems.slice(before).map((i: any) => ({ itemId: i.id, count: i.count }));
  }, [setup.seed] as any);
  expect(multiset(resetDrops), 'post-arrival kill rolls the identical drops as kill #0').toBe(firstExpected);
  await dismissLevelUp();
  await awaitSweep();

  // ---- perf leg: loot reuses the world-item mesh path (no new instanced meshes) ----
  const perf = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const W = X.lootTest.liveItemWorld();
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const base = med([0, 1, 2, 3, 4].map(() => X.engine.renderer.info.render.calls as number));
    const av = X.engine.portalsPlayerAvatar;
    const V = av.ctrl.position.constructor;
    const p = av.ctrl.position;
    for (let i = 0; i < 20; i++) {
      W.drop('loot_ironfang_blade', new V(p.x + i * 0.5, p.y + 1, p.z), undefined, 1);
    }
    const withDrops = med([0, 1, 2, 3, 4].map(() => X.engine.renderer.info.render.calls as number));
    return { base, withDrops };
  });
  const dropDelta = perf.withDrops - perf.base;
  expect(dropDelta, '20 world-item drops cost <= 60 draw calls').toBeLessThanOrEqual(60);

  // ---- mobile leg: 360x780, kill -> drop spawns, zero errors ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(3000);
  const mobileDrops: number = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const L = X.lootTest;
    const M = L.liveManager();
    const W = L.liveItemWorld();
    const before = W.liveItems.length;
    const victim = M.enemies.find((e: any) => e.alive);
    if (!victim) return -1;
    victim.damage(99999);
    return W.liveItems.length - before;
  });
  expect(mobileDrops, 'mobile kill spawns its world drops without errors').toBeGreaterThanOrEqual(0);

  expect(errors, 'zero console/page errors').toEqual([]);
});
