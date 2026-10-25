/**
 * Factions-reputation wave — kill -> standing drop, trade -> rise,
 * vendor price shifts per the tier table, gated-quest lock/unlock,
 * portal-cycle + full reload preservation. Desktop + 360x780.
 *
 * - Kill leg: one walker killed through the real damage -> die path
 *   drops Ironfangs standing by exactly KILL_STANDING_DELTA (-10).
 * - Trade legs: a real ShopPanel sell (+3) then buy (+5) move Ironfangs
 *   to exactly -2; at neutral the buy charges exactly the raw stock price.
 * - Price leg: Freeholds raised to Friendly (300) via the live store,
 *   then a real buy from the Scrap & Plate vendor charges exactly
 *   round(raw * 0.9) and the panel row reads "Friendly (300)".
 * - Gate leg: a gated quest built on the REAL QuestManager class wired
 *   to the LIVE standings starts locked, unlocks via
 *   refreshStandingGates at 600, and accepts. (No seeded quest ships
 *   gated — gating is opt-in per def, so the mechanism is proven here
 *   and in unit tests rather than by mutating the shipped line.)
 * - Portal leg: a despawnAll/spawnForMap cycle over the actor rosters
 *   (the exact functions PortalTransition invokes, per quests.spec.ts)
 *   leaves standings untouched — the store is never in portalEntities.
 * - Reload legs: a full page rebuild restores standings from
 *   localStorage exactly; clearing the storage key resets them to 0.
 * - Mobile leg at 360x780: panel visible, rows fit the viewport, one
 *   kill drops standing.
 * - Zero console/page errors throughout.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);

type X = { __XANDRIA__?: any };

async function boot(page: any, errors: string[]) {
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar
        && X.factionsTest && X.economyTest && X.lootTest && X.blueprint?.standings);
    });
    if (ok) return;
    if (Date.now() - t0 > 240_000) throw new Error('boot timeout');
    await page.waitForTimeout(1000);
  }
}

async function settleModals(page: any) {
  for (let i = 0; i < 5; i++) {
    const n: number = await page.evaluate(() => document.querySelectorAll('button.lvlopt').length);
    if (n > 0) {
      await page.evaluate(() => (document.querySelector('button.lvlopt') as HTMLButtonElement).click());
    }
    const settled: boolean = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      if (document.querySelectorAll('button.lvlopt').length > 0) return false;
      if (X.engine.state === 'paused') X.engine.resume();
      return X.engine.state === 'playing';
    });
    if (settled) return;
    await page.waitForTimeout(1000);
  }
}

test('factions: kill drops, trade rises, price shifts, gate locks/unlocks, portal + reload preserve', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await boot(page, errors);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  // ---- initial state: all zero, panel present with 3 rows ----
  const initial = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const s = X.factionsTest.liveStandings();
    const panel = document.getElementById('xandria-standings-panel');
    return {
      ironfangs: s.standingOf('ironfangs'),
      ember: s.standingOf('ember_order'),
      freeholds: s.standingOf('freeholds'),
      panelVisible: !!panel && panel.style.display !== 'none',
      rows: [...(panel?.querySelectorAll('[data-faction-row]') ?? [])].map((r: any) => r.getAttribute('data-faction-row')),
    };
  });
  expect(initial.ironfangs).toBe(0);
  expect(initial.ember).toBe(0);
  expect(initial.freeholds).toBe(0);
  expect(initial.panelVisible).toBe(true);
  expect(initial.rows).toEqual(['ironfangs', 'ember_order', 'freeholds']);

  // ---- kill leg: one walker via the real die() path ----
  const kill = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.lootTest.liveManager();
    const victim = M.enemies.find((e: any) => e.alive);
    if (!victim) throw new Error('no live enemy to kill');
    const kind = victim.spec.kind as string;
    const isBoss = !!victim.isBoss;
    victim.damage(99999);
    if (victim.corpseT > 0.01) victim.corpseT = 0.01;
    return { kind, isBoss };
  });
  await settleModals(page);
  const afterKill = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return {
      ironfangs: X.factionsTest.liveStandings().standingOf('ironfangs'),
      delta: X.factionsTest.KILL_STANDING_DELTA,
      bossDelta: X.factionsTest.BOSS_KILL_STANDING_DELTA,
    };
  });
  expect(kill.isBoss).toBe(false);
  expect(kill.kind).toBe('walker');
  expect(afterKill.ironfangs).toBe(kill.isBoss ? afterKill.bossDelta : afterKill.delta);

  // ---- trade legs: real panel sell (+3) then buy (+5) ----
  const trade = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const ET = X.economyTest;
    const FT = X.factionsTest;
    const panel = ET.liveShopPanel();
    const wallet = ET.liveWallet();
    const v = ET.liveNpcManager().npcs[0];
    (X.blueprint.itemKit.inventory as any).add('loot_ironfang_blade', 1);
    const defs = X.spec.custom.items.defs;
    const vendorDef = (X.blueprint as any).vendorDefs.find((d: any) => d.id === v.vendorId);
    const unit = ET.unitSellPrice(defs['loot_ironfang_blade'], vendorDef.sellMult);
    panel.openForVendor({ vendorId: v.vendorId, spawnSeed: v.spawnSeed, keeperName: v.name });
    const beforeSell = FT.liveStandings().standingOf('ironfangs');
    panel.sell('loot_ironfang_blade', unit);
    const afterSell = FT.liveStandings().standingOf('ironfangs');
    wallet.add(100000);
    const stock = panel.stockFor(v.vendorId, v.spawnSeed);
    const line = stock.find((l: any) => l.stock > 0) ?? stock[0];
    const balBefore = wallet.balance;
    panel.buy(line);
    const balAfter = wallet.balance;
    const afterBuy = FT.liveStandings().standingOf('ironfangs');
    const countAfter = (X.blueprint.itemKit.inventory as any).count(line.itemId);
    panel.hide();
    return {
      vendorId: v.vendorId, beforeSell, afterSell, afterBuy,
      price: line.price, balBefore, balAfter, countAfter,
      sellDelta: FT.TRADE_SELL_STANDING_DELTA, buyDelta: FT.TRADE_BUY_STANDING_DELTA,
    };
  });
  expect(trade.vendorId).toBe('vendor_ironfangs');
  expect(trade.afterSell - trade.beforeSell).toBe(trade.sellDelta);
  expect(trade.afterBuy - trade.afterSell).toBe(trade.buyDelta);
  expect(trade.afterBuy).toBe(-2);
  expect(trade.balBefore - trade.balAfter, 'neutral buy charges exactly the raw stock price').toBe(trade.price);
  expect(trade.countAfter).toBe(1);

  // ---- price leg: Freeholds to Friendly, buy from Scrap & Plate ----
  const price = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const ET = X.economyTest;
    const FT = X.factionsTest;
    const panel = ET.liveShopPanel();
    const wallet = ET.liveWallet();
    const v = ET.liveNpcManager().npcs.find((n: any) => n.vendorId === 'vendor_scrap_plate');
    if (!v) throw new Error('no scrap_plate vendor');
    FT.liveStandings().adjust('freeholds', 300);
    const standing = FT.liveStandings().standingOf('freeholds');
    const tier = FT.liveStandings().tierOf('freeholds').id;
    const stock = panel.stockFor(v.vendorId, v.spawnSeed);
    const line = stock.find((l: any) => l.stock > 0) ?? stock[0];
    const expected = FT.effectiveBuyPrice(line.price, standing);
    wallet.add(100000);
    panel.openForVendor({ vendorId: v.vendorId, spawnSeed: v.spawnSeed, keeperName: v.name });
    // panel text BEFORE the buy (the buy itself raises Freeholds +5).
    const panelText = (document.getElementById('xandria-standings-panel') as HTMLElement)?.textContent ?? '';
    const balBefore = wallet.balance;
    panel.buy(line);
    const balAfter = wallet.balance;
    panel.hide();
    const afterBuy = FT.liveStandings().standingOf('freeholds');
    return { standing, tier, raw: line.price, expected, paid: balBefore - balAfter, panelText, afterBuy };
  });
  expect(price.standing).toBe(300);
  expect(price.tier).toBe('friendly');
  expect(price.expected).toBe(Math.round(price.raw * 0.9));
  expect(price.paid).toBe(price.expected);
  expect(price.panelText).toContain('Freeholds — Friendly (300)');
  expect(price.afterBuy).toBe(305); // the buy itself is a trade: +5

  // ---- gate leg: gated quest on the real manager class, live standings ----
  const gate = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const FT = X.factionsTest;
    const QM = X.questTest.QuestManager;
    const standings = FT.liveStandings();
    const def = {
      id: 'gated_test', name: 'Gated Test', giver: 'any', brief: 'b',
      objectives: [{ id: 'o1', kind: 'talk', desc: 'Talk', target: 'any', count: 1 }],
      rewards: { xp: 0, items: [] },
      side: true,
      minStanding: { factionId: 'freeholds', min: 600 },
    };
    const m = new QM({
      defs: [def],
      inventory: () => null,
      defsTable: () => ({}),
      progression: null,
      toast: () => {},
      standingOf: (f: string) => standings.standingOf(f),
    });
    const lockedAtStart = m.statusOf('gated_test');
    const acceptWhileLocked = m.accept('gated_test');
    standings.adjust('freeholds', 300); // 305 -> 605 (honored; gate needs 600)
    m.refreshStandingGates();
    const afterRefresh = m.statusOf('gated_test');
    const acceptAfter = m.accept('gated_test');
    return { lockedAtStart, acceptWhileLocked, afterRefresh, acceptAfter, freeholds: standings.standingOf('freeholds') };
  });
  expect(gate.lockedAtStart).toBe('locked');
  expect(gate.acceptWhileLocked).toBe(false);
  expect(gate.afterRefresh).toBe('available');
  expect(gate.acceptAfter).toBe(true);
  expect(gate.freeholds).toBe(605);

  // ---- portal leg: despawn/spawn cycle leaves standings untouched ----
  const portal = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const FT = X.factionsTest;
    const before = {
      ironfangs: FT.liveStandings().standingOf('ironfangs'),
      freeholds: FT.liveStandings().standingOf('freeholds'),
      ember: FT.liveStandings().standingOf('ember_order'),
    };
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void; spawnForMap(s: number): void }>;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies' || s.id === 'vendors') s.despawnAll();
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies' || s.id === 'vendors') s.spawnForMap(X.spec.meta.seed);
    const after = {
      ironfangs: FT.liveStandings().standingOf('ironfangs'),
      freeholds: FT.liveStandings().standingOf('freeholds'),
      ember: FT.liveStandings().standingOf('ember_order'),
    };
    return { before, after };
  });
  expect(portal.after).toEqual(portal.before);
  expect(portal.after).toEqual({ ironfangs: -2, freeholds: 605, ember: 0 });

  // ---- reload leg: full rebuild restores standings from localStorage ----
  await boot(page, errors);
  const reloaded = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return {
      ironfangs: X.factionsTest.liveStandings().standingOf('ironfangs'),
      freeholds: X.factionsTest.liveStandings().standingOf('freeholds'),
      ember: X.factionsTest.liveStandings().standingOf('ember_order'),
    };
  });
  expect(reloaded).toEqual({ ironfangs: -2, freeholds: 605, ember: 0 });

  // ---- storage-clear leg: wiping the key resets to 0 on rebuild ----
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    localStorage.removeItem(`xandria.factions.v1:${X.spec.meta.seed >>> 0}`);
  });
  await boot(page, errors);
  const cleared = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return {
      ironfangs: X.factionsTest.liveStandings().standingOf('ironfangs'),
      freeholds: X.factionsTest.liveStandings().standingOf('freeholds'),
      ember: X.factionsTest.liveStandings().standingOf('ember_order'),
    };
  });
  expect(cleared).toEqual({ ironfangs: 0, freeholds: 0, ember: 0 });

  expect(errors, 'zero console/page errors').toEqual([]);
});

test('factions: panel fits 360x780, kill drops standing on mobile', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.setViewportSize({ width: 360, height: 780 });

  await boot(page, errors);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const fit = await page.evaluate(() => {
    const panel = document.getElementById('xandria-standings-panel') as HTMLElement;
    const r = panel.getBoundingClientRect();
    return { visible: panel.style.display !== 'none', right: r.right, width: r.width };
  });
  expect(fit.visible).toBe(true);
  expect(fit.right).toBeLessThanOrEqual(360);

  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.lootTest.liveManager();
    const victim = M.enemies.find((e: any) => e.alive);
    victim.damage(99999);
    if (victim.corpseT > 0.01) victim.corpseT = 0.01;
  });
  await settleModals(page);
  const standing = await page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.factionsTest.liveStandings().standingOf('ironfangs'));
  expect(standing).toBe(-10);

  expect(errors, 'zero console/page errors').toEqual([]);
});
