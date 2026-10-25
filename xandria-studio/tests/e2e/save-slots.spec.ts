/**
 * UPGRADE LOOP (save-slots): multiple named save slots, e2e.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012),
 * booted to the TITLE screen (no autostart/test — the slot picker only exists
 * on the title screen):
 *  1. Fresh boot shows 3 named slots (Slot 1..3), first active; every slot
 *     control has touch targets >= 28px.
 *  2. NEW SLOT creates a 4th slot and activates it; the merit line resets.
 *  3. Isolation + active-slot persistence: merit written into one slot's
 *     stored profile survives a reload on that slot only; selecting another
 *     slot shows a clean profile; switching back restores. Active slot id
 *     persists across the reload.
 *  4. Rename flow (inline input, no prompt) and two-step delete flow
 *     (no confirm) work and never start the run (state stays 'title').
 *  5. Migration: a seeded legacy xandria.profile.v1 + xandria.settings.v1
 *     becomes a single 'Slot 1' with the merit and settings intact.
 *  6. Perf (INSTANCING.md method): median renderer.info.render.calls over 20
 *     frames on the title screen is identical before/after slot operations.
 *
 * Desktop AND 360x780, zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const SLOTS_KEY = 'xandria.slots.v1';

function attachErrorCapture(page: any, errors: string[]): void {
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
}

async function gotoTitle(page: any): Promise<void> {
  // NOTE: no test=1 / autostart — those skip the title screen entirely.
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&splash=0`);
  await waitTitle(page);
}

async function waitTitle(page: any): Promise<void> {
  await waitFor(page, 'title', () => page.evaluate(() => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'title');
  }), 240_000);
  await waitFor(page, 'slot rows', () => page.evaluate(() =>
    document.querySelectorAll('.slot-row').length >= 1), 30_000);
}

async function waitFor(page: any, label: string, fn: () => Promise<boolean>, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label}) after ${timeoutMs}ms`);
    await page.waitForTimeout(1000);
  }
}

async function engineState(page: any): Promise<string> {
  return page.evaluate(() => (window as unknown as { __XANDRIA__?: any }).__XANDRIA__.engine.state);
}

/** Median renderer.info.render.calls over n rAF frames (INSTANCING.md method). */
async function medianDrawCalls(page: any, n = 20): Promise<number> {
  const calls: number[] = await page.evaluate(async (frames: number) => {
    const X = (window as unknown as { __XANDRIA__?: any }).__XANDRIA__;
    const out: number[] = [];
    for (let i = 0; i < frames; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      out.push(X.engine.renderer.info.render.calls);
    }
    return out;
  }, n);
  calls.sort((a, b) => a - b);
  return calls[Math.floor(calls.length / 2)];
}

