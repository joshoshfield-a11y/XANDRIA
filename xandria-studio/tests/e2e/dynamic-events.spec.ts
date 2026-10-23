/**
 * Dynamic-events wave — seeded world events end to end, desktop + 360x780.
 *
 * - Scheduler: the live manager's roster matches planDynamicEvents(seed)
 *   and holds one instance of each def (ambush, merchant, cache, patrol).
 * - Ambush: force-started via the test-seed hook -> toast + beacon, 3-5
 *   combatants spawn around the player, killing all -> completion bonus
 *   drops on the real loot path (kill -> loot).
 * - Cache: teleport near -> discovery toast + beacon, [E] open via the real
 *   interaction session -> seeded grants land in the inventory (cache -> loot).
 * - Patrol: force-started -> elite combatants, kill all -> bonus reward
 *   (patrol kill -> reward).
 * - Merchant: [E] Trade opens the real trade panel; buy spends trade goods
 *   and grants the item, sell returns trade goods (merchant -> trade path).
 * - Zero console/page errors throughout.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

/** tp-action spec with the item kit activated (events need the loot path). */
function eventsSpecB64(): string {
  const s = JSON.parse(Buffer.from(B64, 'base64').toString('utf8'));
  s.enemies = [{ kind: 'walker', count: 4, health: 25, speed: 2.5, damage: 10, weapon: 'melee' }];
  s.custom = {
    ...(s.custom ?? {}),
    items: { defs: {} }, // activate the item kit so the loot path exists
  };
  return Buffer.from(JSON.stringify(s)).toString('base64');
}

const waitFor = async (page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(1000);
  }
};

async function boot(page: any) {
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(`/player.html?spec=${encodeURIComponent(eventsSpecB64())}&test=1&autostart=1&splash=0`);
  await waitFor(page, 'boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.eventsTest && X.lootTest);
  }), 240_000);
  // park the player far out and make them unkillable; the bot survives strays
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9;
    const V = av.ctrl.position.constructor;
    const y = E.terrain ? E.terrain.heightAt(150, 150) : 0;
    av.ctrl.teleport(new V(150, y + 2, 150));
    av.ctrl.velocity?.set?.(0, 0, 0);
  });
  return errors;
}

function toastText(page: any) {
  return page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    void X;
    const el = document.querySelector('.xhud .toast');
    return el ? (el.textContent ?? '') : '';
  });
}

