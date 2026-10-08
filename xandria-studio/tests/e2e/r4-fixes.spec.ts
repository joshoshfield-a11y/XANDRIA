/**
 * Round-4 regression tests — REAL browser pages (built dist/player.html).
 *
 * R4-M1: a level-up earned on the same tick as a branch-choice completion
 * must queue behind the choice modal. Drives the REAL blueprint kill path:
 * damage an enemy to death -> onDeath -> grantKillXp (level-up, microtask)
 * -> addProgress (choice modal, sync). Pre-fix this preempted the choice
 * modal and froze quest progress forever.
 *
 * R4-M2: vitality (+25 HP) / secondwind (+1 life) must apply on the FIRST run.
 * Seeds a localStorage profile with both equipped, boots fresh, and reads the
 * avatar's copied values.
 *
 * R4-N2: the intro story card must show on a fresh run (after CLICK TO START
 * -> beginPlay -> clearOverlays) and must NOT show on an in-place restart.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function questSpecJson(): string {
  const spec: any = JSON.parse(readFileSync('tests/e2e/fixtures/export-spec.json', 'utf8'));
  spec.meta.genre = 'third-person-action';
  spec.meta.seed = 1234;
  spec.narrative = {
    premise: 'Ancient Realm of testing. A hero rises.',
    winText: 'Dawn breaks.',
    loseText: 'Darkness falls.',
  };
  spec.progression = { enabled: true, xpPerKill: 100, xpPerPickup: 10 };
  spec.objective = {
    type: 'eliminate',
    count: 1,
    timeLimit: 0,
    description: 'Defeat the wardens',
    stages: [
      {
        id: 's0', type: 'eliminate', count: 1, timeLimit: 0, description: 'Slay the gatekeeper',
        choices: [
          { label: 'Path of Dawn', next: 's1' },
          { label: 'Path of Dusk', next: 's2' },
        ],
      },
      { id: 's1', type: 'eliminate', count: 2, timeLimit: 0, description: 'Dawn trials' },
      { id: 's2', type: 'eliminate', count: 2, timeLimit: 0, description: 'Dusk trials' },
    ],
  };
  return JSON.stringify(spec);
}

function buildPage(specJson: string): string {
  const playerHtml = readFileSync('dist/player.html', 'utf8');
  const specSafe = specJson.replace(/<\/script/gi, '<\\/script');
  return playerHtml.replace('<head>', `<head><script>window.__XANDRIA_SPEC__=${specSafe};</script>`);
}

async function writePage(html: string, name: string): Promise<string> {
  const outPath = join(tmpdir(), name);
  writeFileSync(outPath, html);
  return outPath;
}

const overlayTitles = () =>
  [...document.querySelectorAll('.xhud .overlay h1')].map((h) => h.textContent);

async function killOneEnemy(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const e = X.blueprint.enemies.enemies.find((x: any) => x.alive);
    if (!e) return false;
    e.damage(99999);
    return true;
  });
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
});

test('R4-M1: level-up queues behind the branch-choice modal; quest never freezes', async ({
  browser,
}) => {
  const outPath = await writePage(buildPage(questSpecJson()), 'xandria-e2e-r4m1.html');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + outPath + '?test=1', { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, {
    timeout: 30000,
  });
  // wait for a live enemy to exist
  await page.waitForFunction(
    () => (window as any).__XANDRIA__.blueprint.enemies.enemies.some((e: any) => e.alive),
    null,
    { timeout: 30000 },
  );

  // THE kill: 100 XP -> level-up (microtask) + stage completion (sync choice modal)
  expect(await killOneEnemy(page)).toBe(true);
  await page.waitForFunction(
    () => [...document.querySelectorAll('.xhud .overlay h1')].some((h) => h.textContent === 'CHOOSE YOUR PATH'),
    null,
    { timeout: 5000 },
  );
  // the level-up must NOT have preempted the choice
  expect(await page.evaluate(overlayTitles)).toEqual(['CHOOSE YOUR PATH']);
  expect(await page.evaluate(() => (window as any).__XANDRIA__.engine.state)).toBe('paused');

  // pick Path of Dawn
  await page.click('.xhud .overlay .lvlopt >> nth=0');
  // the queued level-up now surfaces
  await page.waitForFunction(
    () => [...document.querySelectorAll('.xhud .overlay h1')].some((h) => h.textContent === 'LEVEL UP'),
    null,
    { timeout: 5000 },
  );
  // pick an upgrade
  await page.click('.xhud .overlay .lvlopt >> nth=0');
  await page.waitForFunction(() => (window as any).__XANDRIA__.engine.state === 'playing', null, {
    timeout: 5000,
  });

  // the quest advanced to the chosen branch (no soft-lock)
  const stageId = await page.evaluate(() => (window as any).__XANDRIA__.blueprint.objectives.currentStageId);
  expect(stageId).toBe('s1');

  // and progress still works on the new stage: one more kill counts
  await page.waitForFunction(
    () => (window as any).__XANDRIA__.blueprint.enemies.enemies.some((e: any) => e.alive),
    null,
    { timeout: 30000 },
  );
  expect(await killOneEnemy(page)).toBe(true);
  await page.waitForFunction(
    () => (window as any).__XANDRIA__.blueprint.objectives.progress === 1,
    null,
    { timeout: 5000 },
  );
  expect(errors).toEqual([]);
  await ctx.close();
});

test('R4-M2: vitality/secondwind apply on the first run', async ({ browser }) => {
  const outPath = await writePage(buildPage(questSpecJson()), 'xandria-e2e-r4m2.html');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem(
      'xandria.profile.v1',
      JSON.stringify({
        version: 1,
        merit: 100,
        owned: ['vitality', 'secondwind'],
        loadout: ['vitality', 'secondwind'],
        runsPlayed: {},
        runsWon: {},
        bestScore: {},
        bestLevel: {},
        totalKills: 0,
        totalPlaytime: 0,
        dailyBest: {},
      }),
    );
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + outPath + '?test=1', { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, {
    timeout: 30000,
  });
  const stats = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return {
      maxHealth: X.blueprint.avatar.maxHealth,
      health: X.blueprint.avatar.health,
      lives: X.blueprint.avatar.lives,
      specHealth: X.spec.player.health,
      specLives: X.spec.rules.lives,
    };
  });
  // vitality +25 and secondwind +1, on run 1 — no restart needed
  expect(stats.specHealth).toBe(125);
  expect(stats.specLives).toBe(4);
  expect(stats.maxHealth).toBe(125);
  expect(stats.health).toBe(125);
  expect(stats.lives).toBe(4);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('R5-M1: buying vitality/secondwind in the title shop applies on START', async ({ browser }) => {
  const outPath = await writePage(buildPage(questSpecJson()), 'xandria-e2e-r5m1.html');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // merit to spend, nothing owned: the purchase happens through the real UI
  await page.addInitScript(() => {
    localStorage.setItem(
      'xandria.profile.v1',
      JSON.stringify({
        version: 1,
        merit: 100,
        owned: [],
        loadout: [],
        runsPlayed: {},
        runsWon: {},
        bestScore: {},
        bestLevel: {},
        totalKills: 0,
        totalPlaytime: 0,
        dailyBest: {},
      }),
    );
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + outPath, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, {
    timeout: 30000,
  });
  // the avatar was built at boot with the page-load (empty) loadout
  const before = await page.evaluate(() => (window as any).__XANDRIA__.blueprint.avatar.maxHealth);
  expect(before).toBe(100);
  // buy vitality + secondwind through the real shop UI (auto-equips on buy)
  for (const name of ['Vitality', 'Second Wind']) {
    await page.evaluate((modName: string) => {
      const mods = [...document.querySelectorAll('.xhud .mods .mod')];
      const el = mods.find((m) => m.querySelector('.mn')?.textContent === modName);
      if (!el) throw new Error(modName + ' mod not found');
      (el as HTMLElement).click();
    }, name);
    await page.waitForFunction(
      (modName: string) => {
        const mods = [...document.querySelectorAll('.xhud .mods .mod')];
        const el = mods.find((m) => m.querySelector('.mn')?.textContent === modName);
        return el?.classList.contains('equipped') ?? false;
      },
      name,
      { timeout: 5000 },
    );
  }
  // START: beginPlay applies the loadout and re-syncs the avatar's copies
  await page.evaluate(() => (document.querySelector('.xhud .title-screen .start-btn') as HTMLElement).click());
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, {
    timeout: 10000,
  });
  const stats = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return {
      maxHealth: X.blueprint.avatar.maxHealth,
      health: X.blueprint.avatar.health,
      lives: X.blueprint.avatar.lives,
    };
  });
  expect(stats.maxHealth).toBe(125);
  expect(stats.health).toBe(125);
  expect(stats.lives).toBe(4);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('R4-N2: intro card shows on fresh run, not on restart', async ({ browser }) => {
  const outPath = await writePage(buildPage(questSpecJson()), 'xandria-e2e-r4n2.html');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // normal (non-test) mode: title screen first
  await page.goto('file://' + outPath, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, {
    timeout: 30000,
  });
  await page.evaluate(() => (document.querySelector('.xhud .title-screen .start-btn') as HTMLElement).click());
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, {
    timeout: 10000,
  });
  // beginPlay runs after clearOverlays — the card must be visible (3.5s auto-dismiss)
  await page.waitForFunction(() => !!document.querySelector('.xhud .card'), null, { timeout: 5000 });
  const cardText = await page.evaluate(() => document.querySelector('.xhud .card')?.textContent ?? '');
  expect(cardText).toContain('Ancient Realm');
  // let it auto-dismiss, then restart in place: no card on rebuilds
  await page.waitForFunction(() => !document.querySelector('.xhud .card'), null, { timeout: 8000 });
  await page.evaluate(() => (window as any).__XANDRIA__.engine.restart());
  await page.waitForTimeout(1500);
  const cardAfter = await page.evaluate(() => !!document.querySelector('.xhud .card'));
  expect(cardAfter).toBe(false);
  expect(errors).toEqual([]);
  await ctx.close();
});
