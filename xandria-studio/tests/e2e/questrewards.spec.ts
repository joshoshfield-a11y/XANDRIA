/**
 * Curated-quest-rewards e2e: per-quest curated rewards are exact at turn-in.
 *
 * Boots the npcs fixture (seed 20261012, tp-action) with the item tables,
 * then for EVERY story quest in the seeded line:
 *   1. Def-level: rewards.xp + rewards.items equal the curated table for
 *      that template slug; rewards.bonus[0] equals the INDEPENDENT
 *      replication questBonusItem(seed, slug) (a separate call, not read
 *      back out of the def).
 *   2. Turn-in through the REAL manager path: accept -> complete (real
 *      event methods for kill/gather/craft/talk; for explore quests the
 *      completion DETECTION is simulated via the manager's own advance()
 *      while the turnIn() grant path stays real) -> turnIn -> the exact
 *      curated item counts + the exact bonus count land in the live
 *      inventory (deltas measured per quest, so chain accumulation never
 *      contaminates the assertions).
 *
 * Desktop + 360x780. Zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Same deterministic scene, plus an empty item table so the blueprint
// builds the item kit (ensureCraftingItemDefs + ensureLootItemDefs fill
// the crafting/loot defs at boot; crafting + quests enabled by default).
const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);

type X = { __XANDRIA__?: any };

const waitForBoot = async (page: any) => {
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
      && X?.engine.state === 'playing' && X?.engine.portalsPlayerAvatar);
  }), 240_000);
};

test('quest rewards: every story turn-in grants its exact curated reward + replicated bonus', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  await waitForBoot(page);

  // God-mode so stray enemies can't interrupt the harness.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });

  const result = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const QT = X.questTest;
    const mgr = QT.liveManager();
    const inv = X.blueprint.itemKit.inventory;
    const seed: number = X.spec.meta.seed;
    const findings: string[] = [];
    let covered = 0;
    let bonusReplicated = 0;

    const defs = mgr.defs.filter((d: any) => d.id.startsWith('quest_story_'));
    if (defs.length === 0) throw new Error('no story quests in the pool');

    const snap = (): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const d of defs) {
        for (const l of [...d.rewards.items, ...(d.rewards.bonus ?? [])]) {
          m[l.id] = inv.count(l.id);
        }
      }
      return m;
    };

    for (const def of defs) {
      const slug = def.id.replace(/^quest_story_\d+_/, '');
      const curated = QT.CURATED_STORY_REWARDS[slug];
      if (!curated) { findings.push(`${def.id}: no curated table for slug ${slug}`); continue; }

      // 1. Def-level exactness vs the curated table.
      if (def.rewards.xp !== curated.xp) findings.push(`${def.id}: xp ${def.rewards.xp} != curated ${curated.xp}`);
      if (JSON.stringify(def.rewards.items) !== JSON.stringify(curated.items))
        findings.push(`${def.id}: items ${JSON.stringify(def.rewards.items)} != curated ${JSON.stringify(curated.items)}`);

      // 2. Bonus line matches the INDEPENDENT replication (separate call).
      const replicated = QT.questBonusItem(seed, slug);
      if (JSON.stringify(def.rewards.bonus) !== JSON.stringify([replicated]))
        findings.push(`${def.id}: bonus ${JSON.stringify(def.rewards.bonus)} != replicated ${JSON.stringify(replicated)}`);
      else bonusReplicated++;

      // 3. Real turn-in path: accept -> complete -> turnIn, then measure
      // the inventory delta for every reward line.
      if (!mgr.accept(def.id)) { findings.push(`${def.id}: accept failed`); continue; }
      for (const o of def.objectives) {
        if (o.kind === 'kill') { for (let i = 0; i < o.count; i++) mgr.onKill(o.target); }
        else if (o.kind === 'gather') mgr.onHarvest(o.target === 'any' ? 'mat_ore' : o.target, o.count);
        else if (o.kind === 'craft') mgr.onCraft(o.target);
        else if (o.kind === 'talk') { for (let i = 0; i < o.count; i++) mgr.onTalk('villager'); }
        else if (o.kind === 'explore') {
          // Completion DETECTION simulated through the manager's own
          // advance(); the turnIn() grant path below stays fully real.
          (mgr as any).advance(o.kind, o.target, o.count);
        }
      }
      if (mgr.statusOf(def.id) !== 'complete') { findings.push(`${def.id}: never completed`); continue; }
      const before = snap();
      if (!mgr.turnIn(def.id)) { findings.push(`${def.id}: turnIn failed`); continue; }
      const after = snap();
      for (const l of def.rewards.items) {
        const got = (after[l.id] ?? 0) - (before[l.id] ?? 0);
        if (got !== l.count) findings.push(`${def.id}: curated ${l.id} granted ${got}, expected ${l.count}`);
      }
      for (const l of (def.rewards.bonus ?? [])) {
        const got = (after[l.id] ?? 0) - (before[l.id] ?? 0);
        if (got !== l.count) findings.push(`${def.id}: bonus ${l.id} granted ${got}, expected ${l.count}`);
      }
      covered++;
    }
    return { findings, covered, total: defs.length, bonusReplicated };
  });

  expect(result.findings, `reward mismatches: ${result.findings.join('; ')}`).toEqual([]);
  expect(result.covered).toBe(result.total);
  expect(result.bonusReplicated).toBe(result.total);
  expect(errors).toEqual([]);
});

test('quest rewards: same assertions at 360x780', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.setViewportSize({ width: 360, height: 780 });

  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  await waitForBoot(page);

  const result = await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    const QT = X.questTest;
    const mgr = QT.liveManager();
    const inv = X.blueprint.itemKit.inventory;
    const seed: number = X.spec.meta.seed;
    const findings: string[] = [];
    let covered = 0;
    const defs = mgr.defs.filter((d: any) => d.id.startsWith('quest_story_'));
    for (const def of defs) {
      const slug = def.id.replace(/^quest_story_\d+_/, '');
      const curated = QT.CURATED_STORY_REWARDS[slug];
      if (!curated) { findings.push(`${def.id}: no curated table`); continue; }
      if (def.rewards.xp !== curated.xp) findings.push(`${def.id}: xp mismatch`);
      if (JSON.stringify(def.rewards.items) !== JSON.stringify(curated.items))
        findings.push(`${def.id}: items mismatch`);
      const replicated = QT.questBonusItem(seed, slug);
      if (JSON.stringify(def.rewards.bonus) !== JSON.stringify([replicated]))
        findings.push(`${def.id}: bonus != replicated`);
      if (!mgr.accept(def.id)) { findings.push(`${def.id}: accept failed`); continue; }
      for (const o of def.objectives) {
        if (o.kind === 'kill') { for (let i = 0; i < o.count; i++) mgr.onKill(o.target); }
        else if (o.kind === 'gather') mgr.onHarvest(o.target === 'any' ? 'mat_ore' : o.target, o.count);
        else if (o.kind === 'craft') mgr.onCraft(o.target);
        else if (o.kind === 'talk') { for (let i = 0; i < o.count; i++) mgr.onTalk('villager'); }
        else if (o.kind === 'explore') (mgr as any).advance(o.kind, o.target, o.count);
      }
      if (mgr.statusOf(def.id) !== 'complete') { findings.push(`${def.id}: never completed`); continue; }
      const before = inv.count(def.rewards.items[0].id);
      if (!mgr.turnIn(def.id)) { findings.push(`${def.id}: turnIn failed`); continue; }
      const got = inv.count(def.rewards.items[0].id) - before;
      if (got !== def.rewards.items[0].count) findings.push(`${def.id}: first curated line granted ${got}`);
      covered++;
    }
    return { findings, covered, total: defs.length };
  });

  expect(result.findings, `reward mismatches: ${result.findings.join('; ')}`).toEqual([]);
  expect(result.covered).toBe(result.total);
  expect(errors).toEqual([]);
});
