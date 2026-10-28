/**
 * Timed-quests wave — timed quests against a game-time clock, in the
 * live player page.
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action) + empty item table so
 * the blueprint builds the item kit. The board's offers are replicated
 * INDEPENDENTLY in the page via questTest.buildTimedOffers /
 * timedOfferAt with the same mapSeed the board used — the same
 * replication the unit tests prove headlessly, now against the live
 * board.
 *
 * Test 1 (desktop): board offers == independent replication ->
 * accept through the REAL panel button -> tracker shows the
 * countdown line -> feeding game-time through the manager's own
 * update(dt) (the same method the frame loop calls) drops the
 * remaining time -> accept + complete + turn in through the REAL
 * panel buttons grants exactly the scaled reward (curated items +
 * seeded bonus line) -> a second quest left to expire FAILS with no
 * partial reward, stays visible for Try again, retries with a full
 * clock and zero progress, fails again, and abandons into a
 * deterministic re-roll with no orphaned defs -> portal
 * departure/arrival cycle preserves the timer exactly (snapshot
 * equality inside one synchronous evaluate, so no background frame
 * can interleave game-time).
 * Completion DETECTION goes through the manager's own event methods
 * (onKill/onHarvest/onCraft — the same functions the real death /
 * harvest / craft paths call); the accept / turn-in / retry clicks
 * and the reward grant are fully real. Explore completion detection
 * is proven at unit level (manager update with portal transitions);
 * a real portal walk for the explore variant would duplicate the
 * existing quests.spec.ts portal test at ~10 min.
 *
 * Test 2 (360x780): panel opens from the real chip, fits the
 * viewport, the timed chip does not overlap the radiant chip, accepts
 * a quest, shows the countdown in the tracker, closes with Escape,
 * zero errors.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): waits poll
 * from Node, prompt targets are never read from pill text, and the
 * player is god-moded so ambient enemies can't interrupt the panel
 * legs. Background game-time: in ?test=1 the frame loop advances
 * 10 substeps per rendered frame, so game-time also accrues between
 * evaluates — every assertion that spans two evaluates carries slack
 * for that accrual, and every exact-equality check (portal cycle,
 * re-roll replication) runs inside ONE synchronous evaluate.
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
const DECODED_SPEC = JSON.parse(Buffer.from(B64, 'base64').toString('utf8'));

type X = { __XANDRIA__?: any };

async function boot(page: any) {
  const errors: string[] = [];
  page.on('pageerror', (e: any) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
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
    return !!(X?.engine && X?.questTest && X?.blueprint?.quests && X?.blueprint?.timedBoard
      && X?.blueprint?.timedBoardPanel && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  return errors;
}

const live = {
  boardSlots: (page: any): Promise<Array<{ def: any; status: string; remainingSeconds: number | null }>> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.questTest.liveTimedBoard().getSlots()
      .map((s: any) => ({ def: s.def, status: s.status, remainingSeconds: s.remainingSeconds }))),
  nextSeq: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.questTest.liveTimedBoard().nextSequenceIndex),
  level: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.progressionTest.liveProgression().level),
  xp: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.progressionTest.liveProgression().xp),
  mapSeed: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.portalManager?.worldSeedValue ?? null),
  statusOf: (page: any, id: string): Promise<string> => page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id), id),
  remaining: (page: any, id: string): Promise<number | null> => page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().timeRemaining(id), id),
  elapsed: (page: any, id: string): Promise<number> => page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().elapsedOf(id), id),
  invCount: (page: any, id: string): Promise<number> => page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.blueprint.itemKit.inventory.count(id), id),
  /** Feed game-time through the manager's own update(dt) — the same method the frame loop calls. */
  feedGameTime: (page: any, seconds: number): Promise<void> => page.evaluate((s: number) => {
    (window as unknown as X).__XANDRIA__.questTest.liveManager().update(s);
  }, seconds),
  replicate: (page: any, mapSeed: number, count: number): Promise<any[]> => page.evaluate(
    ([spec, mapSeed2, count2]: any[]) =>
      (window as unknown as X).__XANDRIA__.questTest.buildTimedOffers(spec, { mapSeed: mapSeed2, count: count2 }),
    [DECODED_SPEC, mapSeed, count]),
  replicateAt: (page: any, mapSeed: number, index: number): Promise<any> => page.evaluate(
    ([spec, mapSeed2, index2]: any[]) =>
      (window as unknown as X).__XANDRIA__.questTest.timedOfferAt(spec, { mapSeed: mapSeed2, index: index2 }),
    [DECODED_SPEC, mapSeed, index]),
  driveToComplete: (page: any, def: any): Promise<void> => page.evaluate((d: any) => {
    const mgr = (window as unknown as X).__XANDRIA__.questTest.liveManager();
    const o = d.objectives[0];
    if (o.kind === 'kill') for (let i = 0; i < o.count; i++) mgr.onKill(o.target);
    else if (o.kind === 'gather') mgr.onHarvest(o.target, o.count);
    else if (o.kind === 'craft') for (let i = 0; i < o.count; i++) mgr.onCraft(o.target);
    else throw new Error('e2e cannot drive kind ' + o.kind);
  }, def),
  trackerText: (page: any): Promise<string> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.container.querySelector('#xandria-quest-tracker')?.textContent ?? ''),
  failedViaGiver: (page: any, id: string): Promise<boolean> => page.evaluate((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().actionsForNpc('villager').failed.some((d: any) => d.id === id);
  }, id),
};

