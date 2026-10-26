/**
 * UPGRADE LOOP (hardcore-ironman): hardcore / ironman permadeath mode.
 *
 * Runs WITHOUT ?test=1 (like run-journal.spec.ts) so the real title
 * screen shows and slot persistence actually writes (testMode skips
 * both). Desktop test — the full arc on two slots:
 *   slot-1: title picker IRONMAN -> confirm step -> run starts with the
 *     IRONMAN chip and the slot flagged ironman -> one real player death
 *     (PlayerAvatar.damage -> die -> ironman branch -> engine.lose) ->
 *     end screen shows SLOT DEAD, NO RESTART button, NO NG+ offer ->
 *     stored slot dead=true, journal entry ironman=true/lost -> TITLE ->
 *     title shows the dead notice, start disabled, engine.startRun()
 *     refused (state stays title: no respawn path) -> switch to slot-2
 *     -> ironman run -> engine.score = 1000 -> engine.win() -> end
 *     screen SCORE 2000 (x2.0 at cycle 0), recap IRONMAN x2.0, RESTART +
 *     NG+ offered (a survived ironman run is a live slot) -> stored
 *     bestScore 2000, slot-2 alive, journal entry ironman=true/won.
 * Mobile test (360x780) — condensed death leg: picker -> confirm ->
 * death -> dead line, no RESTART, slot dead in storage.
 *
 * Hardening notes: the start button's infinite pulse animation never
 * passes Playwright's stability check (run-journal wave), so this spec
 * starts runs through the picker buttons (no pulse) and asserts the
 * dead start-block through engine.startRun() evaluated directly.
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

/** One real player death via the real damage path (no god-mode here). */
const realPlayerDeath = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const X = (window as unknown as X).__XANDRIA__;
  const av = X.blueprint.avatar;
  av.iframes = 0;
  av.health = av.maxHealth;
  av.damage(1e9); // real death path: PlayerAvatar.die -> ironman branch
});

const readSlots = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      return { activeId: st.activeSlotId as string, slots: (st.slots ?? []) as any[] };
    } catch { return { activeId: '', slots: [] as any[] }; }
  });

const readJournal = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      return active?.profile?.journal ?? [];
    } catch { return []; }
  });

const readBest = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    try {
      const st = JSON.parse(localStorage.getItem('xandria.slots.v1') ?? '{}');
      const active = (st.slots ?? []).find((s: any) => s.id === st.activeSlotId);
      return active?.profile?.bestScore ?? {};
    } catch { return {}; }
  });

/** Title picker -> confirm step -> ironman run started (chip visible). */
const startIronmanViaPicker = async (page: import('@playwright/test').Page) => {
  const btn = page.locator('#xandria-ironman-btn');
  await expect(btn).toBeVisible();
  await btn.click();
  const confirm = page.locator('#xandria-ironman-confirm');
  await expect(confirm).toBeVisible();
  await page.locator('.ironman-confirm-ok').click();
  await stateIs(page, 'playing');
  await expect(page.locator('.xhud .score .ironman')).toBeVisible();
  await expect(page.locator('.xhud .score .ironman')).toHaveText('IRONMAN');
};

