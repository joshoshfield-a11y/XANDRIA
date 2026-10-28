/**
 * Gear loadout presets wave — save -> change gear -> apply (exact equip
 * + set bonus), missing-item apply, rename/delete (seam + real HUD),
 * combat guard (real aggro), portal round-trip preserve, reload preserve,
 * desktop + 360x780. Zero console/page errors.
 *
 * Fixture: the proven 8km portal fixture (crafting-portal pattern) with
 * an empty item table injected so the blueprint builds the item kit
 * uniformly; set-piece defs arrive via ensureSetItemDefs at build time.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(
    readFileSync(resolve(HERE, 'fixtures/portal-8km.b64'), 'utf8').trim(), 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

const HALF = 4000;
const IRONFANG = ['loot_ironfang_blade', 'set_ironfang_helm', 'loot_scorched_plate', 'set_ironfang_greaves'];
const EMBER_BLADE = 'craft_ember_blade';

type X = { __XANDRIA__?: any };

test('loadout-presets: save/apply exact + set bonus, missing-item, rename/delete, combat guard, portal + reload preserve', async ({ page }) => {
  test.setTimeout(1_800_000);
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
  const boot = async () => {
    await waitFor('boot', () => page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      return !!(X?.engine?.portalManager && X.engine.portalsPlayerAvatar && X.engine.state === 'playing'
        && X?.loadoutTest && X?.lootTest?.liveInventory());
    }), 240_000);
    await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const av = X.engine.portalsPlayerAvatar;
      av.health = av.maxHealth = 1e9; // the bot must survive stray aggro
      const V = av.ctrl.position.constructor;
      const y = X.engine.terrain ? X.engine.terrain.heightAt(150, 150) : 0;
      av.ctrl.teleport(new V(150, y + 2, 150));
      av.ctrl.velocity?.set?.(0, 0, 0);
    });
  };
  await boot();

  // Defs the wave depends on must exist in the live spec defs table.
  const defCheck = await page.evaluate((ids) => {
    const X = (window as unknown as X).__XANDRIA__;
    const defs = X.loadoutTest.liveDefs();
    return ids.map((id) => ({ id, ok: !!defs[id], slot: defs[id]?.slot ?? null }));
  }, [...IRONFANG, EMBER_BLADE]);
  for (const d of defCheck) expect(d.ok, `live def exists: ${d.id}`).toBe(true);
  expect(defCheck.map((d) => d.slot)).toEqual(['weapon', 'head', 'torso', 'legs', 'weapon']);

  const equipped = () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    const out: Record<string, string | null> = {};
    for (const s of ['weapon', 'head', 'torso', 'legs', 'accessory']) out[s] = inv.getEquipped(s);
    return out;
  });
  const grant = (ids: string[]) => page.evaluate((ids) => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    for (const id of ids) inv.add(id, 1);
  }, ids);

  // ---- seam leg: save -> change gear -> apply -> exact equip + set bonus ----
  await grant(IRONFANG);
  const saved = await page.evaluate((pieces) => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    for (const id of pieces) if (!inv.equip(id)) throw new Error('equip failed: ' + id);
    const ok = X.loadoutTest.saveLive(0);
    const rack = X.loadoutTest.liveLoadouts();
    return { ok, rack, set: { ...inv.setBonusStats() }, eff: { ...inv.effectiveStats() } };
  }, IRONFANG);
  expect(saved.ok).toBe(true);
  expect(saved.rack[0].equipped).toEqual({
    weapon: 'loot_ironfang_blade', head: 'set_ironfang_helm',
    torso: 'loot_scorched_plate', legs: 'set_ironfang_greaves',
  });
  expect(saved.set).toEqual({ defense: 3, damage: 8, maxHealth: 15 });

  // Change gear entirely, then apply: exact equip + exact set bonus return.
  await grant([EMBER_BLADE]);
  const applied = await page.evaluate((ember) => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    for (const s of ['weapon', 'head', 'torso', 'legs', 'accessory']) inv.unequip(s);
    if (!inv.equip(ember)) throw new Error('equip ember failed');
    const before = { ...inv.effectiveStats() };
    const result = X.loadoutTest.applyLive(0);
    return { result, before, set: { ...inv.setBonusStats() }, eff: { ...inv.effectiveStats() } };
  }, EMBER_BLADE);
  expect(applied.result.ok).toBe(true);
  expect(applied.result.missing).toEqual([]);
  expect(applied.result.blocked).toEqual([]);
  expect(applied.before.damage ?? 0).not.toBe(applied.eff.damage); // gear actually changed
  expect(applied.set).toEqual({ defense: 3, damage: 8, maxHealth: 15 });
  expect(await equipped()).toEqual({
    weapon: 'loot_ironfang_blade', head: 'set_ironfang_helm',
    torso: 'loot_scorched_plate', legs: 'set_ironfang_greaves', accessory: null,
  });

  // ---- missing-item leg: helm removed from the world -> apply reports it, equips the rest ----
  const missing = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    // Save a 2-piece snapshot (blade + helm) into slot 1.
    for (const s of ['weapon', 'head', 'torso', 'legs', 'accessory']) inv.unequip(s);
    if (!inv.equip('loot_ironfang_blade')) throw new Error('equip blade failed');
    if (!inv.equip('set_ironfang_helm')) throw new Error('equip helm failed');
    X.loadoutTest.saveLive(1);
    // Lose the helm entirely: unequip + remove from backpack (the live
    // inventory object is the real Inventory — remove() is its backpack
    // primitive, the same one mass-destroy uses).
    inv.unequip('head');
    const removed = inv.remove('set_ironfang_helm', 1);
    const result = X.loadoutTest.applyLive(1);
    return { result, removed, weapon: inv.getEquipped('weapon'), head: inv.getEquipped('head'), set: { ...inv.setBonusStats() } };
  });
  expect(missing.removed, 'helm removed from backpack').toBe(1);
  expect(missing.result.missing.map((m: any) => m.slot)).toEqual(['head']);
  expect(missing.weapon).toBe('loot_ironfang_blade');
  expect(missing.head).toBeNull();
  expect(missing.set).toEqual({});
  // Restore the helm for the remaining legs.
  await grant(['set_ironfang_helm']);

  // ---- rename / delete via seam ----
  const renamed = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const ok = X.loadoutTest.renameLive(1, 'Boss Set');
    const rack = X.loadoutTest.liveLoadouts();
    const cleared = X.loadoutTest.clearLive(1);
    const after = X.loadoutTest.liveLoadouts();
    return { ok, name: rack[1].name, cleared, afterName: after[1].name, afterEquipped: after[1].equipped };
  });
  expect(renamed.ok).toBe(true);
  expect(renamed.name).toBe('Boss Set');
  expect(renamed.cleared).toBe(true);
  expect(renamed.afterName).toBe('Loadout 2');
  expect(renamed.afterEquipped).toEqual({});

  // ---- HUD leg: rows, save, rename, apply, delete-with-confirm, touch targets ----
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .loadrow', { timeout: 10_000 });
  const hudRows = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xinv .loadrow')];
    return rows.map((r) => ({
      index: r.getAttribute('data-loadout-index'),
      name: (r.querySelector('.ln')?.textContent ?? ''),
      summary: (r.querySelector('.ls')?.textContent ?? ''),
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent),
    }));
  });
  expect(hudRows).toHaveLength(3);
  expect(hudRows[0].name).toBe('Loadout 1');
  expect(hudRows[0].summary).toContain('4/5 pieces');
  expect(hudRows[0].buttons).toEqual(['Apply', 'Save current set', 'Rename', 'Delete']);

  // UI save into empty slot 2 with only the ember blade equipped.
  await page.evaluate((ember) => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    for (const s of ['weapon', 'head', 'torso', 'legs', 'accessory']) inv.unequip(s);
    if (!inv.equip(ember)) throw new Error('equip ember failed');
  }, EMBER_BLADE);
  await page.locator('.xinv .loadrow[data-loadout-index="2"] .load-save').click();
  await page.waitForFunction(() => {
    const row = document.querySelector('.xinv .loadrow[data-loadout-index="2"]');
    return (row?.querySelector('.ls')?.textContent ?? '').includes('1/5 pieces');
  }, undefined, { timeout: 10_000 });

  // UI rename slot 2.
  await page.locator('.xinv .loadrow[data-loadout-index="2"] .load-rename').click();
  await page.waitForSelector('.xinv .loadrow[data-loadout-index="2"] input', { timeout: 10_000 });
  await page.locator('.xinv .loadrow[data-loadout-index="2"] input').fill('UI Set');
  await page.locator('.xinv .loadrow[data-loadout-index="2"] .load-rename-confirm').click();
  await page.waitForFunction(() => {
    const row = document.querySelector('.xinv .loadrow[data-loadout-index="2"]');
    return (row?.querySelector('.ln')?.textContent ?? '') === 'UI Set';
  }, undefined, { timeout: 10_000 });

  // UI apply slot 2: gear changes to ember-only.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    if (!inv.equip('loot_ironfang_blade')) throw new Error('equip blade failed');
  });
  await page.locator('.xinv .loadrow[data-loadout-index="2"] .load-apply').click();
  await page.waitForFunction((ember) => {
    const X = (window as unknown as any).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    return inv.getEquipped('weapon') === ember && inv.getEquipped('head') === null;
  }, EMBER_BLADE, { timeout: 10_000 });

  // UI delete slot 2 with the inline confirm (Cancel path first, then Confirm).
  await page.locator('.xinv .loadrow[data-loadout-index="2"] .load-delete').click();
  await page.waitForSelector('.xinv .confirm', { timeout: 10_000 });
  const confirmText = await page.locator('.xinv .confirm').innerText();
  expect(confirmText).toContain('Delete loadout "UI Set"');
  await page.locator('.xinv .confirm button', { hasText: 'Cancel' }).click();
  const stillNamed = await page.evaluate(() =>
    document.querySelector('.xinv .loadrow[data-loadout-index="2"] .ln')?.textContent ?? '');
  expect(stillNamed).toBe('UI Set');
  await page.locator('.xinv .loadrow[data-loadout-index="2"] .load-delete').click();
  await page.waitForSelector('.xinv .confirm', { timeout: 10_000 });
  await page.locator('.xinv .confirm button', { hasText: 'Confirm' }).click();
  await page.waitForFunction(() => {
    const row = document.querySelector('.xinv .loadrow[data-loadout-index="2"]');
    return (row?.querySelector('.ln')?.textContent ?? '') === 'Loadout 3'
      && (row?.querySelector('.ls')?.textContent ?? '') === 'empty';
  }, undefined, { timeout: 10_000 });
  await page.keyboard.press('i'); // close the HUD

  // ---- combat guard leg: real aggro refuses apply (seam + HUD toast), despawn re-allows ----
  // The bot idles far from the seeded roster, so aggro is not left to
  // chance: teleport next to the nearest live enemy (re-seeking while
  // calm) until Engine.inCombat() reports hostile enemies.
  const combat = await page.evaluate(async () => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const M = X.lootTest.liveManager();
    const av = E.portalsPlayerAvatar;
    const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const V = av.ctrl.position.constructor;
    const t0 = Date.now();
    let seeks = 0;
    while (!E.inCombat() && Date.now() - t0 < 60_000) {
      const alive = (M.enemies as any[]).filter((e) => e.alive);
      if (alive.length === 0) break;
      let best = alive[0];
      let bd = Infinity;
      for (const e of alive) {
        const dx = e.position.x - av.ctrl.position.x;
        const dz = e.position.z - av.ctrl.position.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = e; }
      }
      const y = E.terrain ? E.terrain.heightAt(best.position.x, best.position.z) : best.position.y;
      av.ctrl.teleport(new V(best.position.x + 3, y + 2, best.position.z + 3));
      av.ctrl.velocity?.set?.(0, 0, 0);
      seeks++;
      await waitMs(5000);
    }
    return { inCombat: E.inCombat(), seeks, enemies: (M.enemies as any[]).length };
  });
  expect(combat.inCombat, 'live enemies aggro the bot (combat state reached)').toBe(true);
  const refused = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const inv = X.lootTest.liveInventory();
    const before: Record<string, string | null> = {};
    for (const s of ['weapon', 'head', 'torso', 'legs', 'accessory']) before[s] = inv.getEquipped(s);
    const result = X.loadoutTest.applyLive(0);
    const after: Record<string, string | null> = {};
    for (const s of ['weapon', 'head', 'torso', 'legs', 'accessory']) after[s] = inv.getEquipped(s);
    return { result, before, after };
  });
  expect(refused.result.ok).toBe(false);
  expect(refused.result.reason).toBe('in-combat');
  expect(refused.after).toEqual(refused.before);
  // HUD toast refusal while in combat.
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .loadrow', { timeout: 10_000 });
  await page.locator('.xinv .loadrow[data-loadout-index="0"] .load-apply').click();
  await page.waitForFunction(() => {
    const msg = document.querySelector('.xinv .msg');
    return (msg?.textContent ?? '').includes('combat');
  }, undefined, { timeout: 10_000 });
  await page.keyboard.press('i');
  // Calm down: despawn the live roster (difficulty-modes pattern), apply works again.
  const calmed = await page.evaluate(async () => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    X.lootTest.liveManager().despawnAll();
    const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while (E.inCombat() && Date.now() - t0 < 30_000) await waitMs(500);
    const result = X.loadoutTest.applyLive(0);
    const inv = X.lootTest.liveInventory();
    return { inCombat: E.inCombat(), ok: result.ok, set: { ...inv.setBonusStats() } };
  });
  expect(calmed.inCombat).toBe(false);
  expect(calmed.ok).toBe(true);
  expect(calmed.set).toEqual({ defense: 3, damage: 8, maxHealth: 15 });

  const rackBeforePortal = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return JSON.stringify(X.loadoutTest.liveLoadouts());
  });
  const equipBeforePortal = await equipped();

  // ---- portal leg: real round-trip (crafting-portal walk pattern) ----
  const walkThrough = async (edge: 'N' | 'S', fromTransitions: number) => {
    await page.evaluate(([edge, half]) => {
      const X = (window as unknown as X).__XANDRIA__;
      const E = X.engine;
      const V = E.camera.position.constructor;
      const tx = 100;
      const tz = edge === 'N' ? half - 11 : -(half - 11);
      const y = E.terrain.heightAt(tx, tz) + 3;
      E.streamFocus = new V(tx, y, tz);
      const av = E.portalsPlayerAvatar;
      av.ctrl.teleport(new V(tx, y, tz));
      const want = edge === 'N' ? Math.PI : 0;
      let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      E.input.look.x = -d / 0.0026;
    }, [edge, HALF] as const);
    await page.waitForTimeout(8000);
    await page.evaluate(() => {
      (window as unknown as X).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
    });
    await waitFor(`transition to ${fromTransitions + 1}`, () => page.evaluate((n) => {
      const X = (window as unknown as X).__XANDRIA__;
      return X.engine.portalManager.transitions >= n && !X.engine.portalManager.transitioning;
    }, fromTransitions + 1), 300_000);
    await page.evaluate(() => {
      (window as unknown as X).__XANDRIA__.engine.input.inject([], null);
    });
    await waitFor('arrival playing', () => page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      return X.engine.state === 'playing' && !!X.engine.portalsPlayerAvatar;
    }), 120_000);
  };
  const coord = (): Promise<{ mx: number; my: number }> => page.evaluate(() => {
    const pm = (window as unknown as X).__XANDRIA__.engine.portalManager;
    return { mx: pm.coord.mx, my: pm.coord.my };
  });
  await walkThrough('N', 0);
  expect(await coord()).toEqual({ mx: 0, my: 1 });
  expect(await page.evaluate(() => JSON.stringify((window as unknown as X).__XANDRIA__.loadoutTest.liveLoadouts())))
    .toBe(rackBeforePortal);
  expect(await equipped()).toEqual(equipBeforePortal);
  await walkThrough('S', 1);
  expect(await coord()).toEqual({ mx: 0, my: 0 });
  expect(await page.evaluate(() => JSON.stringify((window as unknown as X).__XANDRIA__.loadoutTest.liveLoadouts())))
    .toBe(rackBeforePortal);
  expect(await equipped()).toEqual(equipBeforePortal);

  // ---- reload leg: the rack persists through a full page reload ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await boot();
  expect(await page.evaluate(() => JSON.stringify((window as unknown as X).__XANDRIA__.loadoutTest.liveLoadouts())))
    .toBe(rackBeforePortal);
  // And the persisted rack is still usable after reload.
  await grant(IRONFANG);
  const postReload = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const result = X.loadoutTest.applyLive(0);
    const inv = X.lootTest.liveInventory();
    return { ok: result.ok, set: { ...inv.setBonusStats() } };
  });
  expect(postReload.ok).toBe(true);
  expect(postReload.set).toEqual({ defense: 3, damage: 8, maxHealth: 15 });

  // ---- 360x780 leg: panel fits, loadout buttons >= 28px, no tracker overlap ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('i');
  await page.waitForSelector('.xinv .loadrow', { timeout: 10_000 });
  const mobile = await page.evaluate(() => {
    const panel = document.querySelector('.xinv .panel')!;
    const pr = panel.getBoundingClientRect();
    const btns = [...document.querySelectorAll('.xinv .loadrow button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent, w: r.width, h: r.height };
    });
    const tracker = document.querySelector('#xandria-quest-tracker');
    let trackerOverlap = false;
    let trackerVisible = false;
    if (tracker) {
      const tr = tracker.getBoundingClientRect();
      trackerVisible = tr.width > 0 && tr.height > 0 && getComputedStyle(tracker).visibility !== 'hidden';
      if (trackerVisible) {
        trackerOverlap = !(tr.right <= pr.left || tr.left >= pr.right || tr.bottom <= pr.top || tr.top >= pr.bottom);
      }
    }
    return {
      panel: { left: pr.left, right: pr.right, top: pr.top, bottom: pr.bottom, w: pr.width, h: pr.height },
      btns, trackerVisible, trackerOverlap,
    };
  });
  expect(mobile.panel.left).toBeGreaterThanOrEqual(0);
  expect(mobile.panel.right).toBeLessThanOrEqual(360);
  expect(mobile.panel.top).toBeGreaterThanOrEqual(0);
  expect(mobile.panel.bottom).toBeLessThanOrEqual(780);
  for (const b of mobile.btns) {
    expect(b.h, `loadout button "${b.text}" height >= 28px`).toBeGreaterThanOrEqual(28);
    expect(b.w, `loadout button "${b.text}" width >= 28px`).toBeGreaterThanOrEqual(28);
  }
  if (mobile.trackerVisible) expect(mobile.trackerOverlap, 'no quest-tracker / panel overlap').toBe(false);
  await page.keyboard.press('i');

  expect(errors, `zero console/page errors (got ${errors.join(' | ')})`).toEqual([]);
});
