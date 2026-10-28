/**
 * Dialogue-branching wave — branching NPC dialogue trees in the live
 * player page. Desktop + 360x780, zero console/page errors.
 *
 * Test 1 (desktop): the settler tree on a real villager, through the
 * real [E] prompt + DialoguePanel path:
 *   - first open: greeting node, returnLines NOT shown; the
 *     standing-gated 'trusted' choice renders LOCKED (disabled, with
 *     its reason); offer-help / ask-news / brush-off unlocked.
 *   - item gate: 'show-token' locked with no mat_scrap; granting 1
 *     mat_scrap through the real inventory unlocks it; choosing it
 *     lands on the token node and sets the showed-token flag.
 *   - choice A: offer-help -> take-job accepts the FIRST quest (the
 *     story line head) via the quest seam; job-status unlocks once
 *     the quest is active and lands on the progress node.
 *   - standing gate: raising Freeholds to 300 through the live
 *     standings store unlocks 'trusted'; the trusted node accepts
 *     nothing new (quest already active) and errors nothing.
 *   - choice B: brush-off drops Freeholds by exactly 10 and lands on
 *     cold with the brushed-off flag; apologize restores +5.
 *   - return visit: reopening shows the greeting returnLines.
 *   - portal leg: despawnAll/spawnForMap (the exact functions
 *     PortalTransition invokes) leave dialogue state byte-equal, on
 *     the same object. The capture/apply slice (PlayerStateSnapshot)
 *     is proven in unit tests, since the npcs fixture has portals
 *     disabled and no PortalManager exists here.
 *   - reload legs: a full page rebuild restores dialogue state +
 *     standings from localStorage; clearing only the dialogue key
 *     resets dialogue state while standings survive (separate keys).
 *
 * Test 2 (mobile 360x780): the panel fits the viewport, choice
 * buttons are >= 28px tall, and a real choice click navigates.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): the player is
 * teleported to NPCs (never the reverse), all waits poll from Node,
 * and prompt targets are read via the talk session's live handles
 * (promptedNpc), never pill text. NPC ids are re-collected after the
 * portal cycle (respawns reissue ids).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);

type X = { __XANDRIA__?: any };

async function boot(page: any, errors: string[]) {
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      return !!(X?.engine && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar
        && X.dialogueTest && X.factionsTest && X.questTest
        && X.blueprint?.dialogueState && X.blueprint?.talkSession);
    });
    if (ok) return;
    if (Date.now() - t0 > 240_000) throw new Error('boot timeout');
    await page.waitForTimeout(1000);
  }
}

async function settleModals(page: any) {
  for (let i = 0; i < 5; i++) {
    const n: number = await page.evaluate(() => document.querySelectorAll('button.lvlopt').length);
    if (n > 0) {
      await page.evaluate(() => (document.querySelector('button.lvlopt') as HTMLButtonElement).click());
    }
    const settled: boolean = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      if (document.querySelectorAll('button.lvlopt').length > 0) return false;
      if (X.engine.state === 'paused') X.engine.resume();
      return X.engine.state === 'playing';
    });
    if (settled) return;
    await page.waitForTimeout(1000);
  }
}

test('dialogue: branching trees, gated choices, portal + reload preserve state', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await boot(page, errors);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(1000);
    }
  };

  // ---- villager handles (quests.spec.ts pattern) ----
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
  let villagers = await collectVillagers();
  expect(villagers.length).toBeGreaterThanOrEqual(1);
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
  const dialogueNode = (): Promise<string | null> => page.evaluate(() =>
    document.getElementById('xandria-dialogue-panel')?.getAttribute('data-dialogue-node') ?? null);
  const dialogueText = (): Promise<string> => page.evaluate(() =>
    (document.querySelector('[data-dialogue-text]') as HTMLElement)?.getAttribute('data-dialogue-text') ?? '');
  const choiceInfo = (id: string): Promise<{ exists: boolean; locked: boolean; label: string; height: number }> =>
    page.evaluate((id) => {
      const btn = document.querySelector(`#xandria-dialogue-panel button[data-dialogue-choice="${id}"]`) as HTMLButtonElement | null;
      if (!btn) return { exists: false, locked: false, label: '', height: 0 };
      const r = btn.getBoundingClientRect();
      return { exists: true, locked: btn.disabled, label: btn.textContent ?? '', height: r.height };
    }, id);
  const clickChoice = async (id: string): Promise<void> => {
    await page.locator(`#xandria-dialogue-panel button[data-dialogue-choice="${id}"]`).click();
  };
  const openVillagerDialogue = async (): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const vid: string | null = await page.evaluate((cands) => {
        const X = (window as unknown as X).__XANDRIA__;
        const byId = new Map<string, any>(X.blueprint.npcs.npcs.map((n: any) => [n.interactable.id, n]));
        const live = cands.filter((id: string) => byId.has(id));
        return live[0] ?? null;
      }, villagers);
      if (!vid) throw new Error('no villager candidates left');
      await teleportNearVillager(vid);
      let won: string | null = null;
      try {
        await waitFor('villager talk prompt', async () => {
          const p = await promptedVillager();
          if (p) { won = p; return true; }
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
  const firstQuestId = (): Promise<string> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().defs[0].id);
  const questStatus = (id: string): Promise<string> => page.evaluate((id) =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id), id);
  const dialogueSnapshot = (): Promise<{ visited: string[]; choices: string[]; flags: string[]; lastNode: Record<string, string> }> =>
    page.evaluate(() => (window as unknown as X).__XANDRIA__.dialogueTest.liveState().portalSnapshot());
  const hasFlag = (flag: string): Promise<boolean> => page.evaluate((flag) =>
    (window as unknown as X).__XANDRIA__.dialogueTest.liveState().hasFlag(flag), flag);
  const standingOf = (faction: string): Promise<number> => page.evaluate((faction) =>
    (window as unknown as X).__XANDRIA__.factionsTest.liveStandings().standingOf(faction), faction);

  const firstId = await firstQuestId();
  expect(await questStatus(firstId)).toBe('available');

  // ---- first open: greeting, gated choice locked, touch targets ----
  await openVillagerDialogue();
  expect(await dialogueNode()).toBe('greeting');
  expect(await dialogueText()).toContain('walked a long way');
  expect(await dialogueText()).not.toContain('Back again');
  const trusted0 = await choiceInfo('trusted');
  expect(trusted0.exists).toBe(true);
  expect(trusted0.locked).toBe(true);
  expect(trusted0.label).toContain('250');
  const help0 = await choiceInfo('offer-help');
  expect(help0.exists).toBe(true);
  expect(help0.locked).toBe(false);
  expect(help0.height).toBeGreaterThanOrEqual(28);
  expect((await choiceInfo('brush-off')).locked).toBe(false);

  // ---- item gate: show-token locked, then unlocked by holding mat_scrap ----
  await clickChoice('ask-news');
  expect(await dialogueNode()).toBe('news');
  expect((await choiceInfo('show-token')).locked).toBe(true);
  const grant = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const leftover = X.blueprint.itemKit.inventory.add('mat_scrap', 1);
    return { leftover, count: X.blueprint.itemKit.inventory.count('mat_scrap') };
  });
  expect(grant.leftover, 'mat_scrap is a real item def').toBe(0);
  expect(grant.count).toBe(1);
  await clickChoice('back');
  expect(await dialogueNode()).toBe('greeting');
  await clickChoice('ask-news');
  expect((await choiceInfo('show-token')).locked).toBe(false);
  await clickChoice('show-token');
  expect(await dialogueNode()).toBe('token');
  expect(await hasFlag('showed-token')).toBe(true);
  await clickChoice('farewell');
  await waitFor('dialogue closes after farewell', async () => !(await dialogueOpen()), 30_000);

  // ---- choice A: offer-help -> take-job accepts the first quest ----
  await openVillagerDialogue();
  expect(await dialogueText()).toContain('Back again');
  await clickChoice('offer-help');
  expect(await dialogueNode()).toBe('offer');
  await clickChoice('take-job');
  expect(await dialogueNode()).toBe('accepted');
  expect(await questStatus(firstId)).toBe('active');
  expect(await hasFlag('took-job')).toBe(true);
  // quest-state gate: job-status unlocked now that the quest is active
  expect((await choiceInfo('job-status')).locked).toBe(false);
  await clickChoice('job-status');
  expect(await dialogueNode()).toBe('progress');
  await clickChoice('farewell');
  await waitFor('dialogue closes after farewell', async () => !(await dialogueOpen()), 30_000);

  // ---- standing gate: trusted locked at 0, unlocked at 300 ----
  expect(await standingOf('freeholds')).toBe(0);
  await openVillagerDialogue();
  expect((await choiceInfo('trusted')).locked).toBe(true);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.factionsTest.liveStandings().adjust('freeholds', 300);
  });
  expect(await standingOf('freeholds')).toBe(300);
  await closeDialogue();
  await openVillagerDialogue();
  expect((await choiceInfo('trusted')).locked).toBe(false);
  await clickChoice('trusted');
  expect(await dialogueNode()).toBe('trusted');
  expect(await dialogueText()).toContain('trusted folk');
  await clickChoice('trusted-job');
  expect(await dialogueNode()).toBe('accepted');
  // the quest was already active: the accept effect honestly no-ops
  expect(await questStatus(firstId)).toBe('active');
  await clickChoice('farewell');
  await waitFor('dialogue closes after farewell', async () => !(await dialogueOpen()), 30_000);

  // ---- choice B: brush-off drops standing by exactly 10, then apologize ----
  const beforeRude = await standingOf('freeholds');
  await openVillagerDialogue();
  await clickChoice('brush-off');
  expect(await dialogueNode()).toBe('cold');
  expect(await standingOf('freeholds')).toBe(beforeRude - 10);
  expect(await hasFlag('brushed-off')).toBe(true);
  await clickChoice('apologize');
  expect(await dialogueNode()).toBe('greeting');
  expect(await standingOf('freeholds')).toBe(beforeRude - 5);
  await closeDialogue();

  // ---- portal leg: despawn/spawn leaves dialogue state equal, same object ----
  // (The npcs fixture has portals disabled, so there is no PortalManager
  // here — the same standing as the quests/factions portal legs, which
  // drive despawnAll/spawnForMap, the exact functions PortalTransition
  // invokes. The capture/apply slice itself is proven in unit tests.)
  const portal = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const state = X.dialogueTest.liveState();
    const before = state.portalSnapshot();
    const sameObjectBefore = X.dialogueTest.liveState() === X.engine.dialogueState;
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void; spawnForMap(s: number): void }>;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies' || s.id === 'vendors') s.despawnAll();
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies' || s.id === 'vendors') s.spawnForMap(X.spec.meta.seed);
    const afterCycle = state.portalSnapshot();
    const sameObjectAfter = X.dialogueTest.liveState() === X.engine.dialogueState;
    return { before, afterCycle, sameObjectBefore, sameObjectAfter };
  });
  expect(portal.sameObjectBefore).toBe(true);
  expect(portal.sameObjectAfter).toBe(true);
  expect(portal.afterCycle).toEqual(portal.before);
  expect(portal.before.visited).toContain('settler:greeting');
  expect(portal.before.flags).toEqual(expect.arrayContaining(['took-job', 'brushed-off', 'showed-token']));
  // NPC ids were reissued by the respawn — re-collect before any later open
  villagers = await collectVillagers();
  await freezeVillagers(villagers);

  // ---- reload leg: full rebuild restores dialogue state + standings ----
  const standingBeforeReload = await standingOf('freeholds');
  await boot(page, errors);
  await settleModals(page);
  const reloaded = await dialogueSnapshot();
  expect(reloaded.visited).toContain('settler:greeting');
  expect(reloaded.flags).toEqual(expect.arrayContaining(['took-job', 'brushed-off', 'showed-token']));
  expect(reloaded.lastNode['settler']).toBe('greeting');
  expect(await standingOf('freeholds')).toBe(standingBeforeReload);
  // Quest progress does NOT survive a full page reload (pre-existing
  // quest-system behavior: the manager rebuilds from the seeded pool
  // each boot and only portal snapshots persist it) — the roster head
  // is 'available' again, pinned here so the distinction stays honest.
  // Dialogue state and standings are the two systems that persist
  // here, and both do.
  expect(await questStatus(firstId)).toBe('available');
  // reopening after reload still shows the remembered greeting
  villagers = await collectVillagers();
  await freezeVillagers(villagers);
  await openVillagerDialogue();
  expect(await dialogueText()).toContain('Back again');
  await closeDialogue();

  // ---- storage-clear leg: wiping only the dialogue key resets dialogue, not standings ----
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    localStorage.removeItem(`xandria.dialogue.v1:${X.spec.meta.seed >>> 0}`);
  });
  await boot(page, errors);
  const cleared = await dialogueSnapshot();
  expect(cleared).toEqual({ version: 1, visited: [], choices: [], flags: [], lastNode: {} });
  expect(await standingOf('freeholds')).toBe(standingBeforeReload);

  expect(errors, 'zero console/page errors').toEqual([]);
});

test('dialogue: panel fits 360x780, choice click navigates on mobile', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.setViewportSize({ width: 360, height: 780 });

  await boot(page, errors);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  const waitFor = async (label: string, fn: () => Promise<boolean>, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      if (await fn()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
      await page.waitForTimeout(1000);
    }
  };
  const villagers: string[] = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.blueprint.npcs.npcs.filter((n: any) => n.role === 'villager').map((n: any) => n.interactable.id);
  });
  expect(villagers.length).toBeGreaterThanOrEqual(1);
  await page.evaluate((ids) => {
    const X = (window as unknown as X).__XANDRIA__;
    for (const n of X.blueprint.npcs.npcs) {
      if (ids.includes(n.interactable.id)) { n.state = 'idle'; n.stateT = 1e9; }
    }
  }, villagers);
  await page.evaluate((vid) => {
    const X = (window as unknown as X).__XANDRIA__;
    const n = X.blueprint.npcs.npcs.find((n: any) => n.interactable.id === vid);
    const p = n.position;
    const V = X.engine.camera.position.constructor;
    X.engine.portalsPlayerAvatar.ctrl.teleport(new V(p.x + 2, p.y + 1, p.z));
  }, villagers[0]);
  await waitFor('villager talk prompt', () => page.evaluate(() =>
    !!(window as unknown as X).__XANDRIA__.questTest.liveTalkSession()?.promptedNpc), 30_000);
  await page.keyboard.press('e');
  await waitFor('dialogue opens', () => page.evaluate(() => {
    const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
    return !!el && el.style.display !== 'none';
  }), 30_000);

  const fit = await page.evaluate(() => {
    const panel = document.getElementById('xandria-dialogue-panel') as HTMLElement;
    const r = panel.getBoundingClientRect();
    const btn = document.querySelector('#xandria-dialogue-panel button[data-dialogue-choice="offer-help"]') as HTMLButtonElement;
    const br = btn.getBoundingClientRect();
    return { right: r.right, width: r.width, btnHeight: br.height, btnRight: br.right };
  });
  expect(fit.right).toBeLessThanOrEqual(360);
  expect(fit.btnHeight).toBeGreaterThanOrEqual(28);
  expect(fit.btnRight).toBeLessThanOrEqual(360);

  await page.locator('#xandria-dialogue-panel button[data-dialogue-choice="offer-help"]').click();
  await waitFor('offer node', () => page.evaluate(() =>
    document.getElementById('xandria-dialogue-panel')?.getAttribute('data-dialogue-node') === 'offer'), 30_000);
  await page.keyboard.press('e');
  await waitFor('dialogue closes', () => page.evaluate(() => {
    const el = document.getElementById('xandria-dialogue-panel') as HTMLElement | null;
    return !el || el.style.display === 'none';
  }), 30_000);

  expect(errors, 'zero console/page errors').toEqual([]);
});
