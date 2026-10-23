/**
 * Gear set bonuses wave — equip -> exact bonus, unequip -> removed,
 * seeded set drops via test-seed replication, HUD set indicator,
 * desktop + 360x780. Zero console/page errors.
 *
 * - Seeded drop leg: replicates rollLoot(rng, kind) for 400 kills off
 *   Rng(mapSeed ^ LOOT_SALT) in the page and asserts set pieces show up
 *   (deterministic given the fixture seed) — the drop weighting is
 *   additive and seeded, never Math.random.
 * - Equip leg: grants set pieces through the real inventory add() path,
 *   equips through the real Inventory.equip(), asserts effectiveStats()
 *   EXACTLY (2pc -> threshold bonus; 4pc -> cumulative; unequip ->
 *   thresholds drop one at a time).
 * - HUD leg: opens the inventory HUD via KeyI, asserts the SET BONUSES
 *   section lists the set with pieces collected and ACTIVE thresholds.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// "Forgotten Valley" tp-action spec, seed 20261012 — the same
// deterministic scene the enemies/crafting/loot specs use.
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

type X = { __XANDRIA__?: any };

test('set-bonuses: seeded set drops -> equip 2pc/4pc exact -> unequip removes, desktop + mobile', async ({ page }) => {
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
    return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar && X.setTest && X.lootTest);
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
    const S = X.setTest;
    const rng = L.buildLootRng(X.spec.meta.seed);
    const kinds = ['walker', 'brute', 'drone', 'flyer', 'turret'];
    const setPieces = new Set<string>(S.SET_PIECE_IDS);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const d of L.rollLoot(rng, kinds[i % kinds.length], false)) {
        if (setPieces.has(d.itemId)) seen.add(d.itemId);
      }
    }
    return [...seen].sort();
  });
  expect(drops.length, `set pieces observed in 400 seeded kills: ${drops.join(',')}`).toBeGreaterThan(0);

  // ---- equip leg: exact 2pc / 4pc / unequip semantics ----
  const stats = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    const PIECES = ['loot_ironfang_blade', 'set_ironfang_helm', 'loot_scorched_plate', 'set_ironfang_greaves'];
    for (const id of PIECES) inv.add(id, 1);
    // 2 pieces -> exact 2pc threshold bonus (+3 defense)
    if (!inv.equip('loot_ironfang_blade')) throw new Error('equip blade failed');
    if (!inv.equip('set_ironfang_helm')) throw new Error('equip helm failed');
    const two = { eff: { ...inv.effectiveStats() }, set: { ...inv.setBonusStats() } };
    // 4 pieces -> cumulative 2pc + 4pc
    if (!inv.equip('loot_scorched_plate')) throw new Error('equip plate failed');
    if (!inv.equip('set_ironfang_greaves')) throw new Error('equip greaves failed');
    const four = { eff: { ...inv.effectiveStats() }, set: { ...inv.setBonusStats() } };
    // unequip the weapon -> 4pc drops, 2pc stays (3 pieces equipped)
    if (!inv.unequip('weapon')) throw new Error('unequip weapon failed');
    const three = { eff: { ...inv.effectiveStats() }, set: { ...inv.setBonusStats() } };
    return { two, four, three };
  });
  // ironfang 2pc: { defense: 3 } — blade (9 dmg) + helm (3 def) equipped
  expect(stats.two.set).toEqual({ defense: 3 });
  expect(stats.two.eff.damage).toBe(9);
  expect(stats.two.eff.defense).toBe(3 + 3);
  // ironfang 4pc: { defense: 3, damage: 8, maxHealth: 15 }
  expect(stats.four.set).toEqual({ defense: 3, damage: 8, maxHealth: 15 });
  expect(stats.four.eff.damage).toBe(9 + 8);
  expect(stats.four.eff.defense).toBe((3 + 8 + 3) + 3); // helm+plate+greaves + 2pc
  expect(stats.four.eff.maxHealth).toBe(15);
  // 3 pieces: 4pc removed, 2pc stays (weapon gone -> no damage key at all)
  expect(stats.three.set).toEqual({ defense: 3 });
  expect(stats.three.eff.damage ?? 0).toBe(0);
  expect(stats.three.eff.defense).toBe(3 + 8 + 3 + 3); // helm+plate+greaves + 2pc

  // ---- HUD leg: set indicator shows pieces collected + active thresholds ----
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .setrow', { timeout: 10_000 });
  const hudText = await page.evaluate(() => {
    const row = document.querySelector('.xinv .setrow[data-set-id="ironfang_raider"]');
    return row ? (row.textContent ?? '') : null;
  });
  expect(hudText, 'ironfang_raider row present').not.toBeNull();
  expect(hudText).toContain('Ironfang Raider');
  expect(hudText).toContain('4/4 owned');   // all four pieces in backpack+equipped
  expect(hudText).toContain('3/4 equipped'); // weapon back in the backpack
  expect(hudText).toContain('ACTIVE');
  expect(hudText).toContain('2-PC: +3 defense');
  await page.keyboard.press('i'); // close
  await page.waitForTimeout(500);

  // ---- final unequip leg: bonus fully gone when below every threshold ----
  const one = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    if (!inv.unequip('head')) throw new Error('unequip head failed');
    if (!inv.unequip('legs')) throw new Error('unequip legs failed');
    return {
      set: { ...inv.setBonusStats() },
      eff: { ...inv.effectiveStats() },
      plain: { ...inv.equippedStats() },
    };
  });
  expect(one.set).toEqual({});
  expect(one.eff).toEqual(one.plain); // effective == plain equipped stats

  // ---- mobile leg: 360x780, equip cycle + HUD, zero errors ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(2000);
  const mobile = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    inv.add('set_emberforged_cowl', 1);
    inv.add('set_emberforged_sabatons', 1);
    if (!inv.equip('set_emberforged_cowl')) throw new Error('mobile equip cowl failed');
    if (!inv.equip('set_emberforged_sabatons')) throw new Error('mobile equip sabatons failed');
    return { set: { ...inv.setBonusStats() }, eff: { ...inv.effectiveStats() } };
  });
  // emberforged 2pc: { damage: 6 } — additive on top of the equipped
  // piece stats (plate 8 + cowl 5 + sabatons 5 defense stays in the math).
  expect(mobile.set).toEqual({ damage: 6 });
  expect(mobile.eff.damage).toBe(6);
  expect(mobile.eff.defense).toBe(8 + 5 + 5);
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .setrow[data-set-id="emberforged"]', { timeout: 10_000 });
  const mobileHud = await page.evaluate(() => {
    const row = document.querySelector('.xinv .setrow[data-set-id="emberforged"]');
    return row ? (row.textContent ?? '') : null;
  });
  expect(mobileHud).toContain('Emberforged');
  expect(mobileHud).toContain('ACTIVE');
  await page.keyboard.press('i');

  expect(errors, 'zero console/page errors').toEqual([]);
});