async function openTimedPanel(page: any) {
  const visible = await page.locator('#xandria-timed-board-panel').isVisible().catch(() => false);
  if (!visible) {
    await page.locator('#xandria-timed-board-chip').click();
    await expect(page.locator('#xandria-timed-board-panel')).toBeVisible();
  }
}


async function dismissLevelUps(page: any) {
  // Level-up modal (button.lvlopt) pauses the game and covers the whole
  // screen: the established pattern (achievements/dynamic-events/factions
  // specs) clicks an option until none remain. A turn-in of >=100 XP
  // opens one; the timed board sits underneath it until dismissed.
  for (let i = 0; i < 10; i++) {
    const n: number = await page.evaluate(() => document.querySelectorAll('button.lvlopt').length);
    if (n === 0) return;
    await page.evaluate(() => (document.querySelector('button.lvlopt') as HTMLButtonElement).click());
    await page.waitForTimeout(500);
  }
  throw new Error('level-up modal did not dismiss');
}

async function clickPanelButton(page: any, action: string, slot: number) {
  await dismissLevelUps(page);
  await openTimedPanel(page);
  await page.locator(`#xandria-timed-board-panel button[data-timed-action="${action}"][data-timed-slot="${slot}"]`).click();
}

async function waitStatus(page: any, id: string, status: string, timeout = 30_000) {
  await page.waitForFunction(([qid, want]: any[]) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().statusOf(qid) === want;
  }, [id, status], { timeout });
}

