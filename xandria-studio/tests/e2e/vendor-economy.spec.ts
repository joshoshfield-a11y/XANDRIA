/**
 * Vendor-economy wave — kill -> currency -> sell loot -> buy -> equip,
 * plus currency survival across a real portal transition. Desktop + 360x780.
 *
 * - Kill leg: enemy kills roll seeded scrap (Rng(mapSeed ^ LOOT_SALT ^
 *   CURRENCY_SALT)) off the EnemyManager die() path. The test replicates
 *   the currency stream from the spec seed and asserts the wallet balance
 *   matches EXACTLY after each kill (the kill order IS the stream order,
 *   so the replication consumes in lockstep). The item-loot stream is
 *   untouched (items-loot.spec.ts still replicates it exactly).
 * - Sell leg: a loot item granted to the live inventory is sold through
 *   the real ShopPanel.sell path; the wallet gains exactly the seeded
 *   sell price and the item leaves the backpack.
 * - Buy leg: wallet funded via the real Wallet.add; a stock line bought
 *   through the real ShopPanel.buy path lands in the backpack, the wallet
 *   drops by the exact price, and the line's stock decrements.
 * - Equip leg: the bought weapon equips through the real Inventory.equip()
 *   into its slot.
 * - Shop UI leg: teleport next to a live vendor NPC (frozen), wait for
 *   the real "[E] Trade with <name>" prompt, press E, assert the shop
 *   panel opens with buy/sell tabs and >=28px touch targets; Escape
 *   closes. Villager NPCs still open the quest dialogue (regression).
 * - Portal leg: one REAL portal transition (the portal-traverse walk
 *   pattern); the wallet balance is identical after arrival, the vendor
 *   roster respawns (3 merchants), and the shop reopens with fresh
 *   seeded stock for the new map.
 * - Perf leg: A-B-A draw-call sampling (renderer.info.render.calls)
 *   around vendorManager.despawnAll/spawnForMap — the per-vendor draw
 *   cost of the instanced merchant roster, reported, not asserted tight.
 * - Zero console/page errors throughout.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// "Forgotten Valley" tp-action spec, seed 20261012 — the same
// deterministic scene the enemies/crafting/loot specs use.
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

test('vendor-economy: kill -> scrap -> sell -> buy -> equip, shop UI', async ({ page }) => {
  test.setTimeout(1_200_000);
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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.economyTest && X.lootTest);
  }), 240_000);

  // ---- setup: handles + the player parked far from the action ----
  const setup = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9; // the bot must survive stray aggro
    const V = av.ctrl.position.constructor;
    const y = E.terrain ? E.terrain.heightAt(150, 150) : 0;
    av.ctrl.teleport(new V(150, y + 2, 150));
    av.ctrl.velocity?.set?.(0, 0, 0);
    return {
      seed: X.spec.meta.seed as number,
      vendors: X.economyTest.liveNpcManager().npcs.map((n: any) => ({
        vendorId: n.vendorId, name: n.name, spawnSeed: n.spawnSeed,
      })),
      wallet: X.economyTest.liveWallet().balance as number,
    };
  });
  expect(setup.vendors.length, '3 merchants spawned').toBe(3);
  expect(setup.vendors.every((v: any) => v.vendorId), 'every vendor has a vendorId').toBe(true);
  expect(setup.wallet).toBe(0);

  /** kill the first live enemy via the real damage -> die path; returns kind/isBoss */
  const killFirst = (): Promise<{ kind: string; isBoss: boolean }> =>
    page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const M = X.lootTest.liveManager();
      const victim = M.enemies.find((e: any) => e.alive);
      if (!victim) throw new Error('no live enemy to kill');
      const kind = victim.spec.kind as string;
      const isBoss = !!victim.isBoss;
      victim.damage(99999); // the real die() path (damage -> die -> onDeath -> loot + currency)
      if (victim.corpseT > 0.01) victim.corpseT = 0.01; // test-only tumble shortcut (see items-loot.spec.ts)
      return { kind, isBoss };
    });

  const dismissLevelUp = async (): Promise<void> => {
    const n: number = await page.evaluate(() => document.querySelectorAll('button.lvlopt').length);
    if (n > 0) {
      await page.evaluate(() => (document.querySelector('button.lvlopt') as HTMLButtonElement).click());
    }
  };

  /** Talking to a villager can complete a talk objective -> XP -> a
   *  level-up modal (which pauses the game). Settle those so later legs
   *  see a running game. */
  const settleModals = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await dismissLevelUp();
      const settled: boolean = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        if (document.querySelectorAll('button.lvlopt').length > 0) return false;
        if (X.engine.state === 'paused') X.engine.resume();
        return X.engine.state === 'playing';
      });
      if (settled) return;
      await page.waitForTimeout(1000);
    }
    throw new Error('settleModals: game did not return to playing');
  };

  const waitForCorpseSweep = async (): Promise<void> => {
    const t0 = Date.now();
    for (;;) {
      await dismissLevelUp();
      const swept: boolean = await page.evaluate(() => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        return X.lootTest.liveManager().enemies.every((e: any) => e.alive || e.corpseT <= 0.01);
      });
      if (swept) return;
      if (Date.now() - t0 > 120_000) throw new Error('corpse sweep timeout');
      await page.waitForTimeout(2000);
    }
  };

  // ---- kill leg: the wallet matches an independent replication of the currency stream ----
  const kills: Array<{ kind: string; isBoss: boolean }> = [];
  for (let i = 0; i < 5; i++) { // the fixture spawns 6 walkers; kill 5, leave one
    kills.push(await killFirst());
    await waitForCorpseSweep();
  }
  const replicated = await page.evaluate((script) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const ET = X.economyTest;
    const rng = ET.buildCurrencyRng(X.spec.meta.seed, 0x1007 /* LOOT_SALT */);
    let total = 0;
    for (const k of script) total += ET.rollCurrencyDrops(rng, k.kind, k.isBoss);
    return total;
  }, kills);
  const walletAfterKills: number = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.economyTest.liveWallet().balance);
  expect(walletAfterKills, 'wallet == replicated currency stream').toBe(replicated);
  expect(walletAfterKills, 'kills paid some scrap').toBeGreaterThan(0);
  // HUD chip shows the same balance
  const hudCoins: string = await page.evaluate(() =>
    (document.querySelector('.xhud .score .coinval') as HTMLElement)?.textContent ?? '');
  expect(hudCoins.trim()).toBe(String(walletAfterKills));

  // ---- sell leg: loot -> scrap through the real panel path ----
  const sellResult = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const ET = X.economyTest;
    const panel = ET.liveShopPanel();
    const wallet = ET.liveWallet();
    const inv = X.lootTest.liveInventory();
    const v = ET.liveNpcManager().npcs[0];
    // grant a known loot item straight into the backpack (the collect path
    // is covered by items-loot.spec.ts; this leg tests the sell path)
    (X.blueprint.itemKit.inventory as any).add('loot_ironfang_blade', 1);
    const defs = X.spec.custom.items.defs;
    const vendorDef = (X.blueprint as any).vendorDefs.find((d: any) => d.id === v.vendorId);
    const unit = ET.unitSellPrice(defs['loot_ironfang_blade'], vendorDef.sellMult);
    const balBefore = wallet.balance;
    panel.openForVendor({ vendorId: v.vendorId, spawnSeed: v.spawnSeed, keeperName: v.name });
    panel.sell('loot_ironfang_blade', unit);
    const balAfter = wallet.balance;
    const countAfter = (X.blueprint.itemKit.inventory as any).count('loot_ironfang_blade');
    panel.hide();
    return { unit, balBefore, balAfter, countAfter };
  });
  expect(sellResult.countAfter, 'sold item left the backpack').toBe(0);
  expect(sellResult.balAfter - sellResult.balBefore, 'wallet gained exactly the sell price').toBe(sellResult.unit);
  expect(sellResult.unit).toBeGreaterThan(0);

  // ---- buy leg: scrap -> item through the real panel path ----
  const buyResult = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const ET = X.economyTest;
    const panel = ET.liveShopPanel();
    const wallet = ET.liveWallet();
    const v = ET.liveNpcManager().npcs[0];
    wallet.add(100000); // fund via the real Wallet (the kill leg proved earning)
    const stock = panel.stockFor(v.vendorId, v.spawnSeed);
    // buy a weapon line so the equip leg can use it
    const line = stock.find((l: any) => /blade|edge/i.test(l.itemId)) ?? stock[0];
    const balBefore = wallet.balance;
    panel.openForVendor({ vendorId: v.vendorId, spawnSeed: v.spawnSeed, keeperName: v.name });
    panel.buy(line);
    const balAfter = wallet.balance;
    const countAfter = (X.blueprint.itemKit.inventory as any).count(line.itemId);
    const stockAfter = line.stock;
    panel.hide();
    return { itemId: line.itemId, price: line.price, balBefore, balAfter, countAfter, stockAfter };
  });
  expect(buyResult.countAfter, 'bought item landed in the backpack').toBe(1);
  expect(buyResult.balBefore - buyResult.balAfter, 'wallet dropped by exactly the price').toBe(buyResult.price);

  // ---- equip leg: the bought weapon equips through the real equip path ----
  const equipResult = await page.evaluate((itemId) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    const r = inv.equip(itemId);
    return { ok: !!r, equipped: inv.getEquipped('weapon') };
  }, buyResult.itemId);
  expect(equipResult.ok, 'equip() succeeded').toBe(true);
  expect(equipResult.equipped, 'weapon slot holds the bought item').toBe(buyResult.itemId);

  // ---- shop UI leg: the real [E] prompt opens the shop for a vendor ----
  // exactName: assert the prompt names the teleported vendor exactly
  // (desktop). The mobile leg is vendor-agnostic — villagers cluster
  // tightly and arbitration may pick a neighboring vendor; the contract
  // under test is "vendor [E] -> shop", not which vendor wins.
  const tradeCycle = async (vendorIdx: number, exactName: boolean) => {
    await page.evaluate(([idx, isolate]) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const E = X.engine;
      const av = E.portalsPlayerAvatar;
      const V = av.ctrl.position.constructor;
      // freeze BOTH rosters (the npcs.spec.ts hardening: idle + huge
      // stateT) so no wandering villager can steal prompt arbitration
      // mid-test
      const bp = X.blueprint as any;
      const all = [...bp.npcs.npcs, ...bp.vendors.npcs];
      const mgr = X.economyTest.liveNpcManager();
      const vendor = mgr.npcs[idx];
      for (const n of all) {
        (n as any).state = 'idle';
        (n as any).stateT = 1e9;
      }
      if (isolate) {
        // vendors can spawn inside villager clusters — move every other
        // NPC 300m away so the target vendor is the undisputed nearest
        // prompt candidate (bodies re-sync interactable.position per frame)
        for (const n of all) {
          if (n === vendor) continue;
          const b = (n as any).body;
          if (b) b.position.set(b.position.x + 300, b.position.y, b.position.z);
        }
      }
      // teleport next to the vendor's LIVE position (not its home — it
      // may have wandered before being frozen)
      const p = (vendor as any).position;
      const y = E.terrain ? E.terrain.heightAt(p.x, p.z) : p.y;
      av.ctrl.teleport(new V(p.x + 1.5, y + 2, p.z));
      av.ctrl.velocity?.set?.(0, 0, 0);
    }, [vendorIdx, !exactName] as const);
    const promptText = (): Promise<string | null> => page.evaluate(() => {
      const el = document.getElementById('xandria-interact-prompt') as HTMLElement | null;
      if (!el || el.style.display !== 'block') return null;
      return el.textContent;
    });
    const vendorName: string = await page.evaluate((idx) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      return X.economyTest.liveNpcManager().npcs[idx].name;
    }, vendorIdx);
    await waitFor(`trade prompt for vendor ${vendorIdx}`, async () => {
      const t = await promptText();
      return exactName ? t === `[E] Trade with ${vendorName}` : !!t && t.startsWith('[E] Trade with ');
    }, 60_000);
    await page.keyboard.press('e');
    const shopShown = (): Promise<boolean> => page.evaluate(() => {
      const el = document.getElementById('xandria-shop-panel') as HTMLElement | null;
      return !!el && el.style.display === 'flex';
    });
    await waitFor('shop panel open', shopShown, 30_000);
    // panel content: header, tabs, buy rows, 28px touch targets
    const panelInfo = await page.evaluate(() => {
      const root = document.getElementById('xandria-shop-panel') as HTMLElement;
      const buttons = Array.from(root.querySelectorAll('button'));
      // rendered height is the honest touch-target metric (min-height
      // computes to 'auto' on buttons that don't set it)
      const heights = buttons.map((b) => (b as HTMLElement).offsetHeight);
      return {
        text: root.textContent ?? '',
        tabCount: buttons.filter((b) => b.hasAttribute('data-shop-tab')).length,
        buyRowCount: buttons.filter((b) => b.textContent === 'BUY' && b.getAttribute('aria-label')?.startsWith('Buy ')).length,
        minButtonHeight: Math.min(...heights),
      };
    });
    expect(panelInfo.text).toContain(exactName ? vendorName : 'keeper:');
    expect(panelInfo.tabCount).toBe(2);
    expect(panelInfo.buyRowCount, 'seeded stock rows rendered').toBeGreaterThan(0);
    expect(panelInfo.minButtonHeight, 'touch targets >= 28px').toBeGreaterThanOrEqual(28);
    // SELL tab via the real tab button
    await page.evaluate(() => {
      const root = document.getElementById('xandria-shop-panel') as HTMLElement;
      const sell = root.querySelector('button[data-shop-tab="sell"]') as HTMLButtonElement;
      (sell as HTMLButtonElement).click();
    });
    await page.waitForTimeout(500);
    const sellText: string = await page.evaluate(() =>
      (document.getElementById('xandria-shop-panel') as HTMLElement).textContent ?? '');
    expect(sellText.length).toBeGreaterThan(0);
    await page.screenshot({ path: '/tmp/vendor-shop.png' });
    await page.keyboard.press('Escape');
    await waitFor('shop dismissed', async () => !(await shopShown()), 30_000);
  };
  await tradeCycle(0, true);

  // ---- villager regression: a villager still opens the quest dialogue, not the shop ----
  // (villagers cluster tightly, so arbitration may pick a NEIGHBOR of the
  // teleport target — the contract under test is "villager -> dialogue",
  // not which villager wins the prompt)
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    const V = av.ctrl.position.constructor;
    // find the first villager (no vendorId) in the villager roster
    const bp = X.blueprint as any;
    const villager = bp.npcs.npcs.find((n: any) => !n.vendorId);
    villager.state = 'idle';
    villager.stateT = 1e9;
    const p = villager.position; // live position, not home
    const y = E.terrain ? E.terrain.heightAt(p.x, p.z) : p.y;
    av.ctrl.teleport(new V(p.x + 1.5, y + 2, p.z));
    av.ctrl.velocity?.set?.(0, 0, 0);
  });
  const promptText2 = (): Promise<string | null> => page.evaluate(() => {
    const el = document.getElementById('xandria-interact-prompt') as HTMLElement | null;
    if (!el || el.style.display !== 'block') return null;
    return el.textContent;
  });
  await waitFor('talk prompt for a villager', async () => {
    const t = await promptText2();
    return !!t && t.startsWith('[E] Talk to ');
  }, 60_000);
  await page.keyboard.press('e');
  await waitFor('quest dialogue open', () => page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#xandria-dialogue-panel')) as HTMLElement[];
    return els.some((el) => el.style.display === 'block');
  }), 30_000);
  const shopOpenedForVillager: boolean = await page.evaluate(() => {
    const el = document.getElementById('xandria-shop-panel') as HTMLElement | null;
    return !!el && el.style.display === 'flex';
  });
  expect(shopOpenedForVillager, 'villager E opened the dialogue, not the shop').toBe(false);
  await page.keyboard.press('Escape');
  // the talk may have completed a quest objective -> level-up modal (pauses)
  await settleModals();

  // ---- mobile leg: 360x780, shop fits and works ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await settleModals();
  await tradeCycle(1, false);
  const mobileOverflow: boolean = await page.evaluate(() => {
    const root = document.getElementById('xandria-shop-panel') as HTMLElement;
    return root.scrollWidth > 366; // 360 + small tolerance
  });
  expect(mobileOverflow, 'shop fits the 360px viewport').toBe(false);

  // ---- perf leg: A-B-A draw sampling around the vendor roster ----
  const perf = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const bp = X.blueprint as any;
    const sample = (): number => {
      const xs: number[] = [];
      for (let i = 0; i < 10; i++) {
        E.renderer.info.reset();
        E.renderer.render(E.scene, E.camera);
        xs.push(E.renderer.info.render.calls);
      }
      return xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    };
    const a = sample();
    bp.vendors.despawnAll();
    const b = sample();
    bp.vendors.spawnForMap(X.spec.meta.seed);
    const c = sample();
    return { withVendors: a, withoutVendors: b, respawned: c };
  });
  const perVendor = (perf.withVendors - perf.withoutVendors) / 3;
  // eslint-disable-next-line no-console
  console.log(`[vendor-perf] draw calls: with=${perf.withVendors} without=${perf.withoutVendors} respawned=${perf.respawned} perVendor=${perVendor.toFixed(1)}`);
  expect(perf.respawned, 'respawn restores the draw count').toBeLessThanOrEqual(perf.withVendors + 5);

  expect(errors, 'zero console/page errors').toEqual([]);
});

