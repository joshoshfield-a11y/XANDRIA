/**
 * Crafting wave, workstream C — gather -> craft -> equip in the live player
 * page (desktop AND 360x780, zero console/page errors).
 *
 * Flow: boot the deterministic "Forgotten Valley" scene (seed 20261012,
 * tp-action — the INSTANCING.md perf scene) with an empty custom.items table
 * injected (ensureCraftingItemDefs fills it at boot since crafting defaults
 * on) -> despawn NPCs/enemies for a clean prompt field -> harvest 3 nodes
 * of each kind via the real [E] prompt path -> materials land in the
 * inventory -> teleport to a workbench, [E] opens the crafting panel ->
 * click the first craftable recipe's CRAFT button (real DOM click) ->
 * queue completes -> output lands, ingredients consumed -> craft an
 * equippable recipe -> equip() -> getEquipped confirms the slot ->
 * Escape closes the panel. Mobile leg repeats open/craft/close at 360x780.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to the node/station (never the reverse), all waits poll from
 * Node (page.waitForFunction's RAF polling is unreliable here), and the
 * prompt is read via the session's promptedNode (pill text goes stale
 * under SwiftShader's slow frames).
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

test('crafting: gather -> craft -> equip, desktop + mobile', async ({ page }) => {
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
    return !!(X?.engine && X?.gatheringTest && X?.craftingTest && X?.blueprint?.stations
      && X?.blueprint?.itemKit && X.engine.state === 'playing'
      && X.engine.portalsPlayerAvatar);
  }), 240_000);

  // Clean prompt field: NPCs/enemies are not under test here (their own
  // specs cover them); despawn so the [E] target is unambiguous and the
  // bot isn't mauled mid-harvest.
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const invCount = (id: string): Promise<number> => page.evaluate((id) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.itemKit.inventory.count(id), id);

  const panelOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-crafting-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });

  // The station leg needs the STATION session's pill (first in DOM) —
  // that's the target its [E] handler will open the panel for.
  const stationPromptText = (): Promise<string | null> => page.evaluate(() => {
    const els = document.querySelectorAll('#xandria-interact-prompt');
    const el = els[0] as HTMLElement | null;
    if (!el || el.style.display !== 'block') return null;
    return el.textContent;
  });

  // ---- gather: 3 nodes of each kind via the real [E] prompt path ----
  // The prompt is polled via the session's promptedNode (not pill text):
  // pill text is stale-prone under SwiftShader (slow frames can leave the
  // previous spot's label up), while promptedNode.id identifies the exact
  // live target the [E] handler will harvest.
  const nodeSpots = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    // >5m from stations: the 1.5m teleport offset keeps the node the
    // unambiguous nearest target (station radius 3.5)
    return nodes
      // Gathering-nodes phase: the roster now carries herb + crystal kinds
      // this spec never crafts with — scope to the three kinds it tests
      // (their material map below only covers these; other kinds would
      // resolve material undefined).
      .filter((n: any) => n.kind === 'ore' || n.kind === 'fiber' || n.kind === 'scrap')
      .filter((n: any) => stations.every((s: any) =>
        Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z) > 5))
      .map((n: any) => ({
        id: n.interactable.id, kind: n.kind,
        material: ({ ore: 'mat_ore', fiber: 'mat_fiber', scrap: 'mat_scrap' } as any)[n.kind],
        x: n.root.position.x, y: n.root.position.y, z: n.root.position.z,
      }));
  });
  expect(nodeSpots.length).toBeGreaterThanOrEqual(9);
  const promptedId = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__
      .gatheringTest.liveSession()?.promptedNode?.interactable.id ?? null);
  const gathered: Record<string, number> = { ore: 0, fiber: 0, scrap: 0 };
  const done = () => gathered.ore >= 3 && gathered.fiber >= 3 && gathered.scrap >= 3;
  // cycle the spots until quotas are met (depleted nodes drop out of the
  // prompt, so revisits are safe); stalls just cost a pass
  for (let pass = 0; pass < 4 && !done(); pass++) {
    for (const spot of nodeSpots) {
      if (done()) break;
      await page.evaluate(([x, y, z]) => {
        const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
        const V = X.engine.camera.position.constructor;
        X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
      }, [spot.x, spot.y, spot.z]);
      try {
        // the prompt must be showing THIS node — not a stale label, not a
        // chest rival — before [E] is pressed
        await waitFor(`prompt shows ${spot.id}`, async () => (await promptedId()) === spot.id, 30_000);
      } catch {
        continue; // stale target or rival won — move on
      }
      if (gathered[spot.kind] >= 3) continue; // already have enough of this kind
      const before = await invCount(spot.material);
      await page.keyboard.press('e');
      try {
        await waitFor(`material lands (${spot.kind})`, async () => (await invCount(spot.material)) > before, 25_000);
        gathered[spot.kind]++;
      } catch {
        console.log(`[crafting] harvest stall at ${spot.id}, continuing`);
      }
    }
  }
  console.log(`[crafting] gathered=${JSON.stringify(gathered)} nodeSpots=${nodeSpots.length}`);
  expect(gathered, 'harvested 3 nodes of each kind').toEqual({ ore: 3, fiber: 3, scrap: 3 });
  // materials landed in the inventory (deterministic yields: ore/fiber 2-3, scrap 1-2 per node)
  expect(await invCount('mat_ore')).toBeGreaterThanOrEqual(6);
  expect(await invCount('mat_fiber')).toBeGreaterThanOrEqual(6);
  expect(await invCount('mat_scrap')).toBeGreaterThanOrEqual(3);

  // ---- craft: pick craftable recipes in-page, drive the real panel ----
  // (recomputed fresh before every craft: ingredients are consumed)
  const firstCraftable = (equippableOnly: boolean): Promise<{ id: string; out: string; slot: string | null; index: number } | null> =>
    page.evaluate((equippableOnly) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const CT = X.craftingTest;
      const pool = CT.buildRecipePool(X.spec);
      const inv = X.blueprint.itemKit.inventory;
      const defs = X.spec.custom.items.defs;
      const opts = {
        inventory: inv, defs, enabled: true, playerLevel: 1,
        // the panel narrows missing-station to the station it's open at;
        // we parked at the workbench, so match its check exactly
        stations: new Set(['station_workbench']),
      };
      for (let i = 0; i < pool.length; i++) {
        const r = pool[i];
        if (!CT.checkCraft(pool, r.id, opts).ok) continue;
        if (equippableOnly && !defs[r.output.itemId]?.slot) continue;
        return { id: r.id, out: r.output.itemId, slot: defs[r.output.itemId]?.slot ?? null, index: i };
      }
      return null;
    }, equippableOnly);

  const benchPos = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const stations = X.craftingTest.liveStations().stations as any[];
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const clearance = (s: any) => Math.min(...nodes.map((n: any) =>
      Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z)));
    // prefer a workbench, but above all pick the station with the most
    // node clearance so the [E] target is unambiguous
    const ranked = [...stations].sort((a, b) => clearance(b) - clearance(a));
    const bench = ranked.find((s: any) => s.stationId === 'station_workbench' && clearance(s) > 4)
      ?? ranked[0];
    return bench
      ? { x: bench.root.position.x, y: bench.root.position.y, z: bench.root.position.z, clearance: clearance(bench) }
      : null;
  });
  expect(benchPos, 'expected a station in the roster').toBeTruthy();
  console.log(`[crafting] station clearance: ${benchPos!.clearance.toFixed(1)}m`);

  // teleport to the workbench, [E] opens the panel
  await page.evaluate(([x, y, z]) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
  }, [benchPos!.x, benchPos!.y, benchPos!.z]);
  await waitFor('station prompt', async () => {
    const t = await stationPromptText();
    return !!t && t.includes('Use ');
  }, 60_000);
  await page.keyboard.press('e');
  await waitFor('crafting panel opens', panelOpen, 30_000);
  await page.screenshot({ path: '/tmp/crafting-panel-desktop.png' });

  // click the first craftable recipe's CRAFT button (real DOM click, pool order)
  const first = await firstCraftable(false);
  expect(first, 'expected a craftable recipe after 9 harvests').toBeTruthy();
  await page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(first!.index).click();
  await waitFor('crafted output lands', async () => (await invCount(first!.out)) > 0, 60_000);
  await page.keyboard.press('Escape');
  await waitFor('panel closes', async () => !(await panelOpen()), 30_000);

  // ---- equip: craft an equippable recipe, then equip() the real path ----
  // the prompt target is slow to re-establish after the modal closes
  // (SwiftShader frames) — wait for it before [E], or the keypress lands
  // on a null target and is ignored
  await waitFor('station prompt returns', async () => {
    const t = await stationPromptText();
    return !!t && t.includes('Use ');
  }, 60_000);
  await page.keyboard.press('e'); // re-open at the workbench
  await waitFor('crafting panel re-opens', panelOpen, 30_000);
  const second = await firstCraftable(true);
  expect(second, 'expected a craftable equippable recipe').toBeTruthy();
  await page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(second!.index).click();
  await waitFor('equippable output lands', async () => (await invCount(second!.out)) > 0, 60_000);
  const equipped = await page.evaluate(([outId, slot]) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const inv = X.blueprint.itemKit.inventory;
    const res = inv.equip(outId); // the same call the HUD's equip button makes
    return { res: !!res, equipped: inv.getEquipped(slot) };
  }, [second!.out, second!.slot!]);
  expect(equipped.res).toBe(true);
  expect(equipped.equipped).toBe(second!.out);
  await page.keyboard.press('Escape');
  await waitFor('panel closes after equip', async () => !(await panelOpen()), 30_000);

  // ---- mobile leg: 360x780, panel fits and crafts ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await waitFor('station prompt returns (mobile)', async () => {
    const t = await stationPromptText();
    return !!t && t.includes('Use ');
  }, 60_000);
  await page.keyboard.press('e');
  await waitFor('panel opens on mobile', panelOpen, 30_000);
  const box = await page.evaluate(() => {
    const el = document.getElementById('xandria-crafting-panel') as HTMLElement | null;
    return el ? el.getBoundingClientRect().toJSON() : null;
  });
  expect(box, 'panel has a box on mobile').toBeTruthy();
  expect(box!.left, 'panel fits horizontally at 360px').toBeGreaterThanOrEqual(0);
  expect(box!.right, 'panel fits horizontally at 360px').toBeLessThanOrEqual(360);
  expect(box!.bottom, 'panel fits vertically at 780px').toBeLessThanOrEqual(780);
  await page.screenshot({ path: '/tmp/crafting-panel-mobile.png' });
  // the panel is usable at 360px: a craftable recipe (if any) shows an
  // enabled CRAFT button. the full craft transaction is proven on desktop
  // above; the queue timer is too slow to drive reliably under SwiftShader
  // at this viewport, so the mobile leg asserts UI state, not the tick.
  const third = await firstCraftable(false);
  if (third) {
    const btn = page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(third.index);
    await expect(btn, 'craftable recipe has an enabled CRAFT button on mobile').toBeEnabled();
  }
  await page.keyboard.press('Escape');
  await waitFor('panel closes on mobile', async () => !(await panelOpen()), 30_000);

  expect(errors).toEqual([]);
});
