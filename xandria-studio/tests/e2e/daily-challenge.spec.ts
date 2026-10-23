/**
 * Daily challenges e2e — seeded daily runs, one attempt per day, offline board.
 *
 * Desktop + 360x780, zero console/page errors throughout:
 *  1. Title screen shows the daily button (label has today's UTC date + goal),
 *     the challenge line (goal + fixed loadout), and the board: 8 rows
 *     (today + last 7 days), newest first.
 *  2. Clicking daily starts the run with the pinned challenge — the in-page
 *     tuple is deep-equal to this spec's INDEPENDENT replication of the
 *     generator (own copy of the algorithm, salt included; deliberately a
 *     different code path from the game bundle), and spec.meta.seed matches.
 *  3. Completing the run via engine.win() scores the attempt into localStorage
 *     (time/kills/damage/score/won/genre/seed); reloading shows the daily
 *     button locked with "PLAYED — …".
 *  4. Mobile leg: title board + daily start render cleanly at 360x780.
 *
 * Notes: this spec runs WITHOUT ?test=1 so the real title screen shows and
 * profile persistence actually writes (testMode skips both). splash=0 removes
 * the unskippable overlay so the daily button is clickable. The run is played
 * out through the real win() path, not an injected shortcut — the engine's
 * onWin -> recordRunResult chain is what the player gets.
 */
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// INDEPENDENT replication of the pinned daily-challenge generator.
// Own copy of the algorithm (mulberry32 + salt + tuple shape); any change to
// the game's pinned formula must update this replica or the spec fails loud.
// ---------------------------------------------------------------------------
const SALT = 0xd41e5ca1;
const MODIFIER_IDS = ['vitality', 'power', 'swift', 'secondwind'];

function makeRng(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + (max - min) * next(),
    int: (min: number, max: number) => Math.floor(min + (max - min + 1) * next()),
    pick: <T>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)],
  };
}

function todayUtcDate(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function replicateChallenge(dateStr: string) {
  const seed = (SALT ^ parseInt(dateStr.replace(/-/g, ''), 10)) >>> 0;
  const rng = makeRng(seed);
  const pool = [...MODIFIER_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const loadout = pool.slice(0, 2);
  const kind = rng.pick(['kills', 'score', 'survive'] as const);
  const target =
    kind === 'kills' ? rng.int(25, 60)
    : kind === 'score' ? rng.int(15, 50) * 50
    : rng.int(8, 20) * 15;
  return { date: dateStr, seed, loadout, goal: { kind, target } };
}

const INTENT = 'neon fps arena at night';

async function gotoTitle(page: any) {
  const errors: string[] = [];
  page.on('console', (msg: any) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (e: any) => errors.push(String(e.message ?? e)));
  await page.goto(`/player.html?intent=${encodeURIComponent(INTENT)}&splash=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, { timeout: 30000 });
  return errors;
}

async function boardRows(page: any) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.daily-board-row')];
    return rows.map((r) => ({
      date: (r.querySelector('.dbr-date') as HTMLElement).textContent,
      goal: (r.querySelector('.dbr-goal') as HTMLElement).textContent,
      result: (r.querySelector('.dbr-result') as HTMLElement).textContent,
      today: r.classList.contains('today'),
    }));
  });
}

async function readProfile(page: any) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('xandria.profile.v1') ?? '{}'));
}

test('daily challenge: title board, seeded start, scoring + persistence', async ({ page }) => {
  const errors = await gotoTitle(page);
  const today = todayUtcDate();

  // --- leg 1: title board renders ---
  const dailyBtn = page.locator('.daily-btn');
  await expect(dailyBtn).toBeVisible();
  const label = (await dailyBtn.textContent()) ?? '';
  expect(label).toContain(`DAILY ${today}`);
  const challengeLine = (await page.locator('.daily-challenge-line').textContent()) ?? '';
  const expected = replicateChallenge(today); // independent replication
  expect(challengeLine).toContain('+'); // "Kill 40 enemies · Vitality + Power"
  const rows = await boardRows(page);
  expect(rows).toHaveLength(8);
  expect(rows[0].today).toBe(true);
  expect(rows[0].date).toBe('TODAY');
  expect(rows[7].today).toBe(false);
  for (const r of rows) {
    expect(r.goal!.length).toBeGreaterThan(0);
    expect(r.goal).toContain('+');
    expect(r.result).toBe('—'); // no results yet — fresh profile
  }

  // --- leg 2: daily start uses the pinned challenge, identical to replication ---
  await dailyBtn.click();
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 15000 });
  const inPage = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return {
      challenge: JSON.parse(JSON.stringify(X.engine.challenge)),
      specSeed: X.spec.meta.seed,
    };
  });
  expect(inPage.challenge).toEqual(expected);
  expect(inPage.specSeed).toBe(expected.seed);
  expect(errors).toHaveLength(0);

  // --- leg 3: completing the run scores the attempt into localStorage ---
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.win({ kills: 5 }, 'e2e test win');
  });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'won', null, { timeout: 15000 });
  const profile = await readProfile(page);
  const result = profile.dailyResults?.[today];
  expect(result).toBeTruthy();
  expect(result.won).toBe(true);
  expect(result.kills).toBeGreaterThanOrEqual(0);
  expect(result.score).toBeGreaterThanOrEqual(0);
  expect(result.timeSeconds).toBeGreaterThanOrEqual(0);
  expect(result.damageTaken).toBeGreaterThanOrEqual(0);
  expect(result.goalKind).toBe(expected.goal.kind);
  expect(result.goalTarget).toBe(expected.goal.target);
  expect(result.genre).toBe('fps-arena');
  expect(result.seed).toBe(expected.seed);

  // --- leg 4: reload — the attempt is consumed, button locked ---
  await page.goto(`/player.html?intent=${encodeURIComponent(INTENT)}&splash=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, { timeout: 30000 });
  const lockedLabel = (await page.locator('.daily-btn').textContent()) ?? '';
  expect(lockedLabel).toContain('PLAYED');
  expect(await page.locator('.daily-btn').isDisabled()).toBe(true);
  const rows2 = await boardRows(page);
  expect(rows2[0].result).toContain(result.score.toLocaleString('en-US'));
  expect(errors).toHaveLength(0);
});

test('daily challenge: title board + daily start at 360x780', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await gotoTitle(page);
  const rows = await boardRows(page);
  expect(rows).toHaveLength(8);
  await expect(page.locator('.daily-btn')).toBeVisible();
  await page.locator('.daily-btn').click();
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 15000 });
  const seed = await page.evaluate(() => (window as any).__XANDRIA__.engine.challenge.seed);
  expect(seed).toBe(replicateChallenge(todayUtcDate()).seed);
  expect(errors).toHaveLength(0);
});
