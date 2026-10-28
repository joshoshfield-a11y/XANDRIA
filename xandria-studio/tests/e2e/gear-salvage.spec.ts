/**
 * Gear salvage wave — dismantle gear into crafting materials.
 *
 * - Table leg: one row per rarity, every yield id a real material def,
 *   SALVAGE_SALT distinct from the other wave salts (in-page, via seams).
 * - Tier legs: tier-1 (common), tier-2 (rare/epic) and legendary gear
 *   salvage through the real Inventory.salvage() to EXACT materials
 *   replicated in-page from the seeded per-unit stream (seq captured
 *   before each salvage); enchanted + set pieces pay refund + bonus.
 * - Equipped leg: equipped gear (even with backpack copies) is blocked
 *   with nothing consumed; unequip -> salvage works.
 * - Craft seam leg: salvaged fiber alone crafts recipe_trail_mix
 *   through the unchanged checkCraft/craft seam.
 * - Reload leg: serialize/restore (the PortalState reload path)
 *   preserves materials AND the salvage stream position.
 * - HUD legs: real Salvage 1 button + inline confirm, real Salvage
 *   junk button with skip note; equipped/kept junk untouched.
 * - Perf leg: INSTANCING.md A-B-A draw sampling — the DOM salvage
 *   section adds no WebGL draws (tolerance <= 2).
 * Desktop + 360x780. Zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// "Forgotten Valley" tp-action spec, seed 20261012 — the same
// deterministic scene the enemies/crafting/loot/set specs use.
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

type X = { __XANDRIA__?: any };

test('gear-salvage: table + tier exact yields + enchanted/set + HUD + reload, desktop + mobile', async ({ page }) => {
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
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.salvageTest && X.lootTest);
  }), 240_000);

  const hudOpen = () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!X.lootTest.liveInventoryHud?.()?.isOpen();
  });

  // ---- table leg: rows, material-only yields, salt distinctness ----
  const table = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const S = X.salvageTest;
    const defs = {
      ...X.craftingTest.materialItemDefs(),
      ...X.lootTest.lootItemDefs(),
      ...X.craftingTest.craftedItemDefs(),
      ...X.setTest.setGearDefs(),
      ...X.enchantTest.enchantMaterialDefs(),
    };
    const rows = S.SALVAGE_TABLE.map((r: any) => r.rarity).sort();
    const yieldIds = new Set<string>();
    for (const r of S.SALVAGE_TABLE) for (const l of r.yields) yieldIds.add(l.itemId);
    for (const l of S.SET_PIECE_SALVAGE_BONUS) yieldIds.add(l.itemId);
    const bad = [...yieldIds].filter((id) => !defs[id] || defs[id].type !== 'material');
    const rangedPerRow = S.SALVAGE_TABLE.map((r: any) => r.yields.filter((l: any) => l.max > l.min).length);
    const salts = new Set([
      S.SALVAGE_SALT, X.lootTest.LOOT_SALT, X.craftingTest.STATION_SALT,
      X.enemyTest?.ENEMY_SALT,
    ].filter((s) => s !== undefined));
    return { rows, bad, rangedPerRow, saltCount: salts.size, saltExpected: 4 };
  });
  expect(table.rows).toEqual(['common', 'epic', 'legendary', 'rare', 'uncommon']);
  expect(table.bad, 'every salvage yield id is a real material def').toEqual([]);
  expect(table.rangedPerRow).toEqual([1, 1, 1, 1, 1]);
  expect(table.saltCount).toBe(table.saltExpected);

  // ---- perf leg: DOM salvage section adds no WebGL draws (A-B-A) ----
  // Runs before the teleport: post-teleport camera drift moves the draw
  // count on its own (diagnosed 2026-10-20). Grant one salvageable
  // piece first so the SALVAGE section actually renders in leg B.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.lootTest.liveInventory().add('craft_fiber_weave', 1);
  });
  const sampleDraws = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await page.evaluate(() =>
        (window as unknown as X).__XANDRIA__.engine.renderer.info.render.calls));
      await page.waitForTimeout(1200);
    }
    return out;
  };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const closed1 = median(await sampleDraws(5));
  await page.keyboard.press('i');
  await waitFor('inventory opens for perf leg', hudOpen, 30_000);
  const open1 = median(await sampleDraws(5));
  await page.keyboard.press('i');
  await waitFor('inventory closes for perf leg', async () => !(await hudOpen()), 30_000);
  const closed2 = median(await sampleDraws(5));
  console.log(`[gear-salvage] A-B-A draws: closed1=${closed1} open1=${open1} closed2=${closed2}`);
  expect(Math.abs(open1 - closed1), 'DOM salvage panel adds no WebGL draws (open)').toBeLessThanOrEqual(2);
  expect(Math.abs(closed2 - open1), 'DOM salvage panel adds no WebGL draws (close)').toBeLessThanOrEqual(2);

  const setup = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const av = X.engine.portalsPlayerAvatar;
    av.health = av.maxHealth = 1e9; // the bot must survive stray aggro
    const V = av.ctrl.position.constructor;
    const y = X.engine.terrain ? X.engine.terrain.heightAt(150, 150) : 0;
    av.ctrl.teleport(new V(150, y + 2, 150));
    av.ctrl.velocity?.set?.(0, 0, 0);
    return { seed: X.spec.meta.seed as number, inv: !!X.lootTest.liveInventory() };
  });
  expect(setup.inv, 'blueprint wired itemKit.inventory').toBe(true);

  // ---- tier legs: exact replicated yields, seq captured per salvage ----
  const tiers = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const S = X.salvageTest;
    const inv = X.lootTest.liveInventory();
    const defs = {
      ...X.craftingTest.materialItemDefs(),
      ...X.lootTest.lootItemDefs(),
      ...X.craftingTest.craftedItemDefs(),
      ...X.setTest.setGearDefs(),
      ...X.enchantTest.enchantMaterialDefs(),
    };
    const replicate = (id: string, seq: number) =>
      S.rollSalvageYields(defs[id], S.buildSalvageRng(id, seq), { setPiece: S.isSetPiece(id) });
    const out: Array<{ id: string; seq: number; expected: any; got: any; before: Record<string, number>; after: Record<string, number> }> = [];
    // the perf-leg piece is still in the backpack; salvage it first so
    // the stream starts from a known position for this leg
    const perfSeq = inv.salvageCount();
    const perfExpected = replicate('craft_fiber_weave', perfSeq);
    const perfBefore: Record<string, number> = {};
    for (const y of perfExpected) perfBefore[y.itemId] = inv.count(y.itemId);
    const perfGot = inv.salvage('craft_fiber_weave');
    const perfAfter: Record<string, number> = {};
    for (const y of perfExpected) perfAfter[y.itemId] = inv.count(y.itemId);
    out.push({ id: 'craft_fiber_weave(perf)', seq: perfSeq, expected: perfExpected, got: perfGot.yields, before: perfBefore, after: perfAfter });
    for (const id of ['loot_ironfang_blade', 'loot_scorched_plate', 'loot_void_edge', 'loot_star_aegis']) {
      inv.add(id, 1);
      const seq = inv.salvageCount();
      const expected = replicate(id, seq);
      const before: Record<string, number> = {};
      for (const y of expected) before[y.itemId] = inv.count(y.itemId);
      const got = inv.salvage(id);
      const after: Record<string, number> = {};
      for (const y of expected) after[y.itemId] = inv.count(y.itemId);
      out.push({ id, seq, expected, got: got.yields, before, after });
    }
    return out;
  });
  for (const leg of tiers) {
    expect(leg.got, `${leg.id} yields match the seeded replication at seq ${leg.seq}`).toEqual(leg.expected);
    for (const y of leg.expected) {
      expect(leg.after[y.itemId] - leg.before[y.itemId], `${leg.id} grants ${y.count}× ${y.itemId}`).toBe(y.count);
    }
  }

  // ---- enchanted + set piece: refund + bonus, enchant cleared ----
  const enchanted = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    inv.add('mat_enchant_dust', 10);
    inv.add('set_ironfang_helm', 1);
    const applied = inv.enchant('set_ironfang_helm', 'ench_warded');
    if (!applied.ok) throw new Error('enchant failed: ' + (applied.reason ?? ''));
    const dustAfterEnchant = inv.count('mat_enchant_dust');
    const r = inv.salvage('set_ironfang_helm');
    return {
      dustAfterEnchant,
      dustAfterSalvage: inv.count('mat_enchant_dust'),
      yields: r.yields, enchantCleared: r.enchantCleared, setPiece: r.setPiece,
      enchantNow: inv.getEnchant('set_ironfang_helm'),
      helmLeft: inv.count('set_ironfang_helm'),
    };
  });
  expect(enchanted.dustAfterEnchant).toBe(7);
  expect(enchanted.dustAfterSalvage).toBe(10); // 3-dust refund restacks
  expect(enchanted.enchantCleared).toBe('ench_warded');
  expect(enchanted.setPiece).toBe(true);
  expect(enchanted.enchantNow).toBeNull();
  expect(enchanted.helmLeft).toBe(0);
  const eYields = new Map(enchanted.yields.map((y: any) => [y.itemId, y.count]));
  expect(eYields.get('mat_enchant_dust')).toBe(3);
  expect(eYields.get('mat_core_fragment')).toBe(1); // set bonus
  expect(eYields.get('mat_ember_shard')).toBe(2); // set bonus

  // ---- equipped leg: blocked with copies present, works after unequip ----
  const equipped = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    inv.add('loot_ironfang_blade', 2);
    if (!inv.equip('loot_ironfang_blade')) throw new Error('equip failed');
    const blocked = inv.salvage('loot_ironfang_blade');
    const countWhileEquipped = inv.count('loot_ironfang_blade');
    const unequipped = inv.unequip('weapon');
    const r = inv.salvage('loot_ironfang_blade');
    return { blocked, countWhileEquipped, unequipped, ok: r.ok, left: inv.count('loot_ironfang_blade') };
  });
  expect(equipped.blocked).toEqual(expect.objectContaining({ ok: false, reason: 'equipped' }));
  expect(equipped.countWhileEquipped).toBe(2);
  expect(equipped.unequipped).toBe(true);
  expect(equipped.ok).toBe(true);
  expect(equipped.left).toBe(1);

  // ---- craft seam leg: salvaged fiber alone crafts trail mix ----
  const crafted = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    const fiberBeforeLoop = inv.count('mat_fiber');
    for (let i = 0; i < 5; i++) {
      inv.add('craft_fiber_weave', 1);
      const r = inv.salvage('craft_fiber_weave');
      if (!r.ok) throw new Error('salvage failed: ' + (r.reason ?? ''));
    }
    const fiber = inv.count('mat_fiber');
    const defs = {
      ...X.craftingTest.materialItemDefs(),
      ...X.lootTest.lootItemDefs(),
      ...X.craftingTest.craftedItemDefs(),
      ...X.setTest.setGearDefs(),
      ...X.enchantTest.enchantMaterialDefs(),
    };
    const pool = X.craftingTest.buildRecipePool(X.spec);
    const check = X.craftingTest.checkCraft(pool, 'recipe_trail_mix', {
      inventory: inv, defs, enabled: true, stations: new Set(), level: 0,
    });
    let craftResult: any = null;
    if (check.ok) craftResult = X.craftingTest.craft(pool, 'recipe_trail_mix', {
      inventory: inv, defs, enabled: true, stations: new Set(), level: 0,
    });
    return { fiberBeforeLoop, fiber, checkOk: check.ok, checkReason: (check as any).reason ?? null, craftOk: craftResult?.ok ?? null, mix: inv.count('craft_trail_mix'), fiberAfter: inv.count('mat_fiber') };
  });
  // 1 fiber per common salvage, exactly; earlier legs already banked
  // fiber, so the loop must add exactly 5 and the craft consumes 5
  expect(crafted.fiber - crafted.fiberBeforeLoop).toBe(5);
  expect(crafted.checkOk).toBe(true);
  expect(crafted.craftOk).toBe(true);
  expect(crafted.mix).toBe(2);
  expect(crafted.fiberAfter).toBe(crafted.fiber - 5);

  // ---- reload leg: serialize/restore preserves materials + stream position ----
  const reload = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const S = X.salvageTest;
    const inv = X.lootTest.liveInventory();
    const snap = inv.serialize();
    const before = {
      seq: inv.salvageCount(),
      scrap: inv.count('mat_scrap'), ore: inv.count('mat_ore'), fiber: inv.count('mat_fiber'),
    };
    inv.restore(snap);
    const afterRestore = {
      seq: inv.salvageCount(),
      scrap: inv.count('mat_scrap'), ore: inv.count('mat_ore'), fiber: inv.count('mat_fiber'),
    };
    // next salvage must roll the NEXT stream position, not a repeat
    const defs = {
      ...X.craftingTest.materialItemDefs(),
      ...X.lootTest.lootItemDefs(),
      ...X.craftingTest.craftedItemDefs(),
      ...X.setTest.setGearDefs(),
      ...X.enchantTest.enchantMaterialDefs(),
    };
    inv.add('loot_scorched_plate', 1);
    const seq = inv.salvageCount();
    const expected = S.rollSalvageYields(defs['loot_scorched_plate'], S.buildSalvageRng('loot_scorched_plate', seq), { setPiece: S.isSetPiece('loot_scorched_plate') });
    const got = inv.salvage('loot_scorched_plate');
    return { before, afterRestore, seq, expected, got: got.yields };
  });
  expect(reload.afterRestore).toEqual(reload.before);
  expect(reload.got).toEqual(reload.expected);

  // ---- HUD leg: real Salvage 1 button + inline confirm (desktop) ----
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.lootTest.liveInventory().add('loot_war_helm', 1);
  });
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .salvrow[data-item-id="loot_war_helm"]', { timeout: 10_000 });
  const rowText = await page.evaluate(() => {
    const row = document.querySelector('.xinv .salvrow[data-item-id="loot_war_helm"]');
    return row ? (row.textContent ?? '') : null;
  });
  expect(rowText).toContain('War Helm');
  expect(rowText).toContain('Salvage →');
  const btnBox = await page.locator('.xinv .salvrow[data-item-id="loot_war_helm"] .salvage-one').boundingBox();
  expect(btnBox, 'salvage button has a box').not.toBeNull();
  expect(btnBox!.height, 'salvage button touch target >= 28px').toBeGreaterThanOrEqual(28);
  const hudBefore = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    return { ore: inv.count('mat_ore'), ember: inv.count('mat_ember_shard'), hide: inv.count('mat_beast_hide') };
  });
  await page.click('.xinv .salvrow[data-item-id="loot_war_helm"] .salvage-one');
  await page.waitForSelector('.xinv .confirm', { timeout: 10_000 });
  const confirmText = await page.evaluate(() => document.querySelector('.xinv .confirm')?.textContent ?? '');
  expect(confirmText).toContain('Salvage War Helm for');
  await page.click('.xinv .confirm button:has-text("Confirm")');
  await page.waitForFunction(() => !document.querySelector('.xinv .salvrow[data-item-id="loot_war_helm"]'), { timeout: 10_000 });
  const hudAfter = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    return { helm: inv.count('loot_war_helm'), ore: inv.count('mat_ore'), ember: inv.count('mat_ember_shard'), hide: inv.count('mat_beast_hide') };
  });
  expect(hudAfter.helm).toBe(0);
  expect(hudAfter.ore - hudBefore.ore).toBe(3); // rare row: ore 3
  expect(hudAfter.hide - hudBefore.hide).toBe(1); // rare row: hide 1
  expect(hudAfter.ember - hudBefore.ember).toBeGreaterThanOrEqual(2); // rare row: ember 2-3

  // ---- HUD salvage-junk leg: equipped + material junk skipped, gear salvaged ----
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    inv.add('craft_fiber_weave', 2);
    inv.add('mat_ore', 4);
    inv.add('loot_ironfang_blade', 1);
    if (!inv.equip('loot_ironfang_blade')) throw new Error('equip blade failed');
    inv.setJunk('craft_fiber_weave', true);
    inv.setJunk('mat_ore', true);
    inv.setJunk('loot_ironfang_blade', true);
  });
  const junkBtn = page.locator('.xinv .actions button:has-text("Salvage junk")');
  await junkBtn.click();
  await page.waitForSelector('.xinv .confirm', { timeout: 10_000 });
  const junkConfirm = await page.evaluate(() => document.querySelector('.xinv .confirm')?.textContent ?? '');
  expect(junkConfirm).toContain('Salvage 2 junk items');
  expect(junkConfirm).toContain('skipped');
  await page.click('.xinv .confirm button:has-text("Confirm")');
  await page.waitForFunction(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    return inv.count('craft_fiber_weave') === 0;
  }, { timeout: 10_000 });
  const junkAfter = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    return {
      weave: inv.count('craft_fiber_weave'), ore: inv.count('mat_ore'),
      blade: inv.count('loot_ironfang_blade'), equipped: inv.getEquipped('weapon'),
      weaveJunk: inv.isJunk('craft_fiber_weave'), oreJunk: inv.isJunk('mat_ore'),
    };
  });
  expect(junkAfter.weave).toBe(0);
  expect(junkAfter.ore).toBeGreaterThanOrEqual(4); // material junk untouched (yields may add ore)
  expect(junkAfter.blade).toBe(2); // 1 equipped + 1 backpack survivor from the equipped leg
  expect(junkAfter.equipped).toBe('loot_ironfang_blade');
  expect(junkAfter.weaveJunk).toBe(false); // pruned: nothing left
  expect(junkAfter.oreJunk).toBe(true); // kept: still owned
  await page.keyboard.press('i'); // close
  await page.waitForTimeout(500);

  // ---- mobile leg: 360x780, salvage row + button work ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.lootTest.liveInventory().add('craft_scrap_buckler', 1);
  });
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .salvrow[data-item-id="craft_scrap_buckler"]', { timeout: 10_000 });
  const mobileBox = await page.locator('.xinv .salvrow[data-item-id="craft_scrap_buckler"] .salvage-one').boundingBox();
  expect(mobileBox, 'mobile salvage button has a box').not.toBeNull();
  expect(mobileBox!.height, 'mobile salvage button >= 28px').toBeGreaterThanOrEqual(28);
  await page.click('.xinv .salvrow[data-item-id="craft_scrap_buckler"] .salvage-one');
  await page.waitForSelector('.xinv .confirm', { timeout: 10_000 });
  await page.click('.xinv .confirm button:has-text("Confirm")');
  await page.waitForFunction(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.lootTest.liveInventory().count('craft_scrap_buckler') === 0;
  }, { timeout: 10_000 });
  await page.keyboard.press('i');

  expect(errors, 'zero console/page errors').toEqual([]);
});