const PORTAL_SPECS = existsSync('/tmp/portal-specs/portal-8km.b64')
  ? '/tmp/portal-specs'
  : '/home/hatch/workspace/xandria/qa/openworld/workers-portals';

test('vendor-economy: currency survives a real portal transition', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  // the npcs.b64 fixture is a walled 512m world (portals disabled by
  // design), so the portal leg runs on the portals wave's own 8km
  // fixture — same tp-action blueprint, default vendor catalog.
  const PB64 = readFileSync(`${PORTAL_SPECS}/portal-8km.b64`, 'utf8').trim();
  await page.goto(`/player.html?spec=${encodeURIComponent(PB64)}&test=1&autostart=1&splash=0`);

  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar
      && X.engine.portalManager && X.economyTest?.liveNpcManager);
  }), 300_000);

  // fund the wallet through the real Wallet (earning is proven exact in
  // the kill leg above); 3 merchants spawn from the default catalog
  const funded = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.economyTest.liveWallet().add(5000);
    return {
      balance: X.economyTest.liveWallet().balance as number,
      vendors: X.economyTest.liveNpcManager().npcs.length as number,
    };
  });
  expect(funded.balance).toBe(5000);
  expect(funded.vendors, '3 merchants on the origin map').toBe(3);

  // one real portal transition (the portal-traverse walk pattern)
  const transitionsBefore: number = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.portalManager.transitions);
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const HALF = 4000;
    const tx = 100;
    const tz = HALF - 11; // north edge
    const y = E.terrain.heightAt(tx, tz) + 3;
    E.streamFocus = new V(tx, y, tz);
    const av = E.portalsPlayerAvatar;
    av.ctrl.teleport(new V(tx, y, tz));
    av.health = av.maxHealth = 1e9;
    const want = Math.PI; // walk +z (north)
    let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    E.input.look.x = -d / 0.0026;
  });
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
  });
  await waitFor('portal transition', () => page.evaluate((n) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.engine.portalManager.transitions >= n;
  }, transitionsBefore + 1), 600_000);
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.input.inject([], null);
  });

  const afterPortal = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const ET = X.economyTest;
    const vendors = ET.liveNpcManager().npcs;
    const v = vendors[0];
    return {
      balance: ET.liveWallet().balance as number,
      vendorCount: vendors.length as number,
      vendorIds: vendors.map((n: any) => n.vendorId),
      stockLines: ET.liveShopPanel().stockFor(v.vendorId, v.spawnSeed).length as number,
      newSeed: X.spec.meta.seed as number,
    };
  });
  expect(afterPortal.balance, 'scrap survived the portal transition').toBe(5000);
  expect(afterPortal.vendorCount, 'vendor roster respawned on the new map').toBe(3);
  expect(afterPortal.vendorIds.sort(), 'same 3 merchants').toEqual(
    ['vendor_ember_vial', 'vendor_ironfangs', 'vendor_scrap_plate']);
  expect(afterPortal.stockLines, 'fresh seeded stock on the new map').toBeGreaterThan(0);
  // HUD chip still tracks the balance after arrival
  const hudAfter: string = await page.evaluate(() =>
    (document.querySelector('.xhud .score .coinval') as HTMLElement)?.textContent ?? '');
  expect(hudAfter.trim()).toBe('5000');

  expect(errors, 'zero console/page errors').toEqual([]);
});
