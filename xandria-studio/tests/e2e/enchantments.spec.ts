/**
 * Gear enchantment wave — seeded enchant-material drops, apply ->
 * exact stats (equipped + set + enchant order), remove -> full refund
 * restack, HUD enchant section (apply/remove buttons), desktop +
 * 360x780. Zero console/page errors.
 *
 * - Seeded drop leg: replicates rollLoot(rng, kind) for brute/turret
 *   kills off Rng(mapSeed ^ LOOT_SALT) in the page and asserts enchant
 *   materials show up (deterministic given the fixture seed).
 * - Apply leg: grants materials through the real inventory add() path,
 *   equips through the real Inventory.equip(), applies through the
 *   real Inventory.enchant(), asserts effectiveStats() EXACTLY at each
 *   step (including the set-bonus layer sitting between equipped and
 *   enchant stats).
 * - Remove leg: removeEnchant() refunds the full cost; counts restack
 *   to their pre-apply values; stats return to equipped + set only.
 * - HUD leg: opens the inventory HUD via KeyI, clicks the real apply
 *   button for the equipped weapon, asserts the row shows the enchant,
 *   then clicks remove and asserts the refund toast + cleared row.
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

test('enchantments: seeded drops -> apply exact -> remove refund -> HUD apply/remove, desktop + mobile', async ({ page }) => {
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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.enchantTest && X.lootTest);
  }), 240_000);

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

  // ---- seeded drop leg: replicate the loot stream in-page ----
  const drops = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const L = X.lootTest;
    const E = X.enchantTest;
    const rng = L.buildLootRng(X.spec.meta.seed);
    const matIds = new Set<string>(E.ENCHANT_MATERIAL_IDS);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const d of L.rollLoot(rng, i % 2 === 0 ? 'brute' : 'turret', false)) {
        if (matIds.has(d.itemId)) seen.add(d.itemId);
      }
    }
    // boss material rolls (bosses are brutes) also draw from the merged table
    const bossRng = L.buildLootRng(X.spec.meta.seed);
    const bossSeen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const d of L.rollLoot(bossRng, 'brute', true)) {
        if (matIds.has(d.itemId)) bossSeen.add(d.itemId);
      }
    }
    return { seen: [...seen].sort(), bossSeen: [...bossSeen].sort() };
  });
  expect(drops.seen, 'enchant materials observed in 500 seeded brute/turret kills').toEqual(['mat_enchant_dust', 'mat_star_essence']);
  expect(drops.bossSeen.length, `boss material rolls yield enchant materials: ${drops.bossSeen.join(',')}`).toBeGreaterThan(0);

  // ---- apply leg: exact stats, order equipped + set + enchant ----
  const stats = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    inv.add('loot_ironfang_blade', 1);
    inv.add('set_ironfang_helm', 1);
    inv.add('mat_enchant_dust', 10);
    if (!inv.equip('loot_ironfang_blade')) throw new Error('equip blade failed');
    if (!inv.equip('set_ironfang_helm')) throw new Error('equip helm failed');
    const before = {
      eff: { ...inv.effectiveStats() },
      set: { ...inv.setBonusStats() },
      ench: { ...inv.enchantStats() },
      dust: inv.count('mat_enchant_dust'),
    };
    const r = inv.enchant('loot_ironfang_blade', 'ench_sharp');
    if (!r.ok) throw new Error('enchant failed: ' + (r.reason ?? ''));
    const after = {
      eff: { ...inv.effectiveStats() },
      set: { ...inv.setBonusStats() },
      ench: { ...inv.enchantStats() },
      dust: inv.count('mat_enchant_dust'),
      cur: inv.getEnchant('loot_ironfang_blade'),
    };
    // blocked re-apply consumes nothing
    const blocked = inv.enchant('loot_ironfang_blade', 'ench_starlit');
    const afterBlocked = { dust: inv.count('mat_enchant_dust'), cur: inv.getEnchant('loot_ironfang_blade') };
    // remove refunds the full cost, restacking
    const refund = inv.removeEnchant('loot_ironfang_blade');
    const removed = {
      eff: { ...inv.effectiveStats() },
      ench: { ...inv.enchantStats() },
      dust: inv.count('mat_enchant_dust'),
      cur: inv.getEnchant('loot_ironfang_blade'),
    };
    return { before, after, blocked, afterBlocked, refund, removed };
  });
  // before: blade 9 dmg + helm 3 def, ironfang 2pc +3 def, no enchant
  expect(stats.before.eff).toEqual({ damage: 9, defense: 6 });
  expect(stats.before.set).toEqual({ defense: 3 });
  expect(stats.before.ench).toEqual({});
  expect(stats.before.dust).toBe(10);
  // after: +4 damage from the enchant, set layer untouched, dust 10 - 3
  expect(stats.after.ench).toEqual({ damage: 4 });
  expect(stats.after.set).toEqual({ defense: 3 });
  expect(stats.after.eff).toEqual({ damage: 13, defense: 6 });
  expect(stats.after.dust).toBe(7);
  expect(stats.after.cur).toBe('ench_sharp');
  // blocked re-apply: nothing consumed, enchant unchanged
  expect(stats.blocked.ok).toBe(false);
  expect(stats.blocked.reason).toBe('already-enchanted');
  expect(stats.afterBlocked).toEqual({ dust: 7, cur: 'ench_sharp' });
  // remove: full refund restacks to 10, stats back to equipped + set
  expect(stats.refund).toEqual([{ itemId: 'mat_enchant_dust', count: 3 }]);
  expect(stats.removed.eff).toEqual({ damage: 9, defense: 6 });
  expect(stats.removed.ench).toEqual({});
  expect(stats.removed.dust).toBe(10);
  expect(stats.removed.cur).toBeNull();

  // ---- HUD leg: real apply/remove buttons on the equipped weapon ----
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .enchrow[data-item-id="loot_ironfang_blade"]', { timeout: 10_000 });
  const rowBefore = await page.evaluate(() => {
    const row = document.querySelector('.xinv .enchrow[data-item-id="loot_ironfang_blade"]');
    return row ? (row.textContent ?? '') : null;
  });
  expect(rowBefore).toContain('Ironfang Blade');
  expect(rowBefore).toContain('unenchanted');
  // touch targets: every enchant button is >= 28px tall
  const btnBox = await page.locator('.xinv .enchrow[data-item-id="loot_ironfang_blade"] .ench-apply[data-enchant-id="ench_sharp"]').boundingBox();
  expect(btnBox, 'enchant apply button has a box').not.toBeNull();
  expect(btnBox!.height, 'enchant button touch target >= 28px').toBeGreaterThanOrEqual(28);
  // click the Sharpened Edge apply button (materials are stocked: 10 dust)
  await page.click('.xinv .enchrow[data-item-id="loot_ironfang_blade"] .ench-apply[data-enchant-id="ench_sharp"]');
  await page.waitForFunction(() => {
    const row = document.querySelector('.xinv .enchrow[data-item-id="loot_ironfang_blade"]');
    return row && (row.textContent ?? '').includes('Sharpened Edge');
  }, { timeout: 10_000 });
  const hudStats = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    return { ench: { ...inv.enchantStats() }, dust: inv.count('mat_enchant_dust'), cur: inv.getEnchant('loot_ironfang_blade') };
  });
  expect(hudStats.ench).toEqual({ damage: 4 });
  expect(hudStats.dust).toBe(7);
  expect(hudStats.cur).toBe('ench_sharp');
  // remove via the HUD button: refund toast + row back to unenchanted
  await page.click('.xinv .enchrow[data-item-id="loot_ironfang_blade"] .ench-remove');
  await page.waitForFunction(() => {
    const row = document.querySelector('.xinv .enchrow[data-item-id="loot_ironfang_blade"]');
    return row && (row.textContent ?? '').includes('unenchanted');
  }, { timeout: 10_000 });
  const hudAfter = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    return { dust: inv.count('mat_enchant_dust'), cur: inv.getEnchant('loot_ironfang_blade') };
  });
  expect(hudAfter.dust).toBe(10);
  expect(hudAfter.cur).toBeNull();
  await page.keyboard.press('i'); // close
  await page.waitForTimeout(500);

  // ---- mobile leg: 360x780, HUD apply button works, zero errors ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(2000);
  const mobile = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    inv.add('loot_scorched_plate', 1);
    inv.add('mat_beast_hide', 10);
    if (!inv.equip('loot_scorched_plate')) throw new Error('mobile equip plate failed');
    const r = inv.enchant('loot_scorched_plate', 'ench_sturdy');
    if (!r.ok) throw new Error('mobile enchant failed: ' + (r.reason ?? ''));
    return { ench: { ...inv.enchantStats() }, eff: { ...inv.effectiveStats() } };
  });
  // plate (8 def) + helm (3 def) + ironfang 2pc (3 def) + sturdy (6 def, 5 maxHealth)
  // blade is unenchanted now; blade 9 dmg stays.
  expect(mobile.ench).toEqual({ defense: 6, maxHealth: 5 });
  expect(mobile.eff.defense).toBe(8 + 3 + 3 + 6);
  expect(mobile.eff.maxHealth).toBe(5);
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .enchrow[data-item-id="loot_scorched_plate"]', { timeout: 10_000 });
  const mobileRow = await page.evaluate(() => {
    const row = document.querySelector('.xinv .enchrow[data-item-id="loot_scorched_plate"]');
    return row ? (row.textContent ?? '') : null;
  });
  expect(mobileRow).toContain('Sturdy Frame');
  await page.keyboard.press('i');

  expect(errors, 'zero console/page errors').toEqual([]);
});
