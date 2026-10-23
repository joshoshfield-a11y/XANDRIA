/**
 * Inventory-qol wave — filters, sort, junk marking, mass actions, sell.
 * Desktop + 360x780, zero console/page errors.
 *
 * - Boot leg: the deterministic "Forgotten Valley" fixture (seed 20261012,
 *   same as the vendor/loot specs); items granted straight into the live
 *   backpack (the collect path is covered by items-loot.spec.ts).
 * - Filter leg: type/rarity/tier selects narrow the visible cells
 *   client-side; the backpack model is untouched.
 * - Sort leg: rarity / power / newest reorder the cells; newest reflects
 *   acquisition order, not wall-clock.
 * - Junk leg: junk-mode click + right-click toggle the JUNK badge; the
 *   marked item is NOT equipped by the junk-mode click.
 * - Sell leg: sell-all-junk through the real vendor-economy wallet path
 *   (DEFAULT_SELL_MULT); the wallet gains EXACTLY the per-unit
 *   floor(value*sellMult) sum; unsellable junk is skipped honestly.
 * - Destroy leg: destroy-all-junk with inline confirm removes the items.
 * - Perf leg: renderer.info.render.calls with the HUD open vs closed —
 *   the HUD is DOM-only, so the delta must be 0.
 * - Mobile leg (360x780): panel fits the viewport, toolbar controls are
 *   >=28px, filter round-trip works.
 * - Zero console/page errors throughout.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// "Forgotten Valley" tp-action spec, seed 20261012 — the same
// deterministic scene the enemies/crafting/loot/vendor specs use.
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function boot(page: any, errors: string[], viewport?: { width: number; height: number }) {
  if (viewport) await page.setViewportSize(viewport);
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

  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const av = E.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9; // the bot must survive stray aggro
    const V = av.ctrl.position.constructor;
    const y = E.terrain ? E.terrain.heightAt(150, 150) : 0;
    av.ctrl.teleport(new V(150, y + 2, 150));
    av.ctrl.velocity?.set?.(0, 0, 0);
    // grant the QoL test items straight into the live backpack
    const inv = X.blueprint.itemKit.inventory;
    inv.add('loot_ironfang_blade', 1);
    inv.add('mat_ore', 5);
    inv.add('craft_ember_blade', 1);
    inv.add('loot_surge_tonic', 2);
    // a valueless key item exercises the unsellable-skip path (every real
    // catalog def has a positive value, so it is injected for the test)
    X.spec.custom.items.defs['test_valueless'] = {
      name: 'Worthless Pebble', type: 'key', rarity: 'common', stack: 1,
      description: 'A pebble of no value to anyone.',
    };
    inv.add('test_valueless', 1);
  });
}

const openInventory = (page: any) =>
  page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.lootTest.liveInventoryHud().open();
    return X.lootTest.liveInventoryHud().isOpen();
  });

/** visible backpack cell names in display order */
const cellNames = (page: any): Promise<string[]> =>
  page.evaluate(() => {
    const cells = [...document.querySelectorAll('.xinv .grid .cell')] as HTMLElement[];
    return cells
      .filter((c) => c.style.display !== 'none')
      .map((c) => c.querySelector('.nm')?.textContent ?? '');
  });

/** set the nth toolbar select by value */
const setSelect = (page: any, n: number, value: string) =>
  page.evaluate(([i, v]: [number, string]) => {
    const sels = [...document.querySelectorAll('.xinv .tools select')] as HTMLSelectElement[];
    sels[i].value = v;
    sels[i].dispatchEvent(new Event('change', { bubbles: true }));
  }, [n, value] as [number, string]);

const clickButton = (page: any, text: string) =>
  page.evaluate((t: string) => {
    const btns = [...document.querySelectorAll('.xinv button')] as HTMLButtonElement[];
    const b = btns.find((x) => x.textContent === t);
    if (!b) throw new Error(`button "${t}" not found`);
    b.click();
  }, text);

/** click the visible cell showing a given item name */
const clickCell = (page: any, name: string, button: 'left' | 'right' = 'left') =>
  page.evaluate(([n, btn]: [string, string]) => {
    const cells = [...document.querySelectorAll('.xinv .grid .cell')] as HTMLElement[];
    const cell = cells.find(
      (c) => c.style.display !== 'none' && c.querySelector('.nm')?.textContent === n,
    );
    if (!cell) throw new Error(`cell "${n}" not found`);
    cell.dispatchEvent(new MouseEvent(btn === 'right' ? 'contextmenu' : 'click', { bubbles: true }));
  }, [name, button] as [string, string]);

