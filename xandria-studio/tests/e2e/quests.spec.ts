/**
 * Quest wave — the main-story quest line in the live player page.
 *
 * Test 1 (desktop, then 360x780): the seeded story line for the npcs
 * fixture (seed 20261012, tp-action) is talk -> kill -> craft -> gather,
 * chained. Drives every leg through the REAL path:
 *   talk:   [E] at a villager -> quest dialogue -> click Accept -> [E] at
 *           two more villagers (talk objectives fire on open) -> [E] ->
 *           dialogue now shows Turn in (live-refresh via onQuestsChanged)
 *           -> click -> XP + item rewards land
 *   kill:   6 walkers via the real death path (damage -> onDeath ->
 *           quests.onKill) -> turn in via dialogue
 *   craft:  real crafting panel click (Fiber Weave Vest) -> onCrafted ->
 *           turn in via dialogue
 *   gather: 6 harvests via the real [E] prompt path -> complete
 * Then: portal departure/arrival cycle (despawnAll/spawnForMap, the exact
 * functions PortalTransition invokes) leaves quest state untouched
 * (player-scoped, not map-local). Mobile leg at 360x780: turn in the last
 * quest via a real dialogue click; tracker + dialogue fit the viewport.
 *
 * Test 2: a REAL portal walk on the portal-8km fixture — quest state
 * (statuses + progress) survives the transition on the same manager.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to NPCs/nodes/stations (never the reverse), all waits poll
 * from Node, and prompt targets are read via the sessions' live handles
 * (promptedNpc / promptedNode), never pill text.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const PORTAL_RAW = readFileSync(resolve(HERE, 'fixtures/portal-8km.b64'), 'utf8').trim();

// Same deterministic scenes, plus an empty item table so the blueprint
// builds the item kit (ensureCraftingItemDefs fills the crafting defs at
// boot; crafting + quests are enabled by default).
const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);
const PORTAL_B64 = withItems(PORTAL_RAW);

type X = { __XANDRIA__?: any };

test('quests: story line accept -> progress -> complete -> reward, desktop + 360x780', async ({ page }) => {
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

  // God-mode: enemies stay live for the kill leg, but the bot must not be
  // mauled mid-dialogue.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const mgr = {
    status: (id: string): Promise<string> => page.evaluate((id) =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id), id),
    progress: (id: string): Promise<number[]> => page.evaluate((id) =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().progressOf(id), id),
    defs: (): Promise<Array<{ id: string; name: string; objectives: Array<{ kind: string; target: string; count: number }>; rewards: { items: Array<{ id: string; count: number }> } }>> =>
      page.evaluate(() => (window as unknown as X).__XANDRIA__.questTest.liveManager().defs
        .map((d: any) => ({ id: d.id, name: d.name, objectives: d.objectives, rewards: d.rewards }))),
  };
  const invCount = (id: string): Promise<number> => page.evaluate((id) =>
    (window as unknown as X).__XANDRIA__.blueprint.itemKit.inventory.count(id), id);

  // The seeded line for this fixture (unit-tested): talk -> kill -> craft -> gather.
  const defs = await mgr.defs();
  console.log('[quests] line=' + JSON.stringify(defs.map((d) => ({ id: d.id, kinds: d.objectives.map((o) => o.kind) }))));
  expect(defs.length).toBeGreaterThanOrEqual(3);
  const kinds = defs.map((d) => d.objectives.map((o) => o.kind).join('+'));
  expect(kinds[0]).toBe('talk');
  expect(kinds[1]).toBe('kill');
  const craftQuest = defs.find((d) => d.objectives.some((o) => o.kind === 'craft'))!;
  const gatherQuest = defs.find((d) => d.objectives.some((o) => o.kind === 'gather'))!;
  expect(craftQuest && gatherQuest, 'seeded line has craft + gather quests').toBeTruthy();
  const talkQuest = defs[0];
  const killQuest = defs[1];
  const talkCount = talkQuest.objectives[0].count;
  const killCount = killQuest.objectives[0].count;
  const killKind = killQuest.objectives[0].target;

  // ---- villager handles ----
  // Villagers with clearance from nodes/stations, so the Talk prompt wins
  // unambiguously (the only remaining rivals are villagers, which is fine
  // — every villager offers the same quest actions).
  // NPC interactable ids embed a global spawn counter (Npc.ts), so a
  // portal despawn/respawn cycle issues NEW ids — the candidate list must
  // be re-collected after the portal cycle below.
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
  // Freeze the candidates (npcs.spec.ts pattern: stateT = 1e9 keeps them
  // idle) so wander can't steal the Talk prompt mid-leg. Talk objectives
  // fire on dialogue open; freezing changes nothing about the quest path.
  const freezeVillagers = (ids: string[]): Promise<void> => page.evaluate((ids) => {
    const X = (window as unknown as X).__XANDRIA__;
    for (const n of X.blueprint.npcs.npcs) {
      if (ids.includes(n.interactable.id)) { n.state = 'idle'; n.stateT = 1e9; }
    }
  }, ids);
  let villagers = await collectVillagers();
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

  /** Open a dialogue with a villager: teleport near the nearest candidate
   *  (villagers wander, so take whichever villager's Talk prompt wins —
   *  every villager offers the same quest actions). Returns the id spoken to. */
  const openVillagerDialogue = async (exclude: string[] = []): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const vid: string | null = await page.evaluate(([cands, exclude]) => {
        const X = (window as unknown as X).__XANDRIA__;
        const pool = cands.filter((id: string) => !exclude.includes(id));
        if (!pool.length) return null;
        const byId = new Map<string, any>(X.blueprint.npcs.npcs.map((n: any) => [n.interactable.id, n]));
        // Defensive: drop candidate ids that no longer exist in the live
        // roster (a portal respawn reissues NPC ids; see collectVillagers).
        const live = pool.filter((id: string) => byId.has(id));
        if (!live.length) return null;
        const exPos = exclude
          .map((id: string) => byId.get(id))
          .filter(Boolean)
          .map((n: any) => n.position);
        // Farthest from the already-spoken villagers: the prompt picks the
        // nearest interactable, so separation keeps the excluded ones out.
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
        continue; // excluded rival won or no prompt — re-teleport to a fresh candidate
      }
      await page.keyboard.press('e');
      await waitFor('dialogue opens', dialogueOpen, 30_000);
      return won!;
    }
    throw new Error('openVillagerDialogue: no prompt won after 10 attempts');
  };
  const closeDialogue = async (): Promise<void> => {
    await page.keyboard.press('e'); // the panel owns E while open (capture phase)
    await waitFor('dialogue closes', async () => !(await dialogueOpen()), 30_000);
  };
  /** Quest/kill XP can level the player — the LEVEL UP modal pauses the
   *  game, so dismiss it with a real click on the first upgrade. */
  const dismissLevelUp = async (): Promise<void> => {
    const btn = page.locator('.lvlopts button').first();
    if (await btn.count() > 0) {
      await btn.click();
      await page.waitForTimeout(1000);
    }
  };

  // ---- TALK leg: accept via the real dialogue button ----
  // Three DISTINCT villagers (exclude-list): talk objectives fire on
  // dialogue open, and the multi-NPC path is the honest one to prove.
  const talkedTo: string[] = [];
  talkedTo.push(await openVillagerDialogue());
  await clickQuestButton(`accept:${talkQuest.id}`);
  await waitFor('quest accepted', async () => (await mgr.status(talkQuest.id)) === 'active', 30_000);
  expect(await trackerText(), 'tracker shows the accepted quest').toContain(talkQuest.name);
  await page.screenshot({ path: '/tmp/quests-dialogue-desktop.png' });
  await closeDialogue();

  // Talk objectives only advance while the quest is ACTIVE (the accept
  // conversation fires onTalk before accept, so it correctly does not
  // count). Three more distinct villagers after accepting completes it.
  talkedTo.push(await openVillagerDialogue(talkedTo));
  await closeDialogue();
  talkedTo.push(await openVillagerDialogue(talkedTo));
  await closeDialogue();
  talkedTo.push(await openVillagerDialogue(talkedTo));
  expect(new Set(talkedTo).size, 'four distinct villagers').toBe(4);
  // The 3rd open completes the quest MID-dialogue; onQuestsChanged
  // live-refreshes the open dialogue so Turn in appears without re-open.
  await waitFor('talk quest complete', async () => (await mgr.status(talkQuest.id)) === 'complete', 30_000);
  expect(await mgr.progress(talkQuest.id)).toEqual([talkCount]);
  await waitFor('turn-in button appears live', () => page.evaluate((id) =>
    !!document.querySelector(`#xandria-dialogue-panel button[data-quest-action="turnin:${id}"]`), talkQuest.id), 30_000);
  // Reward items are seeded-random per quest — read the actual reward id
  // from the def rather than assuming a material.
  const talkRewardId = talkQuest.rewards.items[0]?.id;
  const talkRewardBefore = talkRewardId ? await invCount(talkRewardId) : 0;
  await clickQuestButton(`turnin:${talkQuest.id}`);
  await waitFor('talk quest turned in', async () => (await mgr.status(talkQuest.id)) === 'turned-in', 30_000);
  await dismissLevelUp(); // quest XP may have leveled the player
  if (talkRewardId) {
    expect(await invCount(talkRewardId), `turn-in item reward lands (${talkRewardId})`)
      .toBeGreaterThan(talkRewardBefore);
  }
  expect(await mgr.status(killQuest.id), 'chain unlocks the kill quest').toBe('available');
  await closeDialogue();

  // ---- KILL leg: accept first, then the real death path ----
  await openVillagerDialogue();
  await clickQuestButton(`accept:${killQuest.id}`);
  await waitFor('kill quest active', async () => (await mgr.status(killQuest.id)) === 'active', 30_000);
  expect(await trackerText(), 'tracker shows the kill quest').toContain(killQuest.name);
  await closeDialogue();
  const killRewardId = killQuest.rewards.items[0]?.id;
  const killRewardBefore = killRewardId ? await invCount(killRewardId) : 0;
  const killed = await page.evaluate(([kind, count]) => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.engine.portalsPlayerAvatar.enemies;
    let roster = M.enemies.filter((e: any) => e.alive && e.spec.kind === kind);
    if (roster.length < count) M.spawnForMap(X.spec.meta.seed); // second wave (items-loot pattern)
    roster = M.enemies.filter((e: any) => e.alive && e.spec.kind === kind);
    let n = 0;
    for (const e of roster) {
      if (n >= count) break;
      e.damage(10000); // the real death path — blueprint onDeath -> quests.onKill
      n++;
    }
    return n;
  }, [killKind, killCount] as [string, number]);
  expect(killed).toBe(killCount);
  await waitFor('kill quest complete', async () => (await mgr.status(killQuest.id)) === 'complete', 60_000);
  await dismissLevelUp(); // the 6 kills may have leveled the player (modal pauses the game)
  expect(await mgr.progress(killQuest.id)).toEqual([killCount]);
  await openVillagerDialogue();
  await clickQuestButton(`turnin:${killQuest.id}`);
  await waitFor('kill quest turned in', async () => (await mgr.status(killQuest.id)) === 'turned-in', 30_000);
  await dismissLevelUp();
  if (killRewardId) {
    expect(await invCount(killRewardId), `kill turn-in item reward lands (${killRewardId})`)
      .toBeGreaterThan(killRewardBefore);
  }
  expect(await mgr.status(craftQuest.id), 'chain unlocks the craft quest').toBe('available');
  await closeDialogue();

  // ---- CRAFT leg: accept, then the real panel click ----
  await openVillagerDialogue();
  await clickQuestButton(`accept:${craftQuest.id}`);
  await waitFor('craft quest active', async () => (await mgr.status(craftQuest.id)) === 'active', 30_000);
  await closeDialogue();
  const recipeId = craftQuest.objectives[0].target;
  console.log(`[quests] craft target=${recipeId}`);
  // Top up ingredients via the inventory seam if short (the real path
  // under test is panel -> craft -> onCrafted; gathering is proven below).
  // (test note: arg must NOT be destructured — recipeId is a plain string,
  //  `([rid]) =>` would bind rid to its first character)
  await page.evaluate((rid) => {
    const X = (window as unknown as X).__XANDRIA__;
    const CT = X.craftingTest;
    const pool = CT.buildRecipePool(X.spec);
    const r = pool.find((r: any) => r.id === rid);
    if (!r) throw new Error(`recipe ${rid} not in pool [${pool.map((p: any) => p.id).join(',')}] seed=${X.spec.meta.seed}`);
    const inv = X.blueprint.itemKit.inventory;
    for (const ing of r.ingredients) {
      if (inv.count(ing.itemId) < ing.count) inv.add(ing.itemId, ing.count - inv.count(ing.itemId));
    }
  }, recipeId);
  const recipeOut = await page.evaluate((rid) => {
    const X = (window as unknown as X).__XANDRIA__;
    const r2 = X.craftingTest.buildRecipePool(X.spec).find((r: any) => r.id === rid);
    if (!r2) throw new Error(`recipe ${rid} missing from pool`);
    return r2.output.itemId;
  }, recipeId);
  // Teleport to the station with the most node clearance (crafting.spec pattern).
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
  const recipeIndex = await page.evaluate((rid) => {
    const X = (window as unknown as X).__XANDRIA__;
    const idx = X.craftingTest.buildRecipePool(X.spec).findIndex((r: any) => r.id === rid);
    if (idx < 0) throw new Error(`recipe ${rid} missing from pool`);
    return idx;
  }, recipeId);
  expect(recipeIndex).toBeGreaterThanOrEqual(0);
  await page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(recipeIndex).click();
  await waitFor('crafted output lands', async () => (await invCount(recipeOut)) > 0, 60_000);
  await waitFor('craft quest complete', async () => (await mgr.status(craftQuest.id)) === 'complete', 30_000);
  await page.keyboard.press('Escape');
  await waitFor('panel closes', async () => !(await panelOpen()), 30_000);
  await openVillagerDialogue();
  await clickQuestButton(`turnin:${craftQuest.id}`);
  await waitFor('craft quest turned in', async () => (await mgr.status(craftQuest.id)) === 'turned-in', 30_000);
  await dismissLevelUp();
  expect(await mgr.status(gatherQuest.id), 'chain unlocks the gather quest').toBe('available');
  await closeDialogue();

  // ---- GATHER leg: 6 harvests via the real [E] prompt path ----
  await openVillagerDialogue();
  await clickQuestButton(`accept:${gatherQuest.id}`);
  await waitFor('gather quest active', async () => (await mgr.status(gatherQuest.id)) === 'active', 30_000);
  await closeDialogue();
  const gatherCount = gatherQuest.objectives[0].count;
  const nodeSpots = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    return nodes
      .filter((n: any) => stations.every((s: any) =>
        Math.hypot(s.root.position.x - n.root.position.x, s.root.position.z - n.root.position.z) > 5))
      .map((n: any) => ({ id: n.interactable.id, x: n.root.position.x, y: n.root.position.y, z: n.root.position.z }));
  });
  expect(nodeSpots.length).toBeGreaterThanOrEqual(gatherCount);
  const promptedNode = (): Promise<string | null> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.gatheringTest.liveSession()?.promptedNode?.interactable.id ?? null);
  let harvested = 0;
  for (const spot of nodeSpots) {
    if (harvested >= gatherCount) break;
    await page.evaluate(([x, y, z]) => {
      const X = (window as unknown as X).__XANDRIA__;
      const V = X.engine.camera.position.constructor;
      X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
    }, [spot.x, spot.y, spot.z]);
    try {
      await waitFor(`prompt shows ${spot.id}`, async () => (await promptedNode()) === spot.id, 30_000);
    } catch { continue; }
    await page.keyboard.press('e');
    harvested++;
    await page.waitForTimeout(1500); // let the harvest tick land
  }
  expect(harvested).toBeGreaterThanOrEqual(gatherCount);
  await waitFor('gather quest complete', async () => (await mgr.status(gatherQuest.id)) === 'complete', 60_000);
  expect(await mgr.progress(gatherQuest.id)).toEqual([gatherCount]);

  // ---- portal lifecycle: departure/arrival leaves quest state untouched ----
  const beforeCycle = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return {
      snap: X.questTest.liveManager().portalSnapshot(),
      same: X.engine.questManager === X.questTest.liveManager(),
    };
  });
  expect(beforeCycle.same, 'questManager is the blueprint-owned player-scoped object').toBe(true);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void; spawnForMap(s: number): void }>;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.spawnForMap(X.spec.meta.seed);
  });
  const afterCycle = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.questTest.liveManager();
    const storyDefs = M.defs.filter((d: any) => d.id.startsWith('quest_story_'));
    const sideDefs = M.defs.filter((d: any) => d.id.startsWith('quest_side_'));
    return {
      snap: M.portalSnapshot(),
      same: X.engine.questManager === M,
      storyStatuses: storyDefs.map((d: any) => M.statusOf(d.id)),
      sideStatuses: sideDefs.map((d: any) => M.statusOf(d.id)),
    };
  });
  expect(afterCycle.same, 'same manager object after the portal cycle').toBe(true);
  expect(afterCycle.snap).toEqual(beforeCycle.snap);
  expect(afterCycle.storyStatuses).toEqual(['turned-in', 'turned-in', 'turned-in', 'complete']);
  // Side-quests wave: the side quests ride the same manager but were never
  // touched in this run — they must all still be available, untouched by the
  // story line's progress and the portal cycle.
  expect(afterCycle.sideStatuses.length).toBeGreaterThanOrEqual(6);
  expect(afterCycle.sideStatuses.every((s: string) => s === 'available'),
    'untouched side quests stay available').toBe(true);

  // ---- mobile leg: 360x780 — turn in the last quest via a real click ----
  // The portal cycle above respawned the NPC roster with NEW interactable
  // ids (global spawn counter) — re-collect + re-freeze the candidates.
  villagers = await collectVillagers();
  expect(villagers.length).toBeGreaterThanOrEqual(3);
  await freezeVillagers(villagers);
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
  await page.screenshot({ path: '/tmp/quests-dialogue-mobile.png' });
  const gatherRewardId = gatherQuest.rewards.items[0]?.id;
  const gatherRewardBefore = gatherRewardId ? await invCount(gatherRewardId) : 0;
  await clickQuestButton(`turnin:${gatherQuest.id}`);
  await waitFor('gather quest turned in (mobile)', async () => (await mgr.status(gatherQuest.id)) === 'turned-in', 30_000);
  if (gatherRewardId) {
    expect(await invCount(gatherRewardId), `mobile turn-in reward lands (${gatherRewardId})`)
      .toBeGreaterThan(gatherRewardBefore);
  }
  await closeDialogue();
  const trackerBox = await page.evaluate(() => {
    const el = document.getElementById('xandria-quest-tracker') as HTMLElement | null;
    return el ? { display: el.style.display, rect: el.getBoundingClientRect().toJSON() } : null;
  });
  // All quests turned in: the tracker hides (nothing active to show).
  expect(trackerBox?.display).toBe('none');
  await page.screenshot({ path: '/tmp/quests-tracker-mobile.png' });

  expect(errors).toEqual([]);
});