test('hardcore ironman: death kills the slot, survival scores x2.0 — desktop', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await gotoTitle(page);

  // ---- slot-1: picker shows NORMAL; confirm step gates the ironman start ----
  await expect(page.locator('.mode-label')).toHaveText('MODE: NORMAL');
  await startIronmanViaPicker(page);
  expect(await page.evaluate(() => (window as unknown as X).__XANDRIA__?.engine?.isIronmanRun())).toBe(true);
  let slots = await readSlots(page);
  expect(slots.activeId).toBe('slot-1');
  expect(slots.slots[0].ironman).toBe(true);
  expect(slots.slots[0].dead).toBe(false);

  // ---- one real death -> end screen: dead line, NO restart, NO NG+ ----
  await realPlayerDeath(page);
  await stateIs(page, 'lost');
  await expect(page.locator('#xandria-ironman-dead')).toBeVisible();
  await expect(page.locator('#xandria-ironman-dead')).toHaveText('SLOT PERMANENTLY DEAD — NO RESPAWN');
  expect((await page.locator('#xandria-run-recap').textContent()) ?? '').toContain('DEATHS 1');
  expect((await page.locator('#xandria-run-recap').textContent()) ?? '').toContain('IRONMAN');
  expect(await page.locator('.overlay button', { hasText: 'RESTART' }).count()).toBe(0);
  expect(await page.locator('.overlay button', { hasText: 'NEW GAME+' }).count()).toBe(0);
  await expect(page.locator('.overlay button', { hasText: 'TITLE' })).toBeVisible();

  // ---- stored: slot dead, journal entry ironman/lost ----
  slots = await readSlots(page);
  expect(slots.slots[0].dead).toBe(true);
  const journal1 = await readJournal(page);
  expect(journal1[0].ironman).toBe(true);
  expect(journal1[0].result).toBe('lost');
  expect(journal1[0].deaths).toBe(1);

  // ---- title: dead notice, start disabled, startRun refused (no respawn) ----
  await page.locator('.overlay button', { hasText: 'TITLE' }).click();
  await stateIs(page, 'title');
  await expect(page.locator('#xandria-slot-dead-notice')).toBeVisible();
  await expect(page.locator('.start-btn')).toBeDisabled();
  await page.evaluate(() => (window as unknown as X).__XANDRIA__?.engine?.startRun());
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as X).__XANDRIA__?.engine?.state)).toBe('title');
  // the engine's own restart path refuses too
  await page.evaluate(() => (window as unknown as X).__XANDRIA__?.engine?.restart());
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as X).__XANDRIA__?.engine?.state)).toBe('title');

  // ---- switch to slot-2: notice gone, slot alive, ironman run survives ----
  await page.locator('.slot-row[data-slot-id="slot-2"] .slot-pick').click();
  await expect(page.locator('#xandria-slot-dead-notice')).toHaveCount(0);
  slots = await readSlots(page);
  expect(slots.activeId).toBe('slot-2');
  expect(slots.slots[1].dead).toBe(false);
  await startIronmanViaPicker(page);
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.score = 1000;
    X.engine.win();
  });
  await stateIs(page, 'won');
  const statsText = (await page.locator('.overlay .stats').first().textContent()) ?? '';
  expect(statsText).toContain('SCORE 2000');
  expect((await page.locator('#xandria-run-recap').textContent()) ?? '').toContain('IRONMAN ×2.0');
  // a survived ironman run is a live slot: RESTART + NG+ are offered
  expect(await page.locator('.overlay button', { hasText: 'RESTART' }).count()).toBe(1);
  expect(await page.locator('.overlay button', { hasText: 'NEW GAME+' }).count()).toBe(1);
  // stored: multiplied score landed, slot alive, journal ironman/won
  slots = await readSlots(page);
  expect(slots.slots[1].dead).toBe(false);
  expect(slots.slots[1].ironman).toBe(true);
  const best = await readBest(page);
  expect(best['fps-arena']).toBe(2000);
  const journal2 = await readJournal(page);
  expect(journal2[0].ironman).toBe(true);
  expect(journal2[0].result).toBe('won');

  expect(errors).toEqual([]);
});

test('hardcore ironman: condensed death leg at 360x780', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = await gotoTitle(page);

  await startIronmanViaPicker(page);
  await realPlayerDeath(page);
  await stateIs(page, 'lost');
  await expect(page.locator('#xandria-ironman-dead')).toBeVisible();
  expect(await page.locator('.overlay button', { hasText: 'RESTART' }).count()).toBe(0);
  const slots = await readSlots(page);
  expect(slots.slots[0].dead).toBe(true);

  expect(errors).toEqual([]);
});
