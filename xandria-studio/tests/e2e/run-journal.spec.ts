/**
 * Run-journal wave e2e.
 *
 * Runs WITHOUT ?test=1 (like daily-challenge.spec.ts) so the real title
 * screen shows and profile persistence actually writes (testMode skips both).
 *
 * Desktop test — two full runs with different observed stats, recorded exactly:
 *   run 1: 3 real walker kills (real death path: Enemy.damage -> die ->
 *          onDeath -> hooks onKill -> engine journal counter) + 1 real player
 *          death (PlayerAvatar.damage -> die -> onPlayerDeath) -> engine.lose()
 *          -> the recap shows the exact counts -> localStorage journal entry 1
 *          matches them exactly.
 *   run 2: RESTART button -> 1 kill, 0 deaths -> engine.win() -> recap exact ->
 *          journal newest-first [run2, run1].
 *   then: title screen -> journal button opens the panel: 2 .jr-row rows,
 *         newest first, every dataset value matching the stored entries
 *         exactly. Reload -> journal persists (2 rows still listed).
 * Mobile test (360x780) — condensed: empty journal -> 1 kill -> win ->
 *   recap + panel row render cleanly.
 *
 * Hardening notes: kills go through the real death path (never a counter
 * injection); the player is god-moded during the kill legs (never the
 * reverse); level-up modals from kill XP are dismissed the proven way
 * (.lvlopts clicks, achievements.spec.ts) since a paused game ignores
 * engine.lose()/win().
 */
import { test, expect } from '@playwright/test';

const INTENT = 'neon fps arena at night';
const URL = `/player.html?intent=${encodeURIComponent(INTENT)}&splash=0`;

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
    await page.waitForTimeout(1000);
  }
};

async function gotoTitle(page: import('@playwright/test').Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e?.message ?? e)));
  await page.goto(URL, { waitUntil: 'load' });
  await waitFor(page, 'title state', async () =>
    page.evaluate(() => (window as unknown as X).__XANDRIA__?.engine?.state === 'title'), 120_000);
  return errors;
}

const stateIs = (page: import('@playwright/test').Page, s: string) =>
  waitFor(page, `state=${s}`, async () =>
    page.evaluate((want) => (window as unknown as X).__XANDRIA__?.engine?.state === want, s), 60_000);

/** Achievement/kill XP can open the LEVEL UP modal (pauses the game) — dismiss repeatedly. */
const dismissLevelUps = async (page: import('@playwright/test').Page): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    const btn = page.locator('.lvlopts button').first();
    if (await btn.count() > 0) {
      await btn.click();
      await page.waitForTimeout(1200);
    } else {
      await page.waitForTimeout(600);
    }
  }
};

const godMode = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  X.blueprint.avatar.health = X.blueprint.avatar.maxHealth = 1e9;
});

/** Kill `n` walkers via the real death path. Returns the number actually killed. */
const killWalkers = (page: import('@playwright/test').Page, n: number): Promise<number> =>
  page.evaluate((want) => {
    const X = (window as unknown as X).__XANDRIA__;
    const M = X.blueprint.enemies;
    let done = 0;
    for (let attempt = 0; attempt < 12 && done < want; attempt++) {
      let roster = M.enemies.filter((e: any) => e.alive && e.spec.kind === 'walker');
      if (!roster.length) {
        M.spawnForMap(X.spec.meta.seed);
        roster = M.enemies.filter((e: any) => e.alive && e.spec.kind === 'walker');
      }
      for (const e of roster) {
        if (done >= want) break;
        e.damage(10000); // real death path: Enemy.die -> onDeath -> hooks onKill
        done++;
      }
    }
    return done;
  }, n);

/** One real player death: restore honest health, then take the fatal hit. */
const realPlayerDeath = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  const av = X.blueprint.avatar;
  av.iframes = 0;
  av.health = av.maxHealth; // drop the god-mode
  av.damage(1e9); // real death path: PlayerAvatar.die -> onPlayerDeath
});

// MERGE (save-slots): the journal lives in the active slot's profile now —
// the legacy xandria.profile.v1 key is migration-only input and is never
// updated by saves, so it reads empty here.
const readJournal = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      return active?.profile?.journal ?? [];
    } catch { return []; }
  });

const recapText = (page: import('@playwright/test').Page) =>
  page.locator('#xandria-run-recap').textContent();