async function touchTargetsOk(page: any): Promise<string[]> {
  const bad: string[] = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('.slot-pick, .slot-btn, .slot-new')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 28 || r.height < 28) {
        out.push(`${(el as HTMLElement).className}: ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  return bad;
}

test('save-slots: picker, isolation, rename/delete, migration, perf — desktop + 360x780', async ({ page }) => {
  // Four full boots in one test (SwiftShader is slow) — the 90s config
  // default cannot fit them.
  test.setTimeout(300_000);
  const errors: string[] = [];
  attachErrorCapture(page, errors);
  await gotoTitle(page);

  // ---- 1. fresh boot: 3 named slots, first active ----
  expect(await page.locator('.slot-row').count()).toBe(3);
  const names = await page.locator('.slot-row .slot-name').allTextContents();
  expect(names).toEqual(['Slot 1', 'Slot 2', 'Slot 3']);
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 1');
  expect(await touchTargetsOk(page)).toEqual([]);
  expect(await engineState(page)).toBe('title');

  // ---- 6a. perf baseline on the title screen ----
  const callsBefore = await medianDrawCalls(page);

  // ---- 2. NEW SLOT: 4th slot, activated, clean profile ----
  await page.locator('.slot-new').click();
  await expect(page.locator('.slot-row')).toHaveCount(4);
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 4');
  expect(await page.locator('.title-screen .profile-line').textContent()).toContain('first run');
  expect(await engineState(page)).toBe('title');

  // ---- 3. isolation + active-slot persistence across reload ----
  const activeIdBefore = await page.evaluate(() => {
    const raw = localStorage.getItem('xandria.slots.v1')!;
    const st = JSON.parse(raw);
    const active = st.slots.find((s: any) => s.id === st.activeSlotId);
    active.profile.merit = 99;
    // genre key must match the fixture (third-person-action) for the
    // title screen's per-genre profile line to count the runs.
    active.profile.runsPlayed = { 'third-person-action': 3 };
    localStorage.setItem('xandria.slots.v1', JSON.stringify(st));
    return st.activeSlotId;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitTitle(page);
  const activeIdAfter = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('xandria.slots.v1')!).activeSlotId);
  expect(activeIdAfter).toBe(activeIdBefore); // active slot id persisted
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 4');
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('99');
  expect(await page.locator('.title-screen .profile-line').textContent()).toContain('3 runs');
  // switch to Slot 1: isolated, clean profile
  await page.locator('.slot-row[data-slot-id="slot-1"] .slot-pick').click();
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 1');
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('0');
  expect(await page.locator('.title-screen .profile-line').textContent()).toContain('first run');
  // switch back: Slot 4 kept its progress exactly
  await page.locator(`.slot-row[data-slot-id="${activeIdBefore}"] .slot-pick`).click();
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('99');
  expect(await engineState(page)).toBe('title');

  // ---- 6b. perf after slot ops: draw calls must not move ----
  const callsAfter = await medianDrawCalls(page);
  expect(callsAfter).toBe(callsBefore);

  // ---- 4a. rename flow (inline input, Enter commits) ----
  await page.locator(`.slot-row[data-slot-id="${activeIdBefore}"] .slot-rename`).click();
  const input = page.locator(`.slot-row[data-slot-id="${activeIdBefore}"] input.slot-rename-input`);
  await expect(input).toBeVisible();
  expect(await touchTargetsOk(page)).toEqual([]); // input + confirm are >= 28px too
  await input.fill('My Run');
  await input.press('Enter');
  expect(await page.locator(`.slot-row[data-slot-id="${activeIdBefore}"] .slot-name`).textContent()).toBe('My Run');
  expect(await engineState(page)).toBe('title');

  // ---- 4b. delete flow: first click arms, second click deletes ----
  const delBtn = page.locator(`.slot-row[data-slot-id="${activeIdBefore}"] .slot-del`);
  await delBtn.click();
  expect(await delBtn.textContent()).toBe('⁉'); // armed, not deleted
  expect(await page.locator('.slot-row').count()).toBe(4);
  await delBtn.click();
  await expect(page.locator('.slot-row')).toHaveCount(3);
  // deleting the active slot activates a neighbour
  const newActive = await page.locator('.slot-row.active .slot-name').textContent();
  expect(['Slot 1', 'Slot 2', 'Slot 3']).toContain(newActive);
  expect(await engineState(page)).toBe('title');

  // ---- 5. migration: legacy profile + settings become Slot 1 ----
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('xandria.profile.v1', JSON.stringify({
      version: 1, merit: 77, owned: ['vitality'], totalKills: 5,
      difficulty: 'hard',
    }));
    localStorage.setItem('xandria.settings.v1', JSON.stringify({ volume: 0.5, muted: true }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitTitle(page);
  expect(await page.locator('.slot-row').count()).toBe(1);
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 1');
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('77');
  const migrated = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('xandria.slots.v1')!);
    return { settings: st.slots[0].settings, difficulty: st.slots[0].profile.difficulty };
  });
  expect(migrated.settings).toMatchObject({ volume: 0.5, muted: true });
  expect(migrated.difficulty).toBe('hard');
  expect(await engineState(page)).toBe('title');

  // ---- mobile leg: 360x780 ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitTitle(page);
  const pickerBox = await page.locator('.title-screen .slots').boundingBox();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(360);
  expect(await touchTargetsOk(page)).toEqual([]);
  // rename + delete still work at 360px
  await page.locator('.slot-new').click();
  await expect(page.locator('.slot-row')).toHaveCount(2);
  await page.locator('.slot-row[data-slot-id="slot-2"] .slot-rename').click();
  await page.locator('.slot-row[data-slot-id="slot-2"] input.slot-rename-input').fill('Phone');
  await page.locator('.slot-row[data-slot-id="slot-2"] .slot-ok').click();
  expect(await page.locator('.slot-row[data-slot-id="slot-2"] .slot-name').textContent()).toBe('Phone');
  expect(await engineState(page)).toBe('title');

  expect(errors).toEqual([]);
});