test('quests: quest state survives a real portal transition', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(PORTAL_B64)}&test=1&autostart=1&splash=0`);

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
    return !!(X?.engine && X?.questTest && X?.blueprint?.quests
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar
      && X.engine.portalManager);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  // Accept the first quest via the manager (setup shortcut — the real
  // accept path is proven on the npcs fixture above). Then snapshot.
  const setup = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.questTest.liveManager();
    const first = M.defs[0];
    M.accept(first.id);
    X.__QM = X.engine.questManager; // identity probe across the transition
    return {
      id: first.id,
      kind: first.objectives[0].kind,
      count: first.objectives[0].count,
      status: M.statusOf(first.id),
      progress: M.progressOf(first.id),
      snap: M.portalSnapshot(),
      transitions: X.engine.portalManager.transitions,
    };
  });
  expect(setup.status).toBe('active');

  // Walk north through the portal (enemies-portal.spec.ts pattern).
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const HALF = 4000; // 8km portal fixture
    const tx = 100;
    const tz = HALF - 11;
    const y = E.terrain.heightAt(tx, tz) + 3;
    E.streamFocus = new V(tx, y, tz);
    const av = E.portalsPlayerAvatar;
    av.ctrl.teleport(new V(tx, y, tz));
    const want = Math.PI;
    let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    E.input.look.x = -d / 0.0026;
  });
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
  });
  await waitFor('portal transition fires', () => page.evaluate((n) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.engine.portalManager.transitions >= n && !X.engine.portalManager.transitioning;
  }, setup.transitions + 1), 300_000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject([], null);
  });
  await page.waitForTimeout(5000); // arrival path settles

  // The quest line is player-scoped: same manager, same statuses; progress
  // identical except explore objectives, which advance with transitions.
  const after = await page.evaluate((s) => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.questTest.liveManager();
    const delta = X.engine.portalManager.transitions - s.transitions;
    return {
      sameManager: (X as any).__QM === X.engine.questManager,
      liveSame: X.engine.questManager === M,
      transitions: X.engine.portalManager.transitions,
      statuses: M.defs.map((d: any) => M.statusOf(d.id)),
      progress: M.defs.map((d: any) => ({ id: d.id, p: M.progressOf(d.id) })),
      snap: M.portalSnapshot(),
      delta,
    };
  }, setup);
  expect(after.sameManager, 'same QuestManager object across the transition').toBe(true);
  expect(after.liveSame, 'engine.questManager is the live manager').toBe(true);
  expect(after.transitions).toBeGreaterThan(setup.transitions);
  expect(after.statuses[0]).toBe('active');
  const firstProgress = after.progress[0].p as number[];
  if (setup.kind === 'explore') {
    expect(firstProgress[0]).toBe(Math.min(setup.count, setup.progress[0] + after.delta));
  } else {
    expect(firstProgress).toEqual(setup.progress);
  }
  // Full snapshot equality modulo the explore delta above.
  const snapBefore = JSON.stringify(setup.snap.states);
  const snapAfter = JSON.stringify(after.snap.states);
  if (setup.kind === 'explore') {
    expect(snapAfter).not.toBe(snapBefore); // the walk itself advanced it — by design
  } else {
    expect(snapAfter).toBe(snapBefore);
  }

  expect(errors).toEqual([]);
});