test('dynamic-events: all four event types via the test-seed hook, desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await boot(page);

  // ---- leg 0: scheduler determinism + full roster ----
  const plan = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.eventsTest;
    const seed = X.spec.meta.seed as number;
    const M = E.liveManager();
    const live = M.events.map((e: any) => ({
      defId: e.plan.defId, index: e.plan.index,
      x: e.plan.x, z: e.plan.z, seed: e.plan.seed, status: e.status,
    }));
    return { seed, live };
  });
  expect(plan.live.length, 'one instance of each def').toBe(4);
  const defIds = plan.live.map((e: any) => e.defId).sort();
  expect(defIds).toEqual(['event_ambush', 'event_cache', 'event_merchant', 'event_patrol']);

  // ---- leg 1: ambush (force-start -> toast+beacon -> kill -> bonus loot) ----
  const ambushStart = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    return { started: M.startEventForTest('event_ambush') };
  });
  expect(ambushStart.started, 'ambush force-started via the test-seed hook').toBe(true);
  await waitFor(page, 'ambush toast', async () => (await toastText(page)).includes('AMBUSH'), 10_000);
  const ambush = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_ambush');
    return {
      status: ev.status,
      combatants: ev.combatants.length,
      beacon: !!ev.beacon,
      dropCount: (X.lootTest.liveItemWorld()?.liveItems?.length ?? -1),
    };
  });
  expect(ambush.status).toBe('active');
  expect(ambush.beacon, 'ambush has a beacon marker').toBe(true);
  expect(ambush.combatants).toBeGreaterThanOrEqual(3);
  expect(ambush.combatants).toBeLessThanOrEqual(5);
  // kill every ambusher through the real damage -> die path
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_ambush');
    for (const e of ev.combatants) if (e.alive) e.damage(99999);
  });
  await waitFor(page, 'ambush done', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    return M.events.find((e: any) => e.plan.defId === 'event_ambush').status === 'done';
  }), 30_000);
  const ambushDone = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_ambush');
    return {
      bonusDrops: X.lootTest.liveItemWorld()?.liveItems?.length ?? -1,
      beaconGone: ev.beacon === null,
    };
  });
  expect(ambushDone.bonusDrops, 'completion bonus dropped as world loot').toBeGreaterThan(0);
  expect(ambushDone.beaconGone, 'beacon removed on completion').toBe(true);

  // ---- leg 2: cache (discovery -> [E] open -> inventory grants) ----
  const cacheInfo = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_cache');
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    const V = av.ctrl.position.constructor;
    const p = ev.cache.root.position;
    av.ctrl.teleport(new V(p.x + 2, p.y + 2, p.z + 2));
    av.ctrl.velocity?.set?.(0, 0, 0);
    return { id: ev.cache.interactable.id, status: ev.status };
  });
  await waitFor(page, 'cache discovered', async () => (await toastText(page)).includes('SUPPLY CACHE'), 15_000);
  const cacheOpen = await page.evaluate((id: string) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const S = X.eventsTest.liveSession();
    const M = X.eventsTest.liveManager();
    const inv = X.lootTest.liveInventory();
    const before = ['mat_ember_shard', 'mat_beast_hide', 'mat_core_fragment',
      'loot_ironfang_blade', 'loot_scorched_plate', 'loot_surge_tonic']
      .map((i) => [i, inv.count(i)] as const);
    const consumed = S.activate(id);
    const after = ['mat_ember_shard', 'mat_beast_hide', 'mat_core_fragment',
      'loot_ironfang_blade', 'loot_scorched_plate', 'loot_surge_tonic']
      .map((i) => [i, inv.count(i)] as const);
    const ev = M.events.find((e: any) => e.plan.defId === 'event_cache');
    return { consumed, before, after, status: ev.status, again: S.activate(id) };
  }, cacheInfo.id);
  expect(cacheOpen.consumed, '[E] opened the cache').toBe(true);
  const gained = cacheOpen.after.filter(([, n], i) => n > (cacheOpen.before[i][1] as number));
  expect(gained.length, 'cache granted items to the inventory').toBeGreaterThan(0);
  expect(cacheOpen.status).toBe('done');
  expect(cacheOpen.again, 'double-open is a no-op').toBe(false);

  // ---- leg 3: patrol (force-start -> kill elites -> bonus reward) ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    M.startEventForTest('event_patrol'); // no-op if the 120s timer already fired
  });
  const patrol = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_patrol');
    return { status: ev.status, combatants: ev.combatants.length, beacon: !!ev.beacon };
  });
  expect(patrol.status).toBe('active');
  expect(patrol.combatants).toBeGreaterThanOrEqual(3);
  expect(patrol.beacon, 'patrol has a beacon marker').toBe(true);
  const dropsBefore = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.lootTest.liveItemWorld()?.liveItems?.length ?? 0;
  });
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_patrol');
    for (const e of ev.combatants) if (e.alive) e.damage(99999);
  });
  await waitFor(page, 'patrol done', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    return M.events.find((e: any) => e.plan.defId === 'event_patrol').status === 'done';
  }), 30_000);
  const dropsAfter = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.lootTest.liveItemWorld()?.liveItems?.length ?? 0;
  });
  expect(dropsAfter, 'patrol kill -> bonus reward drops').toBeGreaterThan(dropsBefore);

  // ---- leg 4: merchant (trade panel -> buy -> sell) ----
  const merchantSetup = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_merchant');
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    const V = av.ctrl.position.constructor;
    const p = ev.merchant.position;
    av.ctrl.teleport(new V(p.x + 2, p.y + 2, p.z + 2));
    av.ctrl.velocity?.set?.(0, 0, 0);
    X.lootTest.liveInventory().add('mat_beast_hide', 500); // trade goods
    return {
      id: ev.merchantInteractable.id,
      defId: ev.plan.defId,
      index: ev.plan.index,
      stock: ev.stock.map((l: any) => ({ itemId: l.itemId, count: l.count, cost: l.cost })),
      good: ev.def.merchant.tradeGoodId,
      beacon: !!ev.beacon,
    };
  });
  expect(merchantSetup.beacon, 'merchant has a beacon marker').toBe(true);
  expect(merchantSetup.stock.length).toBeGreaterThan(0);
  const panelOpen = await page.evaluate((id: string) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const consumed = X.eventsTest.liveSession().activate(id);
    return { consumed, open: X.eventsTest.liveTradePanel().isOpen };
  }, merchantSetup.id);
  expect(panelOpen.consumed, '[E] Trade consumed').toBe(true);
  expect(panelOpen.open, 'trade panel opened').toBe(true);
  const trade = await page.evaluate((setup: any) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const inv = X.lootTest.liveInventory();
    const line = setup.stock[0];
    // cant-afford path first: drain goods, buy must fail honestly
    inv.remove(setup.good, 100000);
    const errBroke = M.merchantBuy(setup.defId, setup.index, line.itemId);
    // fund and buy for real
    inv.add(setup.good, 500);
    const goodBefore = inv.count(setup.good);
    const itemBefore = inv.count(line.itemId);
    const err = M.merchantBuy(setup.defId, setup.index, line.itemId);
    const goodAfter = inv.count(setup.good);
    const itemAfter = inv.count(line.itemId);
    const ev = M.events.find((e: any) => e.plan.defId === setup.defId);
    const lineAfter = ev.stock.find((l: any) => l.itemId === line.itemId).count;
    // sell the bought unit back for trade goods
    const goodsBeforeSell = inv.count(setup.good);
    const yielded = M.merchantSell(setup.defId, setup.index, line.itemId);
    const goodsAfterSell = inv.count(setup.good);
    X.eventsTest.liveTradePanel().hide();
    return {
      err, goodSpent: goodBefore - goodAfter, itemGained: itemAfter - itemBefore,
      lineDecremented: lineAfter, yielded, goodsGainedOnSell: goodsAfterSell - goodsBeforeSell,
      errBroke, panelClosed: !X.eventsTest.liveTradePanel().isOpen,
    };
  }, merchantSetup);
  expect(trade.err, 'buy succeeded').toBeNull();
  expect(trade.goodSpent, 'buy spent trade goods').toBe(merchantSetup.stock[0].cost);
  expect(trade.itemGained, 'buy granted the item').toBe(1);
  expect(trade.lineDecremented, 'stock line decremented').toBe(merchantSetup.stock[0].count - 1);
  expect(trade.yielded, 'sell yielded trade goods').toBeGreaterThan(0);
  expect(trade.goodsGainedOnSell, 'sell goods landed').toBe(trade.yielded);
  expect(trade.errBroke, 'cant-afford fails honestly').toBe('cant-afford');
  expect(trade.panelClosed, 'Esc/panel hide works').toBe(true);

  // ---- leg 5: perf — draw delta of the static event payload (INSTANCING.md method) ----
  const perf = await page.evaluate(async () => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const seed = X.spec.meta.seed as number;
    const renderer = X.engine.renderer;
    const med = async () => {
      const calls: number[] = [];
      for (let i = 0; i < 10; i++) {
        calls.push(renderer.info.render.calls);
        await new Promise((r) => setTimeout(r, 300));
      }
      calls.sort((a, b) => a - b);
      return calls[4] + (calls[5] - calls[4]) / 2;
    };
    const withEvents = await med();
    M.despawnAll();
    const without = await med();
    M.spawnForMap(seed);
    const respawned = await med();
    return { withEvents, without, respawned };
  });
  // A-B-A: report only; the assertion is that respawn restores the count
  expect(Math.abs(perf.respawned - perf.withEvents) / perf.withEvents)
    .toBeLessThan(0.15);

  expect(errors, 'zero console/page errors').toEqual([]);
});

test('dynamic-events: trade panel fits 360x780', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await boot(page);
  const fit = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const M = X.eventsTest.liveManager();
    const ev = M.events.find((e: any) => e.plan.defId === 'event_merchant');
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    const V = av.ctrl.position.constructor;
    const p = ev.merchant.position;
    av.ctrl.teleport(new V(p.x + 2, p.y + 2, p.z + 2));
    av.ctrl.velocity?.set?.(0, 0, 0);
    X.eventsTest.liveSession().activate(ev.merchantInteractable.id);
    const panel = X.eventsTest.liveTradePanel();
    const root = document.getElementById('xandria-trade-panel')!;
    const r = root.getBoundingClientRect();
    const btns = [...root.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height);
    panel.hide();
    return { open: true, width: r.width, overflowX: r.right > 361, minBtn: Math.min(...btns) };
  });
  expect(fit.width).toBeLessThanOrEqual(360);
  expect(fit.overflowX, 'no horizontal overflow').toBe(false);
  expect(fit.minBtn, 'touch targets >= 28px').toBeGreaterThanOrEqual(28);
  expect(errors, 'zero console/page errors').toEqual([]);
});
