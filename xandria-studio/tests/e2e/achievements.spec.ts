/**
 * Achievements wave e2e.
 *
 * Test 1 (npcs fixture, seed 20261012 tp-action, desktop + 360x780):
 * earn >=3 achievements via REAL actions —
 *   kill:   1 walker through the real death path (damage -> onDeath ->
 *           engine.hooks onKill) -> First Blood
 *   quest:  the seeded talk quest: [E] dialogue -> Accept -> 3 more
 *           villagers -> complete -> Turn in -> Errand Runner
 *   craft:  real crafting-panel CRAFT click (ingredients topped up via the
 *           inventory seam; the panel -> craft -> onCrafted path is the
 *           thing under test) -> Maker
 * Then: the codex opens via the trophy chip and lists unlocked/locked;
 * a portal despawn/respawn cycle leaves the same manager + unlocks
 * untouched; a full page reload restores unlocks from the Profile.
 *
 * Test 2 (portal-8km fixture): a REAL portal walk fires
 * portalManager.hooks.onAfterTransition -> Wayfarer unlocks; reload
 * preserves it.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to NPCs/stations (never the reverse), all waits poll from
 * Node, prompt targets are read via the sessions' live handles.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();
const PORTAL_RAW = readFileSync(resolve(HERE, 'fixtures/portal-8km.b64'), 'utf8').trim();

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);
const PORTAL_B64 = withItems(PORTAL_RAW);

type X = { __XANDRIA__?: any };

const waitFor = async (
  page: import('@playwright/test').Page,
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs: number,
) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(2000);
  }
};

test('achievements: kill + quest + craft via real actions, codex, portal cycle, reload — desktop + 360x780', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);

  const booted = (): Promise<boolean> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X?.questTest && X?.gatheringTest && X?.craftingTest
      && X?.blueprint?.achievements && X?.engine?.achievementManager
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  });
  await waitFor(page, 'boot', booted, 240_000);

  // God-mode: the bot must not be mauled mid-dialogue.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const unlocked = (id: string): Promise<boolean> => page.evaluate((id) =>
    (window as unknown as X).__XANDRIA__.blueprint.achievements.isUnlocked(id), id);
  const unlockedIds = (): Promise<string[]> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.blueprint.achievements.unlockedIds());

  /** Achievement XP can open the LEVEL UP modal (pauses the game) — the
   *  unlock lands on a throttled poll, so dismiss repeatedly, not once. */
  const dismissLevelUps = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      const btn = page.locator('.lvlopts button').first();
      if (await btn.count() > 0) {
        await btn.click();
        await page.waitForTimeout(1200);
      } else {
        await page.waitForTimeout(1200);
      }
    }
  };

  // ---- KILL leg: 1 walker via the real death path ----
  const killed = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.engine.portalsPlayerAvatar.enemies;
    let roster = M.enemies.filter((e: any) => e.alive && e.spec.kind === 'walker');
    if (!roster.length) M.spawnForMap(X.spec.meta.seed);
    roster = M.enemies.filter((e: any) => e.alive && e.spec.kind === 'walker');
    if (!roster.length) return false;
    roster[0].damage(10000); // real death path: Enemy.die -> onDeath -> hooks onKill
    return true;
  });
  expect(killed, 'a live walker to kill').toBe(true);
  await waitFor(page, 'first-blood unlocks', () => unlocked('first-blood'), 60_000);
  await dismissLevelUps();

  // ---- QUEST leg: the seeded talk quest, real dialogue path ----
  const mgr = {
    status: (id: string): Promise<string> => page.evaluate((id) =>
      (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id), id),
    defs: (): Promise<Array<{ id: string; name: string; objectives: Array<{ kind: string }> }>> =>
      page.evaluate(() => (window as unknown as X).__XANDRIA__.questTest.liveManager().defs
        .map((d: any) => ({ id: d.id, name: d.name, objectives: d.objectives }))),
  };
  const defs = await mgr.defs();
  const talkQuest = defs[0];
  expect(defs.length).toBeGreaterThanOrEqual(1);

  const collectVillagers = (): Promise<string[]> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const npcs = X.blueprint.npcs.npcs.filter((n: any) => n.role === 'villager');
    const nodes = X.gatheringTest.liveManager().nodes as any[];
    const stations = X.craftingTest.liveStations().stations as any[];
    const rivals = [...nodes, ...stations].map((r: any) => r.root.position);
    const clearance = (n: any) => Math.min(...rivals.map((p: any) =>
      Math.hypot(p.x - n.position.x, p.z - n.position.z)));
    return npcs.filter((n: any) => clearance(n) > 4).map((n: any) => n.interactable.id);
  });
  const freezeVillagers = (ids: string[]): Promise<void> => page.evaluate((ids) => {
    const X = (window as unknown as X).__XANDRIA__;
    for (const n of X.blueprint.npcs.npcs) {
      if (ids.includes(n.interactable.id)) { n.state = 'idle'; n.stateT = 1e9; }
    }
  }, ids);
  const villagers = await collectVillagers();
  expect(villagers.length).toBeGreaterThanOrEqual(4);
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
  const openVillagerDialogue = async (exclude: string[] = []): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const vid: string | null = await page.evaluate(([cands, exclude]) => {
        const X = (window as unknown as X).__XANDRIA__;
        const byId = new Map<string, any>(X.blueprint.npcs.npcs.map((n: any) => [n.interactable.id, n]));
        const live = (cands as string[]).filter((id) => !exclude.includes(id) && byId.has(id));
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
        await waitFor(page, 'villager talk prompt', async () => {
          const p = await promptedVillager();
          if (p && !exclude.includes(p)) { won = p; return true; }
          return false;
        }, 15_000);
      } catch { continue; }
      await page.keyboard.press('e');
      await waitFor(page, 'dialogue opens', dialogueOpen, 30_000);
      return won!;
    }
    throw new Error('openVillagerDialogue: no prompt won after 10 attempts');
  };
  const closeDialogue = async (): Promise<void> => {
    await page.keyboard.press('e');
    await waitFor(page, 'dialogue closes', async () => !(await dialogueOpen()), 30_000);
  };

  const talkedTo: string[] = [];
  talkedTo.push(await openVillagerDialogue());
  await clickQuestButton(`accept:${talkQuest.id}`);
  await waitFor(page, 'quest accepted', async () => (await mgr.status(talkQuest.id)) === 'active', 30_000);
  await closeDialogue();
  // talk objectives fire on dialogue open; 3 more distinct villagers complete it
  talkedTo.push(await openVillagerDialogue(talkedTo));
  await closeDialogue();
  talkedTo.push(await openVillagerDialogue(talkedTo));
  await closeDialogue();
  talkedTo.push(await openVillagerDialogue(talkedTo));
  expect(new Set(talkedTo).size, 'four distinct villagers').toBe(4);
  await waitFor(page, 'talk quest complete', async () => (await mgr.status(talkQuest.id)) === 'complete', 30_000);
  await waitFor(page, 'turn-in button appears', () => page.evaluate((id) =>
    !!document.querySelector(`#xandria-dialogue-panel button[data-quest-action="turnin:${id}"]`), talkQuest.id), 30_000);
  await clickQuestButton(`turnin:${talkQuest.id}`);
  await waitFor(page, 'talk quest turned in', async () => (await mgr.status(talkQuest.id)) === 'turned-in', 30_000);
  await dismissLevelUps(); // quest XP + the errand-runner reward XP may level
  await waitFor(page, 'errand-runner unlocks', () => unlocked('errand-runner'), 60_000);
  await dismissLevelUps();
  await closeDialogue();

  // ---- CRAFT leg: real panel click (ingredients topped up via inventory) ----
  const pick = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const CT = X.craftingTest;
    const pool = CT.buildRecipePool(X.spec);
    const inv = X.blueprint.itemKit.inventory;
    const defs = X.spec.custom.items.defs;
    const stations = CT.liveStations().stations as any[];
    for (let i = 0; i < pool.length; i++) {
      const r = pool[i];
      const need = r.stationId ?? 'station_workbench';
      const st = stations.find((s: any) => s.stationId === need);
      if (!st) continue;
      for (const ing of r.ingredients) {
        if (inv.count(ing.itemId) < ing.count) inv.add(ing.itemId, ing.count - inv.count(ing.itemId));
      }
      const ok = CT.checkCraft(pool, r.id, {
        inventory: inv, defs, enabled: true,
        playerLevel: X.blueprint.prog.level,
        skills: X.blueprint.skills ?? undefined,
        stations: new Set([need]),
      }).ok;
      if (!ok) continue;
      const p = st.root.position;
      return { index: i, out: r.output.itemId, x: p.x, y: p.y, z: p.z };
    }
    return null;
  });
  expect(pick, 'a craftable recipe at a live station').toBeTruthy();
  await page.evaluate(([x, y, z]) => {
    const X = (window as unknown as X).__XANDRIA__;
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(new V(x + 1.5, y + 1, z));
  }, [pick!.x, pick!.y, pick!.z]);
  const stationPromptText = (): Promise<string | null> => page.evaluate(() => {
    const el = document.querySelector('#xandria-interact-prompt') as HTMLElement | null;
    return el && el.style.display === 'block' ? el.textContent : null;
  });
  await waitFor(page, 'station prompt', async () => {
    const t = await stationPromptText();
    return !!t && t.includes('Use ');
  }, 60_000);
  await page.keyboard.press('e');
  const panelOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-crafting-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  await waitFor(page, 'crafting panel opens', panelOpen, 30_000);
  const invCount = (id: string): Promise<number> => page.evaluate((id) =>
    (window as unknown as X).__XANDRIA__.blueprint.itemKit.inventory.count(id), id);
  await page.locator('#xandria-crafting-panel button', { hasText: 'CRAFT' }).nth(pick!.index).click();
  await waitFor(page, 'crafted output lands', async () => (await invCount(pick!.out)) > 0, 60_000);
  await waitFor(page, 'maker unlocks', () => unlocked('maker'), 60_000);
  await dismissLevelUps();
  await page.keyboard.press('Escape');
  await waitFor(page, 'panel closes', async () => !(await panelOpen()), 30_000);

  // ---- at least the three target achievements ----
  const ids = await unlockedIds();
  console.log('[achievements] unlocked=' + JSON.stringify(ids));
  for (const id of ['first-blood', 'errand-runner', 'maker']) {
    expect(ids, `achievement ${id} unlocked`).toContain(id);
  }
  expect(ids.length).toBeGreaterThanOrEqual(3);

  // ---- CODEX: trophy chip opens the panel; unlocked + locked listed ----
  await page.locator('#xandria-achievements-chip').click();
  const codexOpen = (): Promise<boolean> => page.evaluate(() => {
    const el = document.getElementById('xandria-achievements-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  });
  await waitFor(page, 'codex opens', codexOpen, 30_000);
  const codexText = await page.evaluate(() =>
    document.getElementById('xandria-achievements-panel')!.textContent);
  expect(codexText).toContain('First Blood');
  expect(codexText).toContain('UNLOCKED');
  expect(codexText).toContain('LOCKED'); // locked achievements are listed too
  expect(codexText).toContain(`${ids.length} / 25`);
  await page.screenshot({ path: '/tmp/achievements-codex-desktop.png' });
  await page.keyboard.press('Escape');
  await waitFor(page, 'codex closes', async () => !(await codexOpen()), 30_000);

  // ---- portal lifecycle: same manager, unlocks untouched ----
  const before = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return {
      same: X.engine.achievementManager === X.blueprint.achievements,
      ids: X.blueprint.achievements.unlockedIds(),
    };
  });
  expect(before.same).toBe(true);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void; spawnForMap(s: number): void }>;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.spawnForMap(X.spec.meta.seed);
  });
  const after = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return {
      same: X.engine.achievementManager === X.blueprint.achievements,
      ids: X.blueprint.achievements.unlockedIds(),
    };
  });
  expect(after.same, 'same manager object after the portal cycle').toBe(true);
  expect(after.ids).toEqual(before.ids);

  // ---- reload: unlocks restore from the Profile ----
  await page.reload();
  await waitFor(page, 'reboot after reload', booted, 240_000);
  const idsAfterReload = await unlockedIds();
  expect(idsAfterReload).toEqual(expect.arrayContaining(['first-blood', 'errand-runner', 'maker']));

  // ---- mobile leg: 360x780 — codex fits the viewport ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(1500);
  await page.locator('#xandria-achievements-chip').click();
  await waitFor(page, 'codex opens on mobile', codexOpen, 30_000);
  const box = await page.evaluate(() => {
    const el = document.getElementById('xandria-achievements-panel') as HTMLElement | null;
    return el ? el.getBoundingClientRect().toJSON() : null;
  });
  expect(box, 'codex has a box on mobile').toBeTruthy();
  expect(box!.left).toBeGreaterThanOrEqual(0);
  expect(box!.right).toBeLessThanOrEqual(360);
  await page.screenshot({ path: '/tmp/achievements-codex-mobile.png' });

  expect(errors, 'zero console/page errors').toEqual([]);
});