test('timed: board replicates, countdown ticks on game-time, complete -> scaled reward, expire -> fail -> retry -> re-roll, portal preserves timer', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await boot(page);

  const worldSeed = await live.mapSeed(page);
  const mapSeed = worldSeed ?? DECODED_SPEC.meta.seed;
  console.log(`[timed] mapSeed=${mapSeed} (worldSeed=${worldSeed})`);

  // ---- leg 1: live board == independent replication ----
  const slots = await live.boardSlots(page);
  console.log('[timed] slots=' + JSON.stringify(slots.map((s) => ({ id: s.def.id, status: s.status, limit: s.def.timed.limitSeconds, scale: s.def.timed.rewardScale, xp: s.def.rewards.xp }))));
  expect(slots.length).toBeGreaterThanOrEqual(1);
  expect(slots.every((s) => s.status === 'available')).toBe(true);
  const replicated = await live.replicate(page, mapSeed, slots.length);
  expect(slots.map((s) => s.def)).toEqual(replicated);
  expect(slots.every((s) => s.def.timed !== undefined)).toBe(true);
  expect(slots.every((s) => s.remainingSeconds === s.def.timed.limitSeconds)).toBe(true);

  // ---- leg 2: countdown ticks on game-time, shown in the tracker ----
  await openTimedPanel(page);
  const first = slots[0].def;
  await clickPanelButton(page, "accept", 0);
  await waitStatus(page, first.id, 'active');
  const trackerBefore = await live.trackerText(page);
  expect(trackerBefore).toContain(first.name);
  expect(trackerBefore).toMatch(/⏱ \d+:\d+ left/);
  const r0 = await live.remaining(page, first.id);
  expect(r0).not.toBeNull();
  await live.feedGameTime(page, 30);
  const r1 = await live.remaining(page, first.id);
  expect(r1).not.toBeNull();
  // At least 25 of the 30 fed game-seconds registered (background
  // accrual only adds decrease); slack covers frames between reads.
  expect(r0! - r1!).toBeGreaterThanOrEqual(25);
  expect(r0! - r1!).toBeLessThanOrEqual(75);
  expect(r1).toBeGreaterThan(0);
  console.log(`[timed] countdown: remaining ${r0} -> ${r1} after feeding 30 game-seconds`);
  // Leave the first quest running (it will fail on its own later or
  // be abandoned by the board's re-rolls — it must not disturb the
  // other legs: its def is slot 0's and stays put until acted on).

  // ---- leg 3: complete in time -> exact scaled reward (real panel buttons) ----
  const fresh = await live.boardSlots(page);
  const completable = fresh.map((s, i) => ({ ...s, slot: i }))
    .filter((s) => ['kill', 'gather', 'craft'].includes(s.def.objectives[0].kind) && s.status === 'available');
  expect(completable.length).toBeGreaterThanOrEqual(1);
  // Prefer a sub-100-XP quest so no level-up muddies the XP delta
  // (xpForNextLevel(1) = 100); otherwise assert inventory only.
  const pick = completable.find((s) => s.def.rewards.xp < 100) ?? completable[0];
  const def = pick.def;
  const rewardById = new Map<string, number>();
  for (const r of [...def.rewards.items, ...(def.rewards.bonus ?? [])]) {
    rewardById.set(r.id, (rewardById.get(r.id) ?? 0) + r.count);
  }
  const rewardLines = [...rewardById.entries()].map(([id, count]) => ({ id, count }));
  const invBefore = new Map<string, number>();
  for (const r of rewardLines) invBefore.set(r.id, await live.invCount(page, r.id));
  const xpBefore = await live.xp(page);
  const levelBefore = await live.level(page);
  await openTimedPanel(page);
  await clickPanelButton(page, "accept", pick.slot);
  await waitStatus(page, def.id, 'active');
  await live.driveToComplete(page, def);
  await waitStatus(page, def.id, 'complete');
  await clickPanelButton(page, "turnin", pick.slot);
  // The board re-rolls the turned-in slot, so the old id leaves the manager.
  await waitStatus(page, def.id, 'unknown');
  for (const r of rewardLines) {
    const after = await live.invCount(page, r.id);
    expect(after - (invBefore.get(r.id) ?? 0), `reward ${r.id} delta`).toBe(r.count);
  }
  if (def.rewards.xp < 100) {
    expect(await live.level(page), 'no level-up on a sub-100-XP turn-in').toBe(levelBefore);
    expect(await live.xp(page) - xpBefore, 'XP delta equals the scaled reward').toBe(def.rewards.xp);
  }
  console.log(`[timed] turn-in: ${def.id} granted xp=${def.rewards.xp} items=${JSON.stringify(rewardLines)}`);

  // ---- leg 4: expire -> fail (no partial reward) -> Try again -> fail again -> abandon re-rolls ----
  const failSlots = await live.boardSlots(page);
  const failPick = failSlots.map((s, i) => ({ ...s, slot: i })).find((s) => s.status === 'available' && s.def.objectives[0].kind !== 'explore');
  expect(failPick, 'an available non-explore timed offer exists for the fail leg').toBeTruthy();
  const failDef = failPick!.def;
  const failRewardById = new Map<string, number>();
  for (const r of [...failDef.rewards.items, ...(failDef.rewards.bonus ?? [])]) {
    failRewardById.set(r.id, (failRewardById.get(r.id) ?? 0) + r.count);
  }
  const failInvBefore = new Map<string, number>();
  for (const id of failRewardById.keys()) failInvBefore.set(id, await live.invCount(page, id));
  await openTimedPanel(page);
  await clickPanelButton(page, "accept", failPick!.slot);
  await waitStatus(page, failDef.id, 'active');
  // Partial progress first: expiry must not pay for it.
  await page.evaluate((d: any) => {
    const mgr = (window as unknown as X).__XANDRIA__.questTest.liveManager();
    const o = d.objectives[0];
    if (o.kind === 'kill') mgr.onKill(o.target);
    else if (o.kind === 'gather') mgr.onHarvest(o.target, 1);
    else if (o.kind === 'craft') mgr.onCraft(o.target);
  }, failDef);
  await live.feedGameTime(page, failDef.timed.limitSeconds + 30);
  await waitStatus(page, failDef.id, 'failed');
  // No partial reward of any kind.
  for (const [id] of failRewardById) {
    expect(await live.invCount(page, id) - (failInvBefore.get(id) ?? 0), `no partial reward for ${id}`).toBe(0);
  }
  // The tracker drops the failed quest; the giver retry surface lists it.
  expect(await live.trackerText(page)).not.toContain(failDef.name);
  expect(await live.failedViaGiver(page, failDef.id)).toBe(true);
  expect(await live.remaining(page, failDef.id)).toBe(0);
  // Try again through the REAL panel button: full clock, zero progress, same def.
  await openTimedPanel(page);
  await clickPanelButton(page, "reaccept", failPick!.slot);
  await waitStatus(page, failDef.id, 'active');
  const retryRemaining = await live.remaining(page, failDef.id);
  expect(retryRemaining).not.toBeNull();
  expect(retryRemaining!).toBeGreaterThanOrEqual(failDef.timed.limitSeconds - 20);
  expect(retryRemaining).toBeLessThanOrEqual(failDef.timed.limitSeconds);
  const retryProgress = await page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().progressOf(id), failDef.id);
  expect(retryProgress).toEqual([0]);
  console.log(`[timed] retry: ${failDef.id} restarted with ${retryRemaining}s on the clock, progress reset`);
  // Fail it a second time, then retry + abandon into a deterministic re-roll.
  await live.feedGameTime(page, failDef.timed.limitSeconds + 30);
  await waitStatus(page, failDef.id, 'failed');
  await openTimedPanel(page);
  const nextIdx = await live.nextSeq(page);
  await clickPanelButton(page, "reaccept", failPick!.slot);
  await waitStatus(page, failDef.id, 'active');
  await clickPanelButton(page, "abandon", failPick!.slot);
  await waitStatus(page, failDef.id, 'unknown');
  const afterAbandon = await live.boardSlots(page);
  const expectedReplacement = await live.replicateAt(page, mapSeed, nextIdx);
  expect(afterAbandon[failPick!.slot].def).toEqual(expectedReplacement);
  expect(afterAbandon[failPick!.slot].status).toBe('available');
  // No orphan defs: every timed def in the manager is a current slot def.
  const orphanCheck = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const slotIds = new Set(X.questTest.liveTimedBoard().getSlots().map((s: any) => s.def.id));
    const timedIds = X.questTest.liveManager().defs.filter((d: any) => d.timed !== undefined).map((d: any) => d.id);
    return { slotIds: [...slotIds].sort(), timedIds: timedIds.sort() };
  });
  expect(orphanCheck.timedIds).toEqual(orphanCheck.slotIds);

  // ---- leg 5: portal departure/arrival cycle preserves the timer exactly ----
  const portalSlots = await live.boardSlots(page);
  const portalPick = portalSlots.map((s, i) => ({ ...s, slot: i })).find((s) => s.status === 'available');
  expect(portalPick, 'an available timed offer exists for the portal leg').toBeTruthy();
  const portalDef = portalPick!.def;
  await openTimedPanel(page);
  await clickPanelButton(page, "accept", portalPick!.slot);
  await waitStatus(page, portalDef.id, 'active');
  await live.feedGameTime(page, 45);
  // One synchronous evaluate: snapshot, run the exact despawn/spawn
  // functions PortalTransition invokes, snapshot again, and restore
  // round-trip — no frame can interleave game-time inside it.
  const cycle = await page.evaluate((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.questTest.liveManager();
    const before = M.portalSnapshot();
    const beforeRemaining = M.timeRemaining(id);
    const systems = X.engine.portalEntities.systems as Array<{ id: string; despawnAll(): void; spawnForMap(s: number): void }>;
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.despawnAll();
    for (const s of systems) if (s.id === 'npcs' || s.id === 'enemies') s.spawnForMap(X.spec.meta.seed);
    const after = M.portalSnapshot();
    // Snapshot/restore round-trip on the same manager must not move the timer.
    M.portalRestore(after);
    const restoredElapsed = M.elapsedOf(id);
    return {
      same: X.engine.questManager === M,
      before,
      after,
      beforeRemaining,
      afterRemaining: M.timeRemaining(id),
      restoredElapsed,
      elapsedBefore: before.states[id]?.elapsed,
    };
  }, portalDef.id);
  expect(cycle.same, 'same manager object after the portal cycle').toBe(true);
  expect(cycle.after).toEqual(cycle.before);
  expect(cycle.afterRemaining).toBe(cycle.beforeRemaining);
  expect(cycle.restoredElapsed).toBe(cycle.elapsedBefore);
  console.log(`[timed] portal cycle: elapsed ${cycle.elapsedBefore}s preserved exactly, remaining ${cycle.afterRemaining}s`);
  // The preserved timer is still live: feeding the rest of the clock fails it.
  const stillRemaining = await live.remaining(page, portalDef.id);
  expect(stillRemaining).not.toBeNull();
  expect(stillRemaining).toBeGreaterThan(0);
  await live.feedGameTime(page, stillRemaining! + 5);
  await waitStatus(page, portalDef.id, 'failed');

  // Story/side quests untouched by the whole timed session.
  const storyStillThere = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().defs.some((d: any) => d.id.startsWith('quest_story_'));
  });
  expect(storyStillThere).toBe(true);

  expect(errors).toEqual([]);
});

