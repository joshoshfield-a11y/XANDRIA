/**
 * Daily challenge mutators e2e — the daily run's mutator set is pinned per
 * date, shown on the board, and prices the recorded score.
 *
 * Desktop + 360x780, zero console/page errors throughout:
 *  1. Title screen: the daily challenge line and every board row carry the
 *     ⚡ mutator names, deep-equal to this spec's INDEPENDENT replication
 *     of the selection (own mulberry32 + shuffle copy, salt included).
 *  2. Clicking daily starts a run whose live mutator set
 *     (engine.getDailyMutators()) is deep-equal to the replication.
 *  3. Completing the run via engine.win() with engine.score pinned to 1000
 *     records a daily score of round(1000 * replicated score multiplier)
 *     into localStorage — the table product, asserted exactly.
 *  4. Mobile leg: board + daily start render cleanly at 360x780.
 *
 * Runs WITHOUT ?test=1 so profile persistence actually writes (same
 * convention as daily-challenge.spec.ts); splash=0 removes the unskippable
 * overlay so the daily button is clickable.
 */
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// INDEPENDENT replication of the mutator selection + scoring.
// Own copy of the algorithm (mulberry32 + salt + shuffle + table); any
// change to the game's pinned formula or table must update this replica
// or the spec fails loud.
// ---------------------------------------------------------------------------
const DAILY_SALT = 0xd41e5ca1;
const MUTATOR_SALT = 0x6d757461;
const MUTATOR_TABLE = [
  { id: 'glass-cannon', name: 'Glass Cannon', scoreMult: 1.25 },
  { id: 'swarm', name: 'Swarm', scoreMult: 1.3 },
  { id: 'miser', name: 'Miser', scoreMult: 1.5 },
  { id: 'iron-skin', name: 'Iron Skin', scoreMult: 1.25 },
];
const MUTATOR_IDS = MUTATOR_TABLE.map((m) => m.id);

function makeRng(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next };
}

function todayUtcDate(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function replicateMutators(dateStr: string) {
  const yyyymmdd = parseInt(dateStr.replace(/-/g, ''), 10);
  const seed = (DAILY_SALT ^ yyyymmdd ^ MUTATOR_SALT) >>> 0;
  const rng = makeRng(seed);
  const pool = [...MUTATOR_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const ids = pool.slice(0, 2);
  const names = ids.map((id) => MUTATOR_TABLE.find((m) => m.id === id)!.name);
  const scoreMult = ids.reduce(
    (acc, id) => acc * MUTATOR_TABLE.find((m) => m.id === id)!.scoreMult, 1);
  return { ids, names, scoreMult, label: names.join(' + ') };
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
  // SAVE-SLOTS: profiles live in the active slot of xandria.slots.v1 now;
  // the legacy xandria.profile.v1 key is only a fallback for old stores.
  return page.evaluate(() => {
    const slotsRaw = localStorage.getItem('xandria.slots.v1');
    if (slotsRaw) {
      try {
        const st = JSON.parse(slotsRaw);
        const active = st.slots?.find((s: any) => s.id === st.activeSlotId) ?? st.slots?.[0];
        if (active?.profile) return active.profile;
      } catch { /* fall through to the legacy key */ }
    }
    return JSON.parse(localStorage.getItem('xandria.profile.v1') ?? '{}');
  });
}

test('daily mutators: board display, seeded start, multiplied score', async ({ page }) => {
  const errors = await gotoTitle(page);
  const today = todayUtcDate();
  const expected = replicateMutators(today);

  // --- leg 1: title screen shows the day's mutators on the line + board ---
  const challengeLine = (await page.locator('.daily-challenge-line').textContent()) ?? '';
  expect(challengeLine).toContain('⚡');
  expect(challengeLine).toContain(expected.label);
  const rows = await boardRows(page);
  expect(rows).toHaveLength(8);
  expect(rows[0].today).toBe(true);
  expect(rows[0].goal).toContain('⚡');
  expect(rows[0].goal).toContain(expected.label);
  // every past row shows ITS OWN date's replicated mutators
  const todayDate = new Date(`${today}T00:00:00Z`);
  for (let n = 0; n < 8; n++) {
    const d = new Date(todayDate.getTime() - n * 86400_000);
    const ds = todayUtcDate(d);
    const rep = replicateMutators(ds);
    expect(rows[n].goal).toContain(rep.label);
  }

  // --- leg 2: daily start carries the replicated mutator set ---
  await page.locator('.daily-btn').click();
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 15000 });
  const liveMutators = await page.evaluate(() => (window as any).__XANDRIA__.engine.getDailyMutators());
  expect(liveMutators).toEqual(expected.ids);
  const liveEffect = await page.evaluate(() => (window as any).__XANDRIA__.engine.getDailyMutatorEffect());
  expect(liveEffect.scoreMult).toBeCloseTo(expected.scoreMult, 10);
  expect(errors).toHaveLength(0);

  // --- leg 3: completing with a pinned score records the multiplied score ---
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.score = 1000;
    X.engine.win({ kills: 5 }, 'e2e mutator test win');
  });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'won', null, { timeout: 15000 });
  const profile = await readProfile(page);
  const result = profile.dailyResults?.[today];
  expect(result).toBeTruthy();
  expect(result.score).toBe(Math.round(1000 * expected.scoreMult));
  expect(errors).toHaveLength(0);

  // --- leg 4: reload — the board shows the multiplied score ---
  await page.goto(`/player.html?intent=${encodeURIComponent(INTENT)}&splash=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, { timeout: 30000 });
  const rows2 = await boardRows(page);
  expect(rows2[0].result).toContain(result.score.toLocaleString('en-US'));
  expect(errors).toHaveLength(0);
});

test('daily mutators: title board + daily start at 360x780', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await gotoTitle(page);
  const rows = await boardRows(page);
  expect(rows).toHaveLength(8);
  expect(rows[0].goal).toContain('⚡');
  expect(rows[0].goal).toContain(replicateMutators(todayUtcDate()).label);
  await expect(page.locator('.daily-btn')).toBeVisible();
  await page.locator('.daily-btn').click();
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 15000 });
  const liveMutators = await page.evaluate(() => (window as any).__XANDRIA__.engine.getDailyMutators());
  expect(liveMutators).toEqual(replicateMutators(todayUtcDate()).ids);
  expect(errors).toHaveLength(0);
});