test('achievements: real portal walk unlocks Wayfarer; reload preserves it', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(PORTAL_B64)}&test=1&autostart=1&splash=0`);

  const booted = (): Promise<boolean> => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine?.portalManager && X?.engine?.achievementManager
      && X.engine.portalsPlayerAvatar && X.engine.state === 'playing');
  });
  await waitFor(page, 'boot', booted, 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const unlocked = (id: string): Promise<boolean> => page.evaluate((id) =>
    (window as unknown as X).__XANDRIA__.engine.achievementManager.isUnlocked(id), id);
  expect(await unlocked('wayfarer')).toBe(false);

  // Real portal walk (portal-traverse.spec.ts pattern): teleport just inside
  // the N edge, face it, hold W until the trigger fires.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const E = X.engine;
    const V = E.camera.position.constructor;
    const HALF = 4000;
    const tx = 100;
    const tz = HALF - 11;
    const y = E.terrain.heightAt(tx, tz) + 3;
    E.streamFocus = new V(tx, y, tz);
    const av = E.portalsPlayerAvatar;
    av.ctrl.teleport(new V(tx, y, tz));
    av.health = av.maxHealth = 1e9;
    const want = Math.PI; // walk +z (north)
    let d = (want - av.ctrl.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    E.input.look.x = -d / 0.0026;
  });
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject(['forward', 'sprint'], null);
  });
  await waitFor(page, 'portal transition fires', () => page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.engine.portalManager.transitions >= 1;
  }), 300_000);
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__.engine.input.inject([], null);
  });

  // onAfterTransition -> the achievement manager counted the travel
  await waitFor(page, 'wayfarer unlocks', () => unlocked('wayfarer'), 60_000);
  const same = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return {
      same: X.engine.achievementManager === X.blueprint.achievements,
      coord: { ...X.engine.portalManager.coord },
    };
  });
  expect(same.same, 'same manager object after the real transition').toBe(true);
  expect(same.coord).toEqual({ mx: 0, my: 1 });

  // reload: the unlock restores from the Profile (cross-run store)
  await page.reload();
  await waitFor(page, 'reboot after reload', booted, 240_000);
  expect(await unlocked('wayfarer'), 'wayfarer survives reload').toBe(true);

  expect(errors, 'zero console/page errors').toEqual([]);
});
