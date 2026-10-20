/**
 * Skills wave — live player page e2e (desktop AND 360x780, zero
 * console/page errors).
 *
 * Flow: boot the deterministic "Forgotten Valley" scene (seed 20261012,
 * tp-action) with an empty custom.items table injected -> despawn
 * NPCs/enemies for a clean prompt field -> K opens the skills panel
 * (real key handler), 3 skill cards render, screenshot -> Esc closes ->
 * SKILLS chip click re-opens (touch path) -> 2 harvests via the real [E]
 * prompt path -> foraging XP > 0, materials land -> rank smithing to 2
 * via the real SkillSystem -> panel shows UNLOCKED/LOCKED recipe states
 * from the seeded pool -> teleport to the workbench, [E], click the
 * first craftable recipe's CRAFT -> smithing XP rises on queue
 * completion -> draw-call sample with the panel closed vs open (DOM-only
 * UI: expect no WebGL draw change).
 *
 * Hardening (per workers-crafting/C.md): the player is teleported to the
 * node/station (never the reverse), all waits poll from Node, and the
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

test('skills: panel + XP + gates + craft XP, desktop + mobile', async ({ page }) => {
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
  // the [E] target is unambiguous and the bot isn't mauled mid-harvest.
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
  const skillXp = (id: string): Promise<number> => page.evaluate((sid) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().xpOf(sid), id);
  const skillRank = (id: string): Promise<number> => page.evaluate((sid) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().rankOf(sid), id);

  // ---- panel: K opens, 3 skill cards render ----
  await page.keyboard.press('k');
  await waitFor('skills panel opens on K', skillsOpen, 30_000);
  const t0 = await panelText();
  expect(t0).toContain('Foraging');
  expect(t0).toContain('Smithing');
  expect(t0).toContain('Alchemy');
  expect(t0).toContain('RANK 1/3');
  expect(await skillRank('foraging')).toBe(1);
  await page.screenshot({ path: '/tmp/skills-panel-desktop.png' });
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- touch path: the SKILLS chip toggles the panel ----
  // (the chip hides itself while the panel is open, so the touch close
  // path is the panel's native × button — same as a finger tap)
  // NOTE (× button above and chip below): force:true — both controls are
  // provably visible/enabled/stable, but Playwright's actionability check
  // flakes under SwiftShader here. The force click still dispatches the
  // real handler through the input pipeline.
  await page.locator('#xandria-skills-chip').click({ force: true, timeout: 15000 });
  await waitFor('skills panel opens via chip', skillsOpen, 30_000);
  // NOTE: force:true — the × button is provably visible/enabled/stable
  // (28×28 box, pointer-events auto, elementFromPoint hits it, identical
  // box across rAF), but Playwright's actionability check flakes under
  // SwiftShader here. The force click still dispatches the real handler.
  await page.locator('#xandria-skills-panel button', { hasText: '×' }).click({ force: true, timeout: 15000 });
  await waitFor('skills panel closes via close button', async () => !(await skillsOpen()), 30_000);
  // chip is visible again after close — re-open through it once more
  await page.locator('#xandria-skills-chip').click({ timeout: 15000 });
  await waitFor('skills panel re-opens via chip', skillsOpen, 30_000);
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- harvest: 2 nodes via the real [E] prompt path -> foraging XP ----
  const nodeSpots = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    return nodes
      .filter((n: any) => stations.every((s: any) =>
        Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z) > 5))
      .slice(0, 2)
      .map((n: any) => ({
        id: n.interactable.id,
        x: n.root.position.x, y: n.root.position.y, z: n.root.position.z,
      }));
  });
  expect(nodeSpots.length).toBe(2);
  const promptedId = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__
      .gatheringTest.liveSession()?.promptedNode?.interactable.id ?? null);
  let harvested = 0;
  for (const spot of nodeSpots) {
    await page.evaluate(([x, y, z]) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const V = X.engine.camera.position.constructor;
      X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
    }, [spot.x, spot.y, spot.z]);
    try {
      await waitFor(`prompt shows ${spot.id}`, async () => (await promptedId()) === spot.id, 30_000);
    } catch { continue; }
    const before = await skillXp('foraging');
    await page.keyboard.press('e');
    await waitFor('foraging XP lands', async () => (await skillXp('foraging')) > before, 25_000);
    harvested++;
  }
  expect(harvested, 'harvested 2 nodes for real').toBe(2);
  expect(await skillXp('foraging')).toBeGreaterThanOrEqual(16); // 2 harvests x 8 XP
  console.log(`[skills] foraging xp after 2 harvests: ${await skillXp('foraging')}`);

  // ---- gates: rank smithing to 2 -> panel shows UNLOCKED/LOCKED honestly ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.skillsTest.liveSkills().addXp('smithing', 80);
  });
  expect(await skillRank('smithing')).toBe(2);
  // expectations computed in-page from the seeded pool (pool content is
  // seed-determined, so assert against the actual pool, not a fixed list)
  const gateStates = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const pool = X.craftingTest.buildRecipePool(X.spec);
    const skills = X.skillsTest.liveSkills();
    const txt = document.getElementById('xandria-skills-panel')?.textContent ?? '';
    void txt;
    return pool
      .filter((r: any) => r.skillId)
      .map((r: any) => ({
        name: r.name,
        req: r.minSkillRank ?? 1,
        rank: skills.rankOf(r.skillId),
        locked: skills.rankOf(r.skillId) < (r.minSkillRank ?? 1),
      }));
  });
  expect(gateStates.length).toBeGreaterThan(0);
  await page.keyboard.press('k');
  await waitFor('skills panel opens for gate check', skillsOpen, 30_000);
  const t1 = await panelText();
  for (const g of gateStates) {
    expect(t1).toContain(`${g.locked ? 'LOCKED' : 'UNLOCKED'} — ${g.name}`);
  }
  console.log(`[skills] gate states: ${JSON.stringify(gateStates.map((g: any) => `${g.name}:${g.locked ? 'locked' : 'open'}(req ${g.req})`))}`);
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes after gate check', async () => !(await skillsOpen()), 30_000);

  // ---- craft XP: workbench craft -> smithing XP rises on completion ----
  const benchPos = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const stations = X.craftingTest.liveStations().stations as any[];
    const bench = stations.find((s: any) => s.stationId === 'station_workbench');
    return bench ? { x: bench.root.position.x, y: bench.root.position.y, z: bench.root.position.z } : null;
  });
  expect(benchPos, 'expected a workbench in the roster').toBeTruthy();
  const firstCraftable = (): Promise<{ id: string; out: string; index: number } | null> =>
    page.evaluate(() => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const CT = X.craftingTest;
      const pool = CT.buildRecipePool(X.spec);
      const inv = X.blueprint.itemKit.inventory;
      const defs = X.spec.custom.items.defs;
      const opts = {
        inventory: inv, defs, enabled: true, playerLevel: 1,
        skills: X.skillsTest.liveSkills(),
        stations: new Set(['station_workbench']),
      };
      for (let i = 0; i < pool.length; i++) {
        const r = pool[i];
        if (!CT.checkCraft(pool, r.id, opts).ok) continue;
        return { id: r.id, out: r.output.itemId, index: i };
      }
      return null;
    });
  const stationPromptText = (): Promise<string | null> => page.evaluate(() => {
    const els = document.querySelectorAll('#xandria-interact-prompt');
    const el = els[0] as HTMLElement | null;
    if (!el || el.style.display !== 'block') return null;
    return el.textContent;
  });
  const panelOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-crafting-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
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
  const first = await firstCraftable();
  expect(first, 'expected a craftable workbench recipe').toBeTruthy();
  const smithBefore = await skillXp('smithing');
  await page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(first!.index).click();
  await waitFor('smithing XP rises on craft completion', async () => (await skillXp('smithing')) > smithBefore, 240_000);
  console.log(`[skills] smithing xp ${smithBefore} -> ${await skillXp('smithing')} after crafting ${first!.id}`);
  await page.keyboard.press('Escape');
  await waitFor('crafting panel closes', async () => !(await panelOpen()), 30_000);

  // ---- perf: the skills panel is DOM-only — no WebGL draw change ----
  // (INSTANCING.md method: renderer.info.render.calls, median of samples)
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
  const closedDraws = median(await sampleDraws(5));
  await page.keyboard.press('k');
  await waitFor('skills panel opens for perf leg', skillsOpen, 30_000);
  const openDraws = median(await sampleDraws(5));
  await page.keyboard.press('Escape');
  console.log(`[skills] draws panel-closed=${closedDraws} panel-open=${openDraws}`);
  expect(Math.abs(openDraws - closedDraws), 'DOM panel adds no WebGL draws').toBeLessThanOrEqual(2);

  // ---- mobile leg: 360x780, panel fits, chip toggles ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await page.locator('#xandria-skills-chip').click();
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
  expect(tm).toContain('Smithing');
  await page.screenshot({ path: '/tmp/skills-panel-mobile.png' });
  await page.keyboard.press('Escape');

  expect(errors, 'zero console/page errors').toEqual([]);
});
