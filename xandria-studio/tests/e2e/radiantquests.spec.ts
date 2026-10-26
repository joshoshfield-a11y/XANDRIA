/**
 * Radiant-quests wave — the endless board in the live player page.
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action) + empty item table so the
 * blueprint builds the item kit. The board's offers are replicated
 * INDEPENDENTLY in the page via questTest.buildRadiantOffers /
 * radiantOfferAt with the same (playerLevel, mapSeed) the board used —
 * the same replication the unit tests prove headlessly, now against the
 * live board.
 *
 * Test 1 (desktop): board offers == independent replication (ids, names,
 * objectives, targets, counts, rewards) -> accept + abandon through the
 * REAL panel buttons -> abandoned slot re-rolls to exactly
 * radiantOfferAt(nextSequenceIndex) -> accept + complete + turn in
 * through the REAL panel buttons -> inventory + XP deltas exactly equal
 * the def's reward lines (curated items + seeded bonus line).
 * Completion DETECTION goes through the manager's own event methods
 * (onKill/onHarvest/onCraft — the same functions the real death /
 * harvest / craft paths call); the accept / turn-in clicks and the
 * reward grant are fully real. Explore/escort completion detection is
 * proven at unit level (manager update with portal transitions + map
 * changes); a real portal walk for those two kinds would duplicate the
 * existing quests.spec.ts portal test at ~10 min per kind.
 *
 * Test 2 (360x780): panel opens from the real chip, fits the viewport,
 * accepts a quest, closes with Escape, zero errors.
 *
 * Hardening (per workers-npcs/INSTANCING.md caveat 6): waits poll from
 * Node, prompt targets are never read from pill text, and the player is
 * god-moded so ambient enemies can't interrupt the panel legs.
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
    return !!(X?.engine && X?.questTest && X?.blueprint?.quests && X?.blueprint?.radiantBoard
      && X?.blueprint?.radiantBoardPanel && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
  return errors;
}

const live = {
  boardSlots: (page: any): Promise<Array<{ def: any; status: string }>> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.questTest.liveRadiantBoard().getSlots()
      .map((s: any) => ({ def: s.def, status: s.status }))),
  nextSeq: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.questTest.liveRadiantBoard().nextSequenceIndex),
  level: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.progressionTest.liveProgression().level),
  xp: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.progressionTest.liveProgression().xp),
  mapSeed: (page: any): Promise<number> => page.evaluate(() =>
    (window as unknown as X).__XANDRIA__.engine.portalManager?.worldSeedValue ?? null),
  statusOf: (page: any, id: string): Promise<string> => page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.questTest.liveManager().statusOf(id), id),
  invCount: (page: any, id: string): Promise<number> => page.evaluate((id: string) =>
    (window as unknown as X).__XANDRIA__.blueprint.itemKit.inventory.count(id), id),
  replicate: (page: any, level: number, mapSeed: number, count: number): Promise<any[]> => page.evaluate(
    ([spec, level2, mapSeed2, count2]: any[]) =>
      (window as unknown as X).__XANDRIA__.questTest.buildRadiantOffers(spec, { playerLevel: level2, mapSeed: mapSeed2, count: count2 }),
    [DECODED_SPEC, level, mapSeed, count]),
  replicateAt: (page: any, level: number, mapSeed: number, index: number): Promise<any> => page.evaluate(
    ([spec, level2, mapSeed2, index2]: any[]) =>
      (window as unknown as X).__XANDRIA__.questTest.radiantOfferAt(spec, { playerLevel: level2, mapSeed: mapSeed2, index: index2 }),
    [DECODED_SPEC, level, mapSeed, index]),
  driveToComplete: (page: any, def: any): Promise<void> => page.evaluate((d: any) => {
    const mgr = (window as unknown as X).__XANDRIA__.questTest.liveManager();
    const o = d.objectives[0];
    if (o.kind === 'kill') for (let i = 0; i < o.count; i++) mgr.onKill(o.target);
    else if (o.kind === 'gather') mgr.onHarvest(o.target, o.count);
    else if (o.kind === 'craft') for (let i = 0; i < o.count; i++) mgr.onCraft(o.target);
    else throw new Error('e2e cannot drive kind ' + o.kind);
  }, def),
};

test('radiant: board offers replicate, abandon re-rolls deterministically, accept -> complete -> reward exactly', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await boot(page);

  const level = await live.level(page);
  const worldSeed = await live.mapSeed(page);
  const mapSeed = worldSeed ?? DECODED_SPEC.meta.seed;
  console.log(`[radiant] level=${level} mapSeed=${mapSeed} (worldSeed=${worldSeed})`);

  // ---- leg 1: live board == independent replication ----
  const slots = await live.boardSlots(page);
  console.log('[radiant] slots=' + JSON.stringify(slots.map((s) => ({ id: s.def.id, status: s.status, kind: s.def.objectives[0].kind }))));
  expect(slots.length).toBeGreaterThanOrEqual(1);
  expect(slots.every((s) => s.status === 'available')).toBe(true);
  const replicated = await live.replicate(page, level, mapSeed, slots.length);
  expect(slots.map((s) => s.def)).toEqual(replicated);
  expect(slots.every((s) => s.def.radiant === true)).toBe(true);

  // ---- leg 2: abandon re-rolls deterministically (real panel buttons) ----
  await page.locator('#xandria-radiant-board-chip').click();
  await expect(page.locator('#xandria-radiant-board-panel')).toBeVisible();
  const nextIdx = await live.nextSeq(page);
  const abandonedId = slots[0].def.id;
  await page.locator('#xandria-radiant-board-panel button[data-radiant-action="accept"][data-radiant-slot="0"]').click();
  await page.waitForFunction((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().statusOf(id) === 'active';
  }, abandonedId, { timeout: 30_000 });
  await page.locator('#xandria-radiant-board-panel button[data-radiant-action="abandon"][data-radiant-slot="0"]').click();
  await page.waitForFunction((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().statusOf(id) === 'unknown';
  }, abandonedId, { timeout: 30_000 });
  const afterAbandon = await live.boardSlots(page);
  const expectedReplacement = await live.replicateAt(page, level, mapSeed, nextIdx);
  expect(afterAbandon[0].def).toEqual(expectedReplacement);
  expect(afterAbandon[0].status).toBe('available');
  // No orphan defs: every radiant def in the manager is a current slot def
  // (guards the 2026-10-25 sync re-entrancy double-roll).
  const orphanCheck = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const slotIds = new Set(X.questTest.liveRadiantBoard().getSlots().map((s: any) => s.def.id));
    const radiantIds = X.questTest.liveManager().defs.filter((d: any) => d.radiant).map((d: any) => d.id);
    return { slotIds: [...slotIds].sort(), radiantIds: radiantIds.sort() };
  });
  expect(orphanCheck.radiantIds).toEqual(orphanCheck.slotIds);
  console.log(`[radiant] abandon: slot 0 re-rolled to ${afterAbandon[0].def.id} (replicated index ${nextIdx})`);

  // ---- leg 3: accept -> complete -> turn in -> reward exactly (real panel buttons) ----
  const completableIdx = afterAbandon.findIndex((s) => ['kill', 'gather', 'craft'].includes(s.def.objectives[0].kind));
  expect(completableIdx).toBeGreaterThanOrEqual(0);
  const def = afterAbandon[completableIdx].def;
  // Aggregate per item id: the bonus line may share an id with the
  // curated items (ids, not lines, are the grant unit — the
  // curated-quest-rewards wave documented the same collision).
  const rewardById = new Map<string, number>();
  for (const r of [...def.rewards.items, ...(def.rewards.bonus ?? [])]) {
    rewardById.set(r.id, (rewardById.get(r.id) ?? 0) + r.count);
  }
  const rewardLines = [...rewardById.entries()].map(([id, count]) => ({ id, count }));
  const invBefore = new Map<string, number>();
  for (const r of rewardLines) invBefore.set(r.id, await live.invCount(page, r.id));
  const xpBefore = await live.xp(page);
  const levelBefore = await live.level(page);
  await page.locator(`#xandria-radiant-board-panel button[data-radiant-action="accept"][data-radiant-slot="${completableIdx}"]`).click();
  await page.waitForFunction((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().statusOf(id) === 'active';
  }, def.id, { timeout: 30_000 });
  await live.driveToComplete(page, def);
  await page.waitForFunction((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().statusOf(id) === 'complete';
  }, def.id, { timeout: 30_000 });
  await page.locator(`#xandria-radiant-board-panel button[data-radiant-action="turnin"][data-radiant-slot="${completableIdx}"]`).click();
  // The board re-rolls the turned-in slot, so the old id leaves the manager.
  await page.waitForFunction((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().statusOf(id) === 'unknown';
  }, def.id, { timeout: 30_000 });
  for (const r of rewardLines) {
    const after = await live.invCount(page, r.id);
    expect(after - (invBefore.get(r.id) ?? 0), `reward ${r.id} delta`).toBe(r.count);
  }
  const levelAfter = await live.level(page);
  expect(levelAfter, 'no level-up on a single radiant turn-in (xpToNext(1) = 100 > reward)').toBe(levelBefore);
  expect(await live.xp(page) - xpBefore, 'XP delta equals the def reward').toBe(def.rewards.xp);
  console.log(`[radiant] turn-in: ${def.id} granted xp=${def.rewards.xp} items=${JSON.stringify(rewardLines)}`);

  // Story/side quests untouched by the whole board session.
  const storyStillThere = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().defs.some((d: any) => d.id.startsWith('quest_story_'));
  });
  expect(storyStillThere).toBe(true);

  expect(errors).toEqual([]);
});

test('radiant: board panel on 360x780 fits viewport, accepts, closes with Escape', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await boot(page);
  await page.locator('#xandria-radiant-board-chip').click();
  await expect(page.locator('#xandria-radiant-board-panel')).toBeVisible();
  const box = await page.locator('#xandria-radiant-board-panel').boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(780);
  const slots = await live.boardSlots(page);
  const idx = slots.findIndex((s) => s.status === 'available');
  expect(idx).toBeGreaterThanOrEqual(0);
  await page.locator(`#xandria-radiant-board-panel button[data-radiant-action="accept"][data-radiant-slot="${idx}"]`).click();
  await page.waitForFunction((id: string) => {
    const X = (window as unknown as X).__XANDRIA__;
    return X.questTest.liveManager().statusOf(id) === 'active';
  }, slots[idx].def.id, { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#xandria-radiant-board-panel')).toBeHidden();
  expect(errors).toEqual([]);
});