test('run journal: two runs recorded exactly, recap, panel, reload — desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await gotoTitle(page);

  // ---- title: journal button opens the empty journal; Esc closes ----
  const journalBtn = page.locator('#xandria-journal-open');
  await expect(journalBtn).toBeVisible();
  await journalBtn.click();
  const panel = page.locator('#xandria-journal-panel');
  await expect(panel).toBeVisible();
  expect((await panel.textContent()) ?? '').toContain('No runs yet');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // ---- run 1: 3 kills + 1 death, lost ----
  // force: .start-btn has an infinite pulse animation, so Playwright's
  // stability check never passes; the click still fires the real go()->onStart path.
  await page.locator('.start-btn').click({ force: true });
  await stateIs(page, 'playing');
  await godMode(page);
  expect(await killWalkers(page, 3)).toBe(3);
  await dismissLevelUps(page);
  await stateIs(page, 'playing');
  await realPlayerDeath(page);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.lose('e2e test loss');
  });
  await stateIs(page, 'lost');
  await page.locator('#xandria-run-recap').waitFor({ state: 'visible', timeout: 15000 });
  const recap1 = (await recapText(page)) ?? '';
  expect(recap1).toContain('DEATHS 1');
  expect(recap1).toContain('PORTALS 0');
  expect(recap1).toContain('BOSSES 0');
  expect(recap1).toContain('SEED');
  const seed = await page.evaluate(() => (window as unknown as X).__XANDRIA__.spec.meta.seed);
  expect(recap1).toContain(`SEED ${seed}`);
  const statsLine1 = (await page.locator('.overlay .stats').first().textContent()) ?? '';
  expect(statsLine1).toContain('KILLS 3');

  // journal entry 1 in localStorage — exact observed stats
  let journal = await readJournal(page);
  expect(journal).toHaveLength(1);
  const e1 = journal[0];
  expect(e1).toMatchObject({
    kills: 3, deaths: 1, portals: 0, bossesKilled: 0,
    result: 'lost', genre: 'fps-arena', seed,
  });
  expect(typeof e1.startUtc).toBe('string');
  expect(e1.xpGained).toBeGreaterThanOrEqual(0);
  expect(e1.duration).toBeGreaterThanOrEqual(0);
  expect(recap1).toContain(`XP +${e1.xpGained}`);

  // ---- run 2: 1 kill, 0 deaths, won ----
  await page.getByRole('button', { name: 'RESTART' }).click();
  await stateIs(page, 'playing');
  await godMode(page);
  expect(await killWalkers(page, 1)).toBe(1);
  await dismissLevelUps(page);
  await stateIs(page, 'playing');
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.win({});
  });
  await stateIs(page, 'won');
  await page.locator('#xandria-run-recap').waitFor({ state: 'visible', timeout: 15000 });
  const recap2 = (await recapText(page)) ?? '';
  expect(recap2).toContain('DEATHS 0');
  const statsLine2 = (await page.locator('.overlay .stats').first().textContent()) ?? '';
  expect(statsLine2).toContain('KILLS 1');

  journal = await readJournal(page);
  expect(journal).toHaveLength(2);
  const [n2, n1] = journal; // newest first
  expect(n2).toMatchObject({ kills: 1, deaths: 0, portals: 0, bossesKilled: 0, result: 'won', genre: 'fps-arena', seed });
  expect(n1).toMatchObject({ kills: 3, deaths: 1, portals: 0, bossesKilled: 0, result: 'lost', genre: 'fps-arena', seed });

  // ---- title: journal panel lists both runs, newest first, exact data ----
  await page.getByRole('button', { name: 'TITLE' }).click();
  await stateIs(page, 'title');
  await page.locator('#xandria-journal-open').click();
  const rows = page.locator('.jr-row');
  await expect(rows).toHaveCount(2);
  const rowData = (i: number) => rows.nth(i).evaluate((r: HTMLElement) => ({ ...r.dataset }));
  const d2 = await rowData(0);
  expect(d2).toMatchObject({
    kills: '1', deaths: '0', portals: '0', bosses: '0',
    result: 'won', genre: 'fps-arena', seed: String(seed),
    xp: String(n2.xpGained), startUtc: n2.startUtc, duration: String(n2.duration),
  });
  const d1 = await rowData(1);
  expect(d1).toMatchObject({
    kills: '3', deaths: '1', portals: '0', bosses: '0',
    result: 'lost', genre: 'fps-arena', seed: String(seed),
    xp: String(n1.xpGained), startUtc: n1.startUtc, duration: String(n1.duration),
  });
  const rowText = (await rows.first().textContent()) ?? '';
  expect(rowText).toContain('K 1');
  expect(rowText).toContain('D 0');

  // ---- reload preserves the journal ----
  await page.goto(URL, { waitUntil: 'load' });
  await waitFor(page, 'title state after reload', async () =>
    page.evaluate(() => (window as unknown as X).__XANDRIA__?.engine?.state === 'title'), 120_000);
  await page.locator('#xandria-journal-open').click();
  await expect(page.locator('.jr-row')).toHaveCount(2);
  const d2r = await page.locator('.jr-row').first().evaluate((r: HTMLElement) => ({ ...r.dataset }));
  expect(d2r).toMatchObject({ kills: '1', result: 'won', startUtc: n2.startUtc });

  expect(errors).toHaveLength(0);
});

test('run journal: condensed flow at 360x780', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await gotoTitle(page);

  await page.locator('#xandria-journal-open').click();
  await expect(page.locator('#xandria-journal-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#xandria-journal-panel')).toBeHidden();

  // force: infinite pulse animation defeats the stability check (see desktop test)
  await page.locator('.start-btn').click({ force: true });
  await stateIs(page, 'playing');
  await godMode(page);
  expect(await killWalkers(page, 1)).toBe(1);
  await dismissLevelUps(page);
  await stateIs(page, 'playing');
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.win({});
  });
  await stateIs(page, 'won');
  await page.locator('#xandria-run-recap').waitFor({ state: 'visible', timeout: 15000 });
  const recap = (await recapText(page)) ?? '';
  expect(recap).toContain('DEATHS 0');
  expect(recap).toContain('BOSSES 0');

  const journal = await readJournal(page);
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({ kills: 1, deaths: 0, result: 'won', genre: 'fps-arena' });

  await page.getByRole('button', { name: 'TITLE' }).click();
  await stateIs(page, 'title');
  await page.locator('#xandria-journal-open').click();
  await expect(page.locator('.jr-row')).toHaveCount(1);
  const d = await page.locator('.jr-row').first().evaluate((r: HTMLElement) => ({ ...r.dataset }));
  expect(d).toMatchObject({ kills: '1', deaths: '0', result: 'won' });

  expect(errors).toHaveLength(0);
});