test('timed: board panel on 360x780 fits viewport, chips do not overlap, accepts, closes with Escape', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await boot(page);
  await page.locator('#xandria-timed-board-chip').click();
  await expect(page.locator('#xandria-timed-board-panel')).toBeVisible();
  const box = await page.locator('#xandria-timed-board-panel').boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(780);
  // The timed chip sits below the radiant chip without overlapping it.
  const timedChip = await page.locator('#xandria-timed-board-chip').boundingBox();
  const radiantChip = await page.locator('#xandria-radiant-board-chip').boundingBox();
  expect(timedChip).toBeTruthy();
  expect(radiantChip).toBeTruthy();
  const overlaps = timedChip!.y < radiantChip!.y + radiantChip!.height && radiantChip!.y < timedChip!.y + timedChip!.height
    && timedChip!.x < radiantChip!.x + radiantChip!.width && radiantChip!.x < timedChip!.x + timedChip!.width;
  expect(overlaps, 'timed chip must not cover the radiant chip').toBe(false);
  const slots = await live.boardSlots(page);
  const idx = slots.findIndex((s) => s.status === 'available');
  expect(idx).toBeGreaterThanOrEqual(0);
  await page.locator(`#xandria-timed-board-panel button[data-timed-action="accept"][data-timed-slot="${idx}"]`).click();
  await waitStatus(page, slots[idx].def.id, 'active');
  const tracker = await live.trackerText(page);
  expect(tracker).toContain(slots[idx].def.name);
  expect(tracker).toMatch(/⏱ \d+:\d+ left/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#xandria-timed-board-panel')).toBeHidden();
  expect(errors).toEqual([]);
});
