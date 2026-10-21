/**
 * Master-crafting wave — live player page e2e (desktop AND 360x780,
 * zero console/page errors).
 *
 * Flow: boot the deterministic "Forgotten Valley" scene (seed 20261012,
 * tp-action) with an empty custom.items table injected -> despawn
 * NPCs/enemies for a clean prompt field -> all 4 master recipes are in
 * the seeded pool (buildRecipePool's rank-3 always-include rule) ->
 * SkillsPanel shows them LOCKED at rank 1 -> earn smithing rank 3 via
 * the real SkillSystem -> panel shows UNLOCKED -> teleport to the forge,
 * [E], click the warbrand row's CRAFT (ingredients seeded into the live
 * inventory) -> queue completes -> craft_starfall_warbrand lands with
 * exact stats (damage 18 / crit 6 / epic) -> equip via the real
 * Inventory.equip() (weapon slot) -> draw-call sample panel closed vs
 * open (DOM-only UI: expect no WebGL draw change) -> mobile 360x780
 * leg: panel fits, master rows render.
 *
 * Hardening (per workers-crafting/C.md): the player is teleported to the
 * station (never the reverse), all waits poll from Node, and the prompt
 * is read via the session's promptedNode (pill text goes stale under
 * SwiftShader's slow frames). CRAFT clicks use force:true like the
 * skills spec (SwiftShader actionability flakes, documented there).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint
// builds the item kit (ensureCraftingItemDefs fills the crafting defs at
// boot; crafting is enabled by default).
const B64 = (() => {
  const spec = JSON.parse(Buffer.from(RAW, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
})();

test('master-craft: rank 3 -> unlock -> craft -> equip, desktop + mobile', async ({ page }) => {
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
      await page.waitForTimeout(2000);
    }
  };
  await waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X?.gatheringTest && X?.craftingTest && X?.skillsTest?.liveSkills?.()
      && X?.blueprint?.stations && X?.blueprint?.itemKit && X.engine.state === 'playing'
      && X.engine.portalsPlayerAvatar);
  }), 240_000);

  // Clean prompt field: NPCs/enemies are not under test here; despawn so
  // the [E] target is unambiguous and the bot isn't mauled mid-craft.
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const skillsOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-skills-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  const panelText = (): Promise<string> => page.evaluate(() =>
    document.getElementById('xandria-skills-panel')?.textContent ?? '');
  const skillRank = (id: string): Promise<number> => page.evaluate((sid) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().rankOf(sid), id);

  // ---- perf: the skills panel is DOM-only — no WebGL draw change ----
  // (INSTANCING.md method: renderer.info.render.calls, median of samples.
  // Runs here — before any teleport — because the post-teleport camera
  // drifts the draw count on its own (diagnosed 2026-10-20: 211→198→210
  // with zero panel interaction). A-B-A alternation guards residual drift.)
  const sampleDraws = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await page.evaluate(() =>
        (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.renderer.info.render.calls));
      await page.waitForTimeout(1200);
    }
    return out;
  };
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const closed1 = median(await sampleDraws(5));
  await page.keyboard.press('k');
  await waitFor('skills panel opens for perf leg', skillsOpen, 30_000);
  const open1 = median(await sampleDraws(5));
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes for perf leg', async () => !(await skillsOpen()), 30_000);
  const closed2 = median(await sampleDraws(5));
  console.log(`[master-craft] A-B-A draws: closed1=${closed1} open1=${open1} closed2=${closed2}`);
  expect(Math.abs(open1 - closed1), 'DOM panel adds no WebGL draws (open)').toBeLessThanOrEqual(2);
  expect(Math.abs(closed2 - open1), 'DOM panel adds no WebGL draws (close)').toBeLessThanOrEqual(2);

  // ---- masters ride the seeded pool regardless of poolSize ----
  const masterIds = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const pool = X.craftingTest.buildRecipePool(X.spec);
    return pool.filter((r: any) => (r.minSkillRank ?? 0) >= 3).map((r: any) => r.id);
  });
  expect(masterIds).toContain('recipe_starfall_warbrand');
  expect(masterIds).toContain('recipe_dragonscale_aegis');
  expect(masterIds).toContain('recipe_primordial_draught');
  expect(masterIds).toContain('recipe_wildheart_regalia');
  console.log(`[master-craft] masters in pool: ${masterIds.join(',')}`);

  // ---- panel at rank 1: all four masters LOCKED ----
  await page.keyboard.press('k');
  await waitFor('skills panel opens', skillsOpen, 30_000);
  const tLocked = await panelText();
  for (const name of ['Starfall Warbrand', 'Dragonscale Aegis', 'Primordial Draught', 'Wildheart Regalia']) {
    expect(tLocked, `${name} locked at rank 1`).toContain(`LOCKED — ${name}`);
  }
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- earn smithing rank 3 through the real SkillSystem ----
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().addXp('smithing', 240);
  });
  expect(await skillRank('smithing')).toBe(3);
  await page.keyboard.press('k');
  await waitFor('skills panel re-opens', skillsOpen, 30_000);
  const tOpen = await panelText();
  expect(tOpen, 'warbrand unlocked at smithing 3').toContain('UNLOCKED — Starfall Warbrand');
  expect(tOpen, 'aegis unlocked at smithing 3').toContain('UNLOCKED — Dragonscale Aegis');
  expect(tOpen, 'draught still locked (alchemy 1)').toContain('LOCKED — Primordial Draught');
  expect(tOpen, 'regalia still locked (foraging 1)').toContain('LOCKED — Wildheart Regalia');
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- seed the live inventory with the warbrand ingredients ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    inv.add('craft_ember_blade', 1);
    inv.add('mat_core_fragment', 3);
    inv.add('mat_ember_shard', 2);
  });

  // ---- teleport to the forge, [E], click the warbrand CRAFT ----
  const forgePos = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const stations = X.craftingTest.liveStations().stations as any[];
    const forge = stations.find((s: any) => s.stationId === 'station_forge');
    return forge ? { x: forge.root.position.x, y: forge.root.position.y, z: forge.root.position.z } : null;
  });
  expect(forgePos, 'expected a forge in the roster').toBeTruthy();
  const stationPromptText = (): Promise<string | null> => page.evaluate(() => {
    const els = document.querySelectorAll('#xandria-interact-prompt');
    const el = els[0] as HTMLElement | null;
    if (!el || el.style.display !== 'block') return null;
    return el.textContent;
  });
  const craftPanelOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-crafting-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  await page.evaluate(([x, y, z]) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
  }, [forgePos!.x, forgePos!.y, forgePos!.z]);
  await waitFor('station prompt', async () => {
    const t = await stationPromptText();
    return !!t && t.includes('Use ');
  }, 60_000);
  await page.keyboard.press('e');
  await waitFor('crafting panel opens', craftPanelOpen, 30_000);
  const warbrandIndex = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.craftingTest.buildRecipePool(X.spec).findIndex((r: any) => r.id === 'recipe_starfall_warbrand');
  });
  expect(warbrandIndex, 'warbrand is a pool row').toBeGreaterThanOrEqual(0);
  const countOf = (id: string): Promise<number> => page.evaluate((i) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.itemKit.inventory.count(i), id);
  // NOTE: force:true — CRAFT buttons are provably visible/enabled, but
  // Playwright actionability flakes under SwiftShader (documented in the
  // skills spec). The force click still dispatches the real handler.
  await page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(warbrandIndex).click({ force: true, timeout: 15000 });
  await waitFor('warbrand lands in inventory', async () => (await countOf('craft_starfall_warbrand')) === 1, 240_000);
  expect(await countOf('craft_ember_blade'), 'tier-2 output consumed').toBe(0);
  expect(await countOf('mat_core_fragment'), 'loot mats consumed').toBe(0);
  expect(await countOf('mat_ember_shard'), 'loot mats consumed').toBe(0);
  await page.keyboard.press('Escape');
  await waitFor('crafting panel closes', async () => !(await craftPanelOpen()), 30_000);

  // ---- exact stat assertions on the master output def ----
  const stats = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const d = X.spec.custom.items.defs['craft_starfall_warbrand'];
    return { stats: d.stats, rarity: d.rarity, slot: d.slot, name: d.name };
  });
  expect(stats.name).toBe('Starfall Warbrand');
  expect(stats.stats).toEqual({ damage: 18, crit: 6 });
  expect(stats.rarity).toBe('epic');
  expect(stats.slot).toBe('weapon');
  // honestly above tier-2: Ember Blade is 14/3
  const t2 = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return X.spec.custom.items.defs['craft_ember_blade'].stats;
  });
  expect(stats.stats.damage).toBeGreaterThan(t2.damage);
  expect(stats.stats.crit).toBeGreaterThan(t2.crit);

  // ---- equip through the real Inventory.equip() ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.lootTest.liveInventory().equip('craft_starfall_warbrand');
  });
  const equipped = await page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.lootTest.liveInventory().getEquipped('weapon'));
  expect(equipped).toBe('craft_starfall_warbrand');

  // ---- mobile leg: 360x780, panel fits, master rows render ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await page.locator('#xandria-skills-chip').click({ force: true, timeout: 15000 });
  await waitFor('skills panel opens on mobile', skillsOpen, 30_000);
  const box = await page.evaluate(() => {
    const el = document.getElementById('xandria-skills-panel') as HTMLElement | null;
    return el ? el.getBoundingClientRect().toJSON() : null;
  });
  expect(box, 'panel has a box on mobile').toBeTruthy();
  expect(box!.left, 'panel fits horizontally at 360px').toBeGreaterThanOrEqual(0);
  expect(box!.right, 'panel fits horizontally at 360px').toBeLessThanOrEqual(360);
  expect(box!.bottom, 'panel fits vertically at 780px').toBeLessThanOrEqual(780);
  const tm = await panelText();
  expect(tm).toContain('UNLOCKED — Starfall Warbrand');
  expect(tm).toContain('LOCKED — Primordial Draught');
  await page.screenshot({ path: '/tmp/master-craft-panel-mobile.png' });
  await page.keyboard.press('Escape');

  expect(errors, 'zero console/page errors').toEqual([]);
});