test('inventory-qol: filters / sort / junk / sell / destroy round-trip', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await boot(page, errors);
  expect(await openInventory(page)).toBe(true);

  // ---- perf leg: the HUD is DOM-only — opening it must not add GL draws
  const drawDelta: number = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const E = X.engine;
    const hud = X.lootTest.liveInventoryHud();
    const sample = (): number => {
      const xs: number[] = [];
      for (let i = 0; i < 10; i++) {
        E.renderer.info.reset();
        E.renderer.render(E.scene, E.camera);
        xs.push(E.renderer.info.render.calls);
      }
      return xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    };
    hud.close();
    const closed = sample();
    hud.open();
    const opened = sample();
    hud.close();
    (window as any).__drawDelta = opened - closed;
    return opened - closed;
  });
  expect(drawDelta, 'HUD open adds no draw calls (DOM overlay)').toBe(0);

  await openInventory(page);

  // ---- filter leg: type
  await setSelect(page, 0, 'weapon');
  expect(await cellNames(page)).toEqual(['Ironfang Blade', 'Ember Blade']);
  // rarity
  await setSelect(page, 0, 'all');
  await setSelect(page, 1, 'rare');
  expect(await cellNames(page)).toEqual(['Ember Blade']);
  // tier: raw = mat_* namespace
  await setSelect(page, 1, 'all');
  await setSelect(page, 2, 'raw');
  expect(await cellNames(page)).toEqual(['Iron Ore']);
  // tier: crafted = craft_* namespace
  await setSelect(page, 2, 'crafted');
  expect(await cellNames(page)).toEqual(['Ember Blade']);
  // combined type+rarity
  await setSelect(page, 2, 'all');
  await setSelect(page, 0, 'weapon');
  await setSelect(page, 1, 'uncommon');
  expect(await cellNames(page)).toEqual(['Ironfang Blade']);
  // reset
  await setSelect(page, 0, 'all');
  await setSelect(page, 1, 'all');
  expect(await cellNames(page)).toEqual([
    'Ironfang Blade', 'Iron Ore', 'Ember Blade', 'Surge Tonic', 'Worthless Pebble',
  ]);

  // ---- sort leg
  await setSelect(page, 3, 'rarity');
  expect((await cellNames(page))[0]).toBe('Ember Blade'); // the only rare
  await setSelect(page, 3, 'power');
  expect((await cellNames(page))[0]).toBe('Ember Blade'); // highest power score
  await setSelect(page, 3, 'newest');
  expect((await cellNames(page))[0]).toBe('Worthless Pebble'); // added last
  await setSelect(page, 3, 'default');

  // ---- junk leg: junk-mode click marks without equipping
  await clickButton(page, 'Mark junk: off');
  await clickCell(page, 'Iron Ore');
  const junkState: { marked: boolean; equippedWeapon: string | null; badge: boolean } =
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const inv = X.blueprint.itemKit.inventory;
      const cells = [...document.querySelectorAll('.xinv .grid .cell')] as HTMLElement[];
      const ore = cells.find((c) => c.querySelector('.nm')?.textContent === 'Iron Ore')!;
      return {
        marked: inv.isJunk('mat_ore'),
        equippedWeapon: inv.getEquipped('weapon'),
        badge: !!ore.querySelector('.jk'),
      };
    });
  expect(junkState.marked).toBe(true);
  expect(junkState.equippedWeapon).toBeNull(); // junk-mode click did NOT equip
  expect(junkState.badge).toBe(true);
  await clickButton(page, 'Mark junk: on'); // toggle mode back off
  // right-click toggles too
  await clickCell(page, 'Surge Tonic', 'right');
  const tonicJunk: boolean = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.blueprint.itemKit.inventory.isJunk('loot_surge_tonic');
  });
  expect(tonicJunk).toBe(true);
  // the valueless key item is junk too, so the sell leg exercises the
  // unsellable-skip path ("(1 unsellable skipped)")
  await clickCell(page, 'Worthless Pebble', 'right');
  const pebbleJunk: boolean = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.blueprint.itemKit.inventory.isJunk('test_valueless');
  });
  expect(pebbleJunk).toBe(true);

  // ---- sell leg: exact scrap math through the real wallet path
  await clickButton(page, 'Sell junk');
  const sellPreview: { text: string; expectedTotal: number; balanceBefore: number } =
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const ET = X.economyTest;
      const defs = X.spec.custom.items.defs;
      const inv = X.blueprint.itemKit.inventory;
      let total = 0;
      for (const id of inv.junkItemIds()) {
        const def = defs[id];
        const sellable = def && Number.isFinite(def.value) && def.value > 0;
        if (sellable) total += ET.unitSellPrice(def, ET.DEFAULT_SELL_MULT) * inv.count(id);
      }
      const label = document.querySelector('.xinv .confirm span')?.textContent ?? '';
      return { text: label, expectedTotal: total, balanceBefore: ET.liveWallet().balance };
    });
  // 5 ore x max(1,floor(2*0.3)) + 2 tonic x floor(30*0.3) = 5*1 + 2*9 = 23
  expect(sellPreview.expectedTotal).toBe(23);
  expect(sellPreview.text).toMatch(/Sell 7 junk for 23 scrap\? \(1 unsellable skipped\)/);
  await clickButton(page, 'Confirm');
  const sellResult: { balanceAfter: number; ore: number; tonic: number; pebble: number; junk: string[] } =
    await page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const inv = X.blueprint.itemKit.inventory;
      return {
        balanceAfter: X.economyTest.liveWallet().balance,
        ore: inv.count('mat_ore'),
        tonic: inv.count('loot_surge_tonic'),
        pebble: inv.count('test_valueless'),
        junk: inv.junkItemIds(),
      };
    });
  expect(sellResult.balanceAfter - sellPreview.balanceBefore).toBe(23);
  expect(sellResult.ore).toBe(0);
  expect(sellResult.tonic).toBe(0);
  expect(sellResult.pebble).toBe(1); // unsellable skipped, kept
  expect(sellResult.junk).toEqual(['test_valueless']); // sold flags pruned

  // ---- destroy leg: the unsellable pebble goes via destroy-all-junk
  await clickButton(page, 'Destroy junk');
  const destroyText: string = await page.evaluate(
    () => document.querySelector('.xinv .confirm span')?.textContent ?? '',
  );
  expect(destroyText).toMatch(/Destroy 1 junk item\?/);
  await clickButton(page, 'Confirm');
  const destroyResult: { pebble: number; junk: string[] } = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    return { pebble: inv.count('test_valueless'), junk: inv.junkItemIds() };
  });
  expect(destroyResult.pebble).toBe(0);
  expect(destroyResult.junk).toEqual([]);

  // cancel path: mark, cancel, nothing happens
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.blueprint.itemKit.inventory.add('mat_ore', 2);
    X.blueprint.itemKit.inventory.setJunk('mat_ore', true);
  });
  await clickButton(page, 'Destroy junk');
  await clickButton(page, 'Cancel');
  const cancelResult: { ore: number; junk: string[] } = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    return { ore: inv.count('mat_ore'), junk: inv.junkItemIds() };
  });
  expect(cancelResult.ore).toBe(2);
  expect(cancelResult.junk).toEqual(['mat_ore']);

  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.lootTest.liveInventoryHud().close();
  });
  expect(errors).toEqual([]);
});

test('inventory-qol: 360x780 mobile layout', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await boot(page, errors, { width: 360, height: 780 });
  expect(await openInventory(page)).toBe(true);

  // panel fits the viewport
  const box = await page.evaluate(() => {
    const p = document.querySelector('.xinv .panel') as HTMLElement;
    const r = p.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(360);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(780);

  // every toolbar control meets the 28px touch-target floor
  const heights: number[] = await page.evaluate(() =>
    [...document.querySelectorAll('.xinv .tools select, .xinv .actions button')]
      .map((el) => (el as HTMLElement).getBoundingClientRect().height),
  );
  expect(heights.length).toBeGreaterThanOrEqual(8); // 4 selects + 4 buttons
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(28);

  // filter round-trip works on mobile
  await setSelect(page, 0, 'consumable');
  expect(await cellNames(page)).toEqual(['Surge Tonic']);
  await setSelect(page, 0, 'all');
  expect((await cellNames(page)).length).toBe(5);

  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.lootTest.liveInventoryHud().close();
  });
  expect(errors).toEqual([]);
});
