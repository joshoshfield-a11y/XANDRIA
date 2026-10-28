/**
 * Skill synergies — live player page e2e (desktop AND 360x780, zero
 * console/page errors).
 *
 * Flow: boot the deterministic "Forgotten Valley" scene (seed 20261012,
 * tp-action) -> K opens the skills panel: the SYNERGIES section lists
 * all 5 synergies LOCKED at rank 1 -> harvest one node via the real [E]
 * prompt path (rank-1 yield, no synergy) -> rank foraging + smithing to
 * 2 via the real SkillSystem: Field Smith activates, harvestYieldBonus
 * is exactly 2 (rank +1, synergy +1), the panel flips the row to
 * ACTIVE -> harvest a second node of the same kind via [E]: its grant
 * beats the first by the +2 bonus, within the seeded variance band ->
 * rank alchemy to 2: Herbal Edge + Workshop Flow activate, craft-time
 * multiplier is exactly 0.81 -> drop below rank via the portal-restore
 * seam: all synergies gone, panel LOCKED again -> portal snapshot
 * round-trip preserves the active synergy -> page reload preserves
 * ranks + synergies (per-seed persistence) -> mobile leg: panel fits
 * 360x780 with the synergy rows visible.
 *
 * Hardening (per workers-crafting/C.md): the player is teleported to
 * the node (never the reverse), all waits poll from Node, and the
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

test('skill synergies: activate, harvest bonus, drop, reload, desktop + mobile', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const bootUrl = `/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`;
  await page.goto(bootUrl);

  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(2000);
    }
  };
  const waitBoot = () => waitFor('boot', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X?.gatheringTest && X?.craftingTest && X?.skillsTest?.liveSkills?.()
      && X?.blueprint?.stations && X?.blueprint?.itemKit && X.engine.state === 'playing'
      && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await waitBoot();

  // Clean prompt field: NPCs/enemies are not under test here; despawn so
  // the [E] target is unambiguous and the bot isn't mauled mid-harvest.
  const cleanField = () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const systems = (X.engine.portalEntities as unknown as { systems: Array<{ id: string; despawnAll(): void }> }).systems;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  await cleanField();

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
  const activeSynergies = (): Promise<string[]> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills()
      .activeSynergies().map((d: any) => d.id));
  const harvestBonus = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().harvestYieldBonus());
  const craftMult = (): Promise<number> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().craftTimeMult());
  const critBonuses = (): Promise<{ chanceBonus: number; multiplierBonus: number }> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().synergyCritBonuses());

  // ---- panel: all 5 synergies LOCKED at rank 1 ----
  await page.keyboard.press('k');
  await waitFor('skills panel opens on K', skillsOpen, 30_000);
  const t0 = await panelText();
  expect(t0).toContain('SYNERGIES');
  for (const name of ['Field Smith', 'Workshop Flow', 'Herbal Edge', 'Tempered Edge', 'Grand Artisan']) {
    expect(t0).toContain(`LOCKED — ${name}`);
  }
  expect(await activeSynergies()).toEqual([]);
  expect(await harvestBonus()).toBe(0);
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- two same-kind nodes, away from stations, for the yield comparison ----
  const nodePair = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    const clear = nodes.filter((n: any) => stations.every((s: any) =>
      Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z) > 5));
    const byKind = new Map<string, any[]>();
    for (const n of clear) {
      const list = byKind.get(n.kind) ?? [];
      list.push(n);
      byKind.set(n.kind, list);
    }
    for (const [, list] of byKind) {
      if (list.length >= 2) {
        return list.slice(0, 2).map((n: any) => ({
          id: n.interactable.id,
          kind: n.kind,
          materialId: X.gatheringTest.MATERIAL_IDS[n.kind],
          x: n.root.position.x, y: n.root.position.y, z: n.root.position.z,
        }));
      }
    }
    return [];
  });
  expect(nodePair.length, 'expected a same-kind node pair').toBe(2);
  expect(nodePair[0].kind).toBe(nodePair[1].kind);

  const promptedId = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__
      .gatheringTest.liveSession()?.promptedNode?.interactable.id ?? null);
  const invCount = (materialId: string): Promise<number> => page.evaluate((mid) =>
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.blueprint.itemKit.inventory.count(mid), materialId);

  const harvestViaPrompt = async (spot: { id: string; x: number; y: number; z: number; materialId: string }) => {
    await page.evaluate(([x, y, z]) => {
      const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
      const V = X.engine.camera.position.constructor;
      X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
    }, [spot.x, spot.y, spot.z]);
    await waitFor(`prompt shows ${spot.id}`, async () => (await promptedId()) === spot.id, 30_000);
    const beforeCount = await invCount(spot.materialId);
    const beforeXp = await skillXp('foraging');
    await page.keyboard.press('e');
    await waitFor('foraging XP lands', async () => (await skillXp('foraging')) > beforeXp, 25_000);
    const afterCount = await invCount(spot.materialId);
    return afterCount - beforeCount;
  };

  // ---- harvest 1: rank 1, no synergy — the baseline grant ----
  const deltaA = await harvestViaPrompt(nodePair[0]);
  expect(deltaA, 'baseline harvest grants materials').toBeGreaterThan(0);
  console.log(`[synergies] baseline harvest grant: ${deltaA} x ${nodePair[0].materialId}`);

  // ---- activate Field Smith: foraging 2 + smithing 2 ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    X.skillsTest.liveSkills().addXp('foraging', 60);
    X.skillsTest.liveSkills().addXp('smithing', 80);
  });
  expect(await skillRank('foraging')).toBe(2);
  expect(await skillRank('smithing')).toBe(2);
  expect(await activeSynergies()).toEqual(['field-smith']);
  // Exact additive math: rank bonus +1, synergy bonus +1.
  expect(await harvestBonus()).toBe(2);
  expect(await critBonuses()).toEqual({ chanceBonus: 0, multiplierBonus: 0 });
  await page.keyboard.press('k');
  await waitFor('skills panel opens for synergy check', skillsOpen, 30_000);
  const t1 = await panelText();
  expect(t1).toContain('ACTIVE — Field Smith');
  expect(t1).toContain('LOCKED — Workshop Flow');
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- harvest 2: same kind, synergy active — grant beats baseline by the +2 bonus ----
  // Same kind => same seeded base/variance band (base + 0..1). The second
  // grant carries +2 (rank + synergy), so it exceeds the first by 1..3.
  const deltaB = await harvestViaPrompt(nodePair[1]);
  console.log(`[synergies] synergy harvest grant: ${deltaB} x ${nodePair[1].materialId} (baseline ${deltaA})`);
  expect(deltaB - deltaA, 'synergy + rank bonus lands in the real grant').toBeGreaterThanOrEqual(1);
  expect(deltaB - deltaA).toBeLessThanOrEqual(3);

  // ---- combat + crafting lines: alchemy 2 activates Herbal Edge + Workshop Flow ----
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills().addXp('alchemy', 80);
  });
  expect(await skillRank('alchemy')).toBe(2);
  expect(await activeSynergies()).toEqual(['field-smith', 'workshop-flow', 'herbal-edge']);
  expect(await critBonuses()).toEqual({ chanceBonus: 0.02, multiplierBonus: 0 });
  // Rank 0.9 x synergy 0.9 = 0.81, exactly.
  expect(await craftMult()).toBeCloseTo(0.81, 10);
  await page.keyboard.press('k');
  await waitFor('skills panel opens for crit-line check', skillsOpen, 30_000);
  const t2 = await panelText();
  expect(t2).toContain('ACTIVE — Herbal Edge');
  expect(t2).toContain('ACTIVE — Workshop Flow');
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- drop below rank via the portal-restore seam: synergies removed ----
  await page.evaluate(() => {
    (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.skillsTest.liveSkills()
      .portalRestore({ xp: { foraging: 0, smithing: 0, alchemy: 0 } });
  });
  expect(await activeSynergies()).toEqual([]);
  expect(await harvestBonus()).toBe(0);
  expect(await craftMult()).toBe(1);
  expect(await critBonuses()).toEqual({ chanceBonus: 0, multiplierBonus: 0 });
  await page.keyboard.press('k');
  await waitFor('skills panel opens for drop check', skillsOpen, 30_000);
  const t3 = await panelText();
  expect(t3).toContain('LOCKED — Field Smith');
  expect(t3).not.toContain('ACTIVE — Field Smith');
  await page.keyboard.press('Escape');
  await waitFor('skills panel closes', async () => !(await skillsOpen()), 30_000);

  // ---- portal snapshot round-trip preserves the re-activated synergy ----
  await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const skills = X.skillsTest.liveSkills();
    skills.addXp('foraging', 60);
    skills.addXp('smithing', 80);
    skills.portalRestore(skills.portalSnapshot());
  });
  expect(await activeSynergies()).toEqual(['field-smith']);
  expect(await harvestBonus()).toBe(2);

  // ---- reload preserves ranks + synergies (per-seed persistence) ----
  const xpBeforeReload = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const s = X.skillsTest.liveSkills();
    return { foraging: s.xpOf('foraging'), smithing: s.xpOf('smithing'), alchemy: s.xpOf('alchemy') };
  });
  await page.reload();
  await waitBoot();
  const xpAfterReload = await page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const s = X.skillsTest.liveSkills();
    return { foraging: s.xpOf('foraging'), smithing: s.xpOf('smithing'), alchemy: s.xpOf('alchemy') };
  });
  expect(xpAfterReload).toEqual(xpBeforeReload);
  expect(await activeSynergies()).toEqual(['field-smith']);
  expect(await harvestBonus()).toBe(2);
  console.log(`[synergies] reload preserved XP ${JSON.stringify(xpAfterReload)} + Field Smith`);

  // ---- mobile leg: 360x780, panel fits, synergy rows visible ----
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
  expect(tm).toContain('SYNERGIES');
  expect(tm).toContain('ACTIVE — Field Smith');
  await page.screenshot({ path: '/tmp/skill-synergies-panel-mobile.png' });
  await page.keyboard.press('Escape');

  expect(errors, 'zero console/page errors').toEqual([]);
});
