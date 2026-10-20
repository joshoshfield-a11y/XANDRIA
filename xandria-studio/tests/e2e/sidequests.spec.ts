/**
 * Side-quests wave — side quests on the story-quests quest system, in the
 * live player page.
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action). Seeded side pool (probed):
 *   rumor_mill (talk:any x5), spare_parts (gather mat_scrap x6),
 *   ore_sample (gather mat_ore x4), stockpile (gather:any x11),
 *   apprentice_work (craft:any x2), pest_control (kill walker x6),
 *   timber_call (gather mat_fiber x7).
 *
 * Desktop legs (real paths, like quests.spec.ts):
 *   fetch:  accept Spare Parts via the real villager dialogue -> harvest
 *           scrap nodes via the real [E] prompt path -> complete -> turn in
 *           via dialogue -> XP + item reward land, tracker shows.
 *   craft:  accept Apprentice Work -> real crafting panel CRAFT clicks
 *           (recipe_whetstone x2, station-free) -> onCrafted x2 -> complete
 *           -> turn in -> reward lands.
 * Mobile leg (360x780): accept Ore Sample, 4 ore harvests via [E], turn in
 * via a real click; dialogue fits the viewport; tracker hides when done.
 *
 * The story line is left untouched (never accepted) — its chain must stay
 * locked/available exactly as seeded.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint builds
// the item kit (ensureCraftingItemDefs fills the crafting defs at boot).
const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);

type X = { __XANDRIA__?: any };

test('sidequests: fetch + craft end-to-end, mobile ore leg, desktop + 360x780', async ({ page }) => {
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
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X?.questTest && X?.gatheringTest && X?.craftingTest
      && X?.blueprint?.quests && X?.blueprint?.npcs && X?.blueprint?.itemKit
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);

  // God-mode: the bot must not be mauled mid-dialogue (no kill leg here).
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const mgr = {
    status: (id: string): Promise<string> => page.evaluate((id) =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id), id),
    progress: (id: string): Promise<number[]> => page.evaluate((id) =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().progressOf(id), id),
    defs: (): Promise<Array<{ id: string; name: string; side?: boolean; objectives: Array<{ kind: string; target: string; count: number }>; rewards: { items: Array<{ id: string; count: number }> } }>> =>
      page.evaluate(() => (window as unknown as X).__XANDRIA__.questTest.liveManager().defs
        .map((d: any) => ({ id: d.id, name: d.name, side: d.side, objectives: d.objectives, rewards: d.rewards }))),
  };
  const invCount = (id: string): Promise<number> => page.evaluate((id) =>
    (window as unknown as X).__XANDRIA__.blueprint.itemKit.inventory.count(id), id);

  const defs = await mgr.defs();
  const side = defs.filter((d) => d.side === true);
  console.log('[sidequests] side=' + JSON.stringify(side.map((d) => d.id)));
  expect(side.length, 'seeded side pool has 6-10 quests').toBeGreaterThanOrEqual(6);
  expect(side.length).toBeLessThanOrEqual(10);
  for (const d of side) {
    expect(await mgr.status(d.id), `${d.id} starts available`).toBe('available');
  }
  // The story line is untouched by construction: quest_1 available, rest locked.
  const story = defs.filter((d) => !d.side);
  expect(story.length).toBeGreaterThanOrEqual(3);
  expect(await mgr.status(story[0].id)).toBe('available');
  expect(await mgr.status(story[1].id)).toBe('locked');

  const fetchQuest = side.find((d) => d.id.includes('_spare_parts'))!;
  const craftQuest = side.find((d) => d.id.includes('_apprentice_work'))!;
  const oreQuest = side.find((d) => d.id.includes('_ore_sample'))!;
  expect(fetchQuest && craftQuest && oreQuest, 'seeded fetch + craft + ore side quests').toBeTruthy();
  const fetchCount = fetchQuest.objectives[0].count; // 6 scrap
  const oreCount = oreQuest.objectives[0].count;     // 4 ore

  // ---- villager handles (quests.spec.ts pattern) ----
  const collectVillagers = (): Promise<string[]> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const npcs = X.blueprint.npcs.npcs.filter((n: any) => n.role === 'villager');
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    const rivals = [...nodes, ...stations].map((r: any) => r.root.position);
    const clearance = (n: any) => Math.min(...rivals.map((p: any) =>
      Math.hypot(p.x - n.position.x, p.z - n.position.z)));
    return npcs
      .filter((n: any) => clearance(n) > 4)
      .map((n: any) => n.interactable.id);
  });
  const freezeVillagers = (ids: string[]): Promise<void> => page.evaluate((ids) => {
    const X = (window as unknown as X).__XANDRIA__;
    for (const n of X.blueprint.npcs.npcs) {
      if (ids.includes(n.interactable.id)) { n.state = 'idle'; n.stateT = 1e9; }
    }
  }, ids);
  const villagers = await collectVillagers();
  expect(villagers.length).toBeGreaterThanOrEqual(3);
  await freezeVillagers(villagers);

  const teleportNearVillager = (vid: string): Promise<void> => page.evaluate((vid) => {
    const X = (window as unknown as X).__XANDRIA__;
    const n = X.blueprint.npcs.npcs.find((n: any) => n.interactable.id === vid);
    const p = n.position;
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(new V(p.x + 2, p.y + 1, p.z));
  }, vid);
  const promptedVillager = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.questTest.liveTalkSession()?.promptedNpc?.interactable.id ?? null);
  const dialogueOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  const clickQuestButton = async (action: string): Promise<void> => {
    await page.locator(`#xandria-dialogue-panel button[data-quest-action="${action}"]`).click();
  };
  const trackerText = (): Promise<string | null> => page.evaluate(() => {
    const el = document.getElementById('xandria-quest-tracker') as HTMLElement | null;
    return el && el.style.display !== 'none' ? el.textContent : null;
  });
  const openVillagerDialogue = async (exclude: string[] = []): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const vid: string | null = await page.evaluate(([cands, exclude]) => {
        const X = (window as unknown as X).__XANDRIA__;
        const pool = cands.filter((id: string) => !exclude.includes(id));
        if (!pool.length) return null;
        const byId = new Map<string, any>(X.blueprint.npcs.npcs.map((n: any) => [n.interactable.id, n]));
        const live = pool.filter((id: string) => byId.has(id));
        if (!live.length) return null;
        const exPos = exclude.map((id: string) => byId.get(id)).filter(Boolean).map((n: any) => n.position);
        live.sort((a: string, b: string) => {
          const pa = byId.get(a)!.position;
          const pb = byId.get(b)!.position;
          const da = exPos.length ? Math.min(...exPos.map((p: any) => p.distanceTo(pa) as number)) : 0;
          const db = exPos.length ? Math.min(...exPos.map((p: any) => p.distanceTo(pb) as number)) : 0;
          return (db as number) - (da as number);
        });
        return live[0];
      }, [villagers, exclude] as any);
      if (!vid) throw new Error('no villager candidates left');
      await teleportNearVillager(vid);
      let won: string | null = null;
      try {
        await waitFor('villager talk prompt', async () => {
          const p = await promptedVillager();
          if (p && !exclude.includes(p)) { won = p; return true; }
          return false;
        }, 15_000);
      } catch {
        continue;
      }
      await page.keyboard.press('e');
      await waitFor('dialogue opens', dialogueOpen, 30_000);
      return won!;
    }
    throw new Error('openVillagerDialogue: no prompt won after 10 attempts');
  };
  const closeDialogue = async (): Promise<void> => {
    await page.keyboard.press('e');
    await waitFor('dialogue closes', async () => !(await dialogueOpen()), 30_000);
  };
  const dismissLevelUp = async (): Promise<void> => {
    const btn = page.locator('.lvlopts button').first();
    if (await btn.count() > 0) {
      await btn.click();
      await page.waitForTimeout(1000);
    }
  };

  /** Harvest `count` of a material from real nodes via the [E] prompt path. */
  const harvestMaterial = async (kind: 'ore' | 'fiber' | 'scrap', questId: string, count: number): Promise<void> => {
    const nodeSpots = await page.evaluate((k) => {
      const X = (window as unknown as X).__XANDRIA__;
      const nodes = X.gatheringTest.liveManager().nodes as any[];
      const stations = X.craftingTest.liveStations().stations as any[];
      return nodes
        .filter((n: any) => n.kind === k && n.interactable.enabled !== false)
        .filter((n: any) => stations.every((s: any) =>
          Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z) > 5))
        .map((n: any) => ({ id: n.interactable.id, x: n.root.position.x, y: n.root.position.y, z: n.root.position.z }));
    }, kind);
    console.log(`[sidequests] ${kind} nodes with clearance: ${nodeSpots.length}`);
    expect(nodeSpots.length).toBeGreaterThanOrEqual(2);
    const promptedNode = (): Promise<string | null> => page.evaluate(() =>
      (window as unknown as X).__XANDRIA__.gatheringTest.liveSession()?.promptedNode?.interactable.id ?? null);
    for (const spot of nodeSpots) {
      const prog = await mgr.progress(questId);
      if (prog[0] >= count) break;
      await page.evaluate(([x, y, z]) => {
        const X = (window as unknown as X).__XANDRIA__;
        const V = X.engine.camera.position.constructor;
        X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
      }, [spot.x, spot.y, spot.z]);
      try {
        await waitFor(`prompt shows ${spot.id}`, async () => (await promptedNode()) === spot.id, 30_000);
      } catch { continue; }
      await page.keyboard.press('e');
      await page.waitForTimeout(1500); // let the harvest tick land
    }
    const final = await mgr.progress(questId);
    expect(final[0], `${kind} harvests reach the quest count`).toBeGreaterThanOrEqual(count);
  };

  // ---- FETCH leg: Spare Parts (gather 6 scrap) ----
  await openVillagerDialogue();
  await clickQuestButton(`accept:${fetchQuest.id}`);
  await waitFor('fetch quest active', async () => (await mgr.status(fetchQuest.id)) === 'active', 30_000);
  expect(await trackerText(), 'tracker shows the fetch quest').toContain(fetchQuest.name);
  await page.screenshot({ path: '/tmp/sidequests-dialogue-desktop.png' });
  await closeDialogue();
  const fetchRewardId = fetchQuest.rewards.items[0]?.id;
  const fetchRewardBefore = fetchRewardId ? await invCount(fetchRewardId) : 0;
  await harvestMaterial('scrap', fetchQuest.id, fetchCount);
  await waitFor('fetch quest complete', async () => (await mgr.status(fetchQuest.id)) === 'complete', 60_000);
  await openVillagerDialogue();
  await clickQuestButton(`turnin:${fetchQuest.id}`);
  await waitFor('fetch quest turned in', async () => (await mgr.status(fetchQuest.id)) === 'turned-in', 30_000);
  await dismissLevelUp();
  if (fetchRewardId) {
    expect(await invCount(fetchRewardId), `fetch turn-in reward lands (${fetchRewardId})`)
      .toBeGreaterThan(fetchRewardBefore);
  }
  await closeDialogue();

  // ---- CRAFT leg: Apprentice Work (craft any 2) — the craft-gated e2e ----
  await openVillagerDialogue();
  await clickQuestButton(`accept:${craftQuest.id}`);
  await waitFor('craft quest active', async () => (await mgr.status(craftQuest.id)) === 'active', 30_000);
  await closeDialogue();
  const recipeId = 'recipe_whetstone'; // cheapest station-free recipe in the pool
  await page.evaluate((rid) => {
    const X = (window as unknown as X).__XANDRIA__;
    const r = X.craftingTest.buildRecipePool(X.spec).find((r: any) => r.id === rid);
    if (!r) throw new Error(`recipe ${rid} not in pool`);
    const inv = X.blueprint.itemKit.inventory;
    for (const ing of r.ingredients) {
      const need = ing.count * 2 - inv.count(ing.itemId);
      if (need > 0) inv.add(ing.itemId, need);
    }
  }, recipeId);
  const recipeOut = await page.evaluate((rid) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.craftingTest.buildRecipePool(X.spec).find((r: any) => r.id === rid).output.itemId;
  }, recipeId);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const stations = X.craftingTest.liveStations().stations as any[];
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const clearance = (s: any) => Math.min(...nodes.map((n: any) =>
      Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z)));
    const best = [...stations].sort((a, b) => clearance(b) - clearance(a))[0];
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(
      new V(best.root.position.x + 1.5, best.root.position.y + 1, best.root.position.z));
  });
  const stationPromptText = (): Promise<string | null> => page.evaluate(() => {
    const els = document.querySelectorAll('#xandria-interact-prompt');
    const el = els[0] as HTMLElement | null;
    return el && el.style.display === 'block' ? el.textContent : null;
  });
  await waitFor('station prompt', async () => {
    const t = await stationPromptText();
    return !!t && t.includes('Use ');
  }, 60_000);
  await page.keyboard.press('e');
  const panelOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-crafting-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  await waitFor('crafting panel opens', panelOpen, 30_000);
  const recipeIndex = await page.evaluate((rid) =>
    (window as unknown as X).__XANDRIA__.craftingTest.buildRecipePool(
      (window as unknown as X).__XANDRIA__.spec).findIndex((r: any) => r.id === rid), recipeId);
  expect(recipeIndex).toBeGreaterThanOrEqual(0);
  const craftRewardId = craftQuest.rewards.items[0]?.id;
  const craftRewardCount = craftQuest.rewards.items[0]?.count ?? 0;
  const outBefore = await invCount(recipeOut);
  for (let i = 0; i < 2; i++) {
    await page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(recipeIndex).click();
    await waitFor(`craft ${i + 1} lands`, async () => (await invCount(recipeOut)) >= outBefore + i + 1, 60_000);
  }
  await waitFor('craft quest complete', async () => (await mgr.status(craftQuest.id)) === 'complete', 30_000);
  expect(await mgr.progress(craftQuest.id)).toEqual([2]);
  await page.keyboard.press('Escape');
  await waitFor('panel closes', async () => !(await panelOpen()), 30_000);
  await openVillagerDialogue();
  // The turn-in reward id is seeded-random and may equal a consumed
  // ingredient (whetstone eats scrap): measure immediately before the
  // turn-in click and assert the def's exact reward count lands on top.
  const preTurnIn = craftRewardId ? await invCount(craftRewardId) : 0;
  await clickQuestButton(`turnin:${craftQuest.id}`);
  await waitFor('craft quest turned in', async () => (await mgr.status(craftQuest.id)) === 'turned-in', 30_000);
  await dismissLevelUp();
  if (craftRewardId) {
    expect(await invCount(craftRewardId), `craft turn-in reward lands (${craftRewardId} x${craftRewardCount})`)
      .toBe(preTurnIn + craftRewardCount);
  }
  await closeDialogue();

  // ---- MOBILE leg: 360x780 — Ore Sample (gather 4 ore), real clicks ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await openVillagerDialogue();
  const dlgBox = await page.evaluate(() => {
    const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
    return el ? el.getBoundingClientRect().toJSON() : null;
  });
  expect(dlgBox, 'dialogue has a box on mobile').toBeTruthy();
  expect(dlgBox!.left).toBeGreaterThanOrEqual(0);
  expect(dlgBox!.right).toBeLessThanOrEqual(360);
  await clickQuestButton(`accept:${oreQuest.id}`);
  await waitFor('ore quest active', async () => (await mgr.status(oreQuest.id)) === 'active', 30_000);
  await page.screenshot({ path: '/tmp/sidequests-dialogue-mobile.png' });
  await closeDialogue();
  const oreRewardId = oreQuest.rewards.items[0]?.id;
  const oreRewardBefore = oreRewardId ? await invCount(oreRewardId) : 0;
  await harvestMaterial('ore', oreQuest.id, oreCount);
  await waitFor('ore quest complete', async () => (await mgr.status(oreQuest.id)) === 'complete', 60_000);
  await openVillagerDialogue();
  await clickQuestButton(`turnin:${oreQuest.id}`);
  await waitFor('ore quest turned in (mobile)', async () => (await mgr.status(oreQuest.id)) === 'turned-in', 30_000);
  // HUD-polish wave fixed the real papercut (level-up/branch-choice modals
  // now live in a dedicated z-9650 layer above the dialogue), so the modal
  // is clickable with the dialogue open. The test keeps the close-dialogue-
  // first flow — still a legitimate player path — then dismisses the modal.
  await closeDialogue();
  await dismissLevelUp();
  if (oreRewardId) {
    expect(await invCount(oreRewardId), `mobile turn-in reward lands (${oreRewardId})`)
      .toBeGreaterThan(oreRewardBefore);
  }

  // The story line was never touched: quest_1 still available, rest locked.
  expect(await mgr.status(story[0].id), 'story quest 1 untouched').toBe('available');
  expect(await mgr.status(story[1].id), 'story quest 2 still locked').toBe('locked');

  expect(errors, 'zero console/page errors').toEqual([]);
});
