/**
 * UPGRADE LOOP (save-export-import): JSON backup export/import, e2e.
 *
 * On the deterministic "Forgotten Valley" tp-action fixture (seed 20261012),
 * booted to the TITLE screen (the backup UI only exists on the slot picker):
 *  1. A seeded slot exports to a real browser download: JSON with the
 *     format marker, schema version, and every profile section + settings.
 *  2. On a FRESH profile the same file imports as a NEW slot (name
 *     collision auto-suffixed), becomes active, and its stored profile +
 *     settings are exactly identical to the exported ones; progress
 *     survives a reload.
 *  3. Malformed / truncated / wrong-version / out-of-range files are
 *     rejected with a clear status message, the engine stays on the title
 *     screen, and the stored slots are byte-identical afterwards.
 *  4. Perf (INSTANCING.md method): median draw calls on the title screen
 *     are identical before/after export+import (DOM-only UI, zero WebGL).
 *  5. Mobile leg (360x780): picker fits the viewport, backup buttons are
 *     >= 28px touch targets, and import works at 360px.
 *
 * Desktop AND 360x780, zero console/page errors.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const B64 = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

const SLOTS_KEY = 'xandria.slots.v1';

function attachErrorCapture(page: any, errors: string[]): void {
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
}

async function gotoTitle(page: any): Promise<void> {
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
    // The visually-hidden file input (1x1 by design) is excluded: it is
    // never a touch target — the IMPORT button opens it.
    for (const el of document.querySelectorAll('.slot-pick, .slot-btn, .slot-new, .slot-backup-btn')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 28 || r.height < 28) {
        out.push(`${(el as HTMLElement).className}: ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  return bad;
}

async function storedSlots(page: any): Promise<any> {
  return page.evaluate((key: string) => JSON.parse(localStorage.getItem(key)!), SLOTS_KEY);
}

async function storedRaw(page: any): Promise<string> {
  return page.evaluate((key: string) => localStorage.getItem(key)!, SLOTS_KEY);
}

test('save-export-import: export download, import as new slot, malformed rejection — desktop + 360x780', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  attachErrorCapture(page, errors);
  await gotoTitle(page);
  expect(await touchTargetsOk(page)).toEqual([]);
  expect(await engineState(page)).toBe('title');

  // ---- seed one rich slot, then reload so the picker shows it ----
  await page.evaluate((key: string) => {
    const store = {
      version: 1, activeSlotId: 'slot-1', nextSeq: 2,
      slots: [{
        id: 'slot-1', name: 'Slot 1',
        profile: {
          version: 1, merit: 77, owned: ['vitality'], loadout: ['vitality'],
          runsPlayed: { 'third-person-action': 3 }, runsWon: { 'third-person-action': 1 },
          bestScore: { 'third-person-action': 1234 }, bestLevel: { 'third-person-action': 5 },
          totalKills: 42, totalPlaytime: 3600, dailyBest: {}, gauntletResults: {},
          gauntletBest: 0, achievements: ['first-blood'], difficulty: 'hard',
          ngPlusCycle: 2, bestiaryKills: { ember: 9 }, dailyResults: {}, journal: [],
          tutorialSeen: true,
          accessibility: { keybinds: {}, colorblind: 'none', reducedMotion: false, hudTextScale: 1 },
          companions: null,
          cosmetics: { visor: null, outfit: null, scarf: false, hood: false, trim: null },
          campChest: { iron: 4 }, campBuilt: {}, mounts: { active: null, stamina: {} },
        },
        settings: {
          volume: 0.5, muted: true, quality: 'retro', tier: 's25', floatingText: false,
          musicEnabled: true, sfxEnabled: true, musicVolume: 0.8, sfxVolume: 0.8,
        },
        ironman: false, dead: false, createdAt: 1, updatedAt: 1,
      }],
    };
    localStorage.setItem(key, JSON.stringify(store));
  }, SLOTS_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitTitle(page);
  expect(await page.locator('.slot-row').count()).toBe(1);
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('77');
  expect(await touchTargetsOk(page)).toEqual([]);

  const callsBefore = await medianDrawCalls(page);

  // ---- 1. export: real browser download, full backup JSON ----
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.locator('.slot-export').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^xandria-slot-backup-v1-slot-1\.json$/);
  const tmp = mkdtempSync(join(tmpdir(), 'xandria-backup-'));
  const backupPath = join(tmp, 'backup.json');
  const downloadedPath = await download.path();
  writeFileSync(backupPath, readFileSync(downloadedPath!));
  const exported = JSON.parse(readFileSync(backupPath, 'utf8'));
  expect(exported.format).toBe('xandria-save-slot');
  expect(exported.schemaVersion).toBe(1);
  expect(exported.slot.name).toBe('Slot 1');
  expect(exported.slot.profile.merit).toBe(77);
  expect(exported.slot.profile.achievements).toEqual(['first-blood']);
  expect(exported.slot.profile.bestiaryKills).toEqual({ ember: 9 });
  expect(exported.slot.profile.difficulty).toBe('hard');
  expect(exported.slot.profile.ngPlusCycle).toBe(2);
  expect(exported.slot.profile.campChest).toEqual({ iron: 4 });
  expect(exported.slot.settings).toMatchObject({ volume: 0.5, muted: true, tier: 's25' });
  await expect(page.locator('.slot-backup-status')).toContainText('Exported xandria-slot-backup-v1-slot-1.json');
  expect(await engineState(page)).toBe('title');

  // ---- 2. fresh profile: import lands as a NEW slot, progress identical ----
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitTitle(page);
  expect(await page.locator('.slot-row').count()).toBe(3);
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('0');
  await page.locator('.slot-backup-file').setInputFiles(backupPath);
  await expect(page.locator('.slot-backup-status')).toContainText('Imported as');
  expect(await page.locator('.slot-row').count()).toBe(4);
  // name collision with the fresh "Slot 1" auto-suffixed; imported slot active
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 1 (2)');
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('77');
  const afterImport = await storedSlots(page);
  const imported = afterImport.slots.find((s: any) => s.name === 'Slot 1 (2)');
  expect(imported).toBeTruthy();
  expect(imported.profile).toEqual(exported.slot.profile);
  expect(imported.settings).toEqual(exported.slot.settings);
  expect(imported.ironman).toBe(false);
  expect(await engineState(page)).toBe('title');
  // progress survives a reload on the imported slot
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitTitle(page);
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 1 (2)');
  expect(await page.locator('.title-screen .merit-line').textContent()).toContain('77');
  expect(await engineState(page)).toBe('title');

  // ---- 3. malformed files rejected cleanly, slots byte-identical ----
  const badFiles: Array<[string, string]> = [
    ['truncated', JSON.stringify(exported).slice(0, 60)],
    ['wrong-version', JSON.stringify({ ...exported, schemaVersion: 2 })],
    ['wrong-format', JSON.stringify({ ...exported, format: 'other' })],
    ['negative-merit', JSON.stringify({ ...exported, slot: { ...exported.slot, profile: { ...exported.slot.profile, merit: -5 } } })],
    ['missing-settings', JSON.stringify({ ...exported, slot: { name: exported.slot.name, profile: exported.slot.profile } })],
    ['not-json', 'this is not json at all {{{'],
  ];
  for (const [label, content] of badFiles) {
    const badPath = join(tmp, `bad-${label}.json`);
    writeFileSync(badPath, content);
    const beforeRaw = await storedRaw(page);
    const beforeCount = await page.locator('.slot-row').count();
    await page.locator('.slot-backup-file').setInputFiles(badPath);
    await expect(page.locator('.slot-backup-status')).toContainText('Import failed', { timeout: 15_000 });
    const status = await page.locator('.slot-backup-status').textContent();
    expect(status).toContain('Import failed');
    expect(await page.locator('.slot-row').count()).toBe(beforeCount);
    expect(await storedRaw(page)).toBe(beforeRaw);
    expect(await engineState(page)).toBe('title');
  }

  // ---- 4. perf: DOM-only UI, draw calls must not move ----
  const callsAfter = await medianDrawCalls(page);
  expect(callsAfter).toBe(callsBefore);

  // ---- 5. mobile leg: 360x780 ----
  await page.setViewportSize({ width: 360, height: 780 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitTitle(page);
  const pickerBox = await page.locator('.title-screen .slots').boundingBox();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(360);
  expect(await touchTargetsOk(page)).toEqual([]);
  // import works at 360px too (next suffix: Slot 1 (3))
  await page.locator('.slot-backup-file').setInputFiles(backupPath);
  await expect(page.locator('.slot-backup-status')).toContainText('Imported as');
  expect(await page.locator('.slot-row').count()).toBe(5);
  expect(await page.locator('.slot-row.active .slot-name').textContent()).toBe('Slot 1 (3)');
  expect(await engineState(page)).toBe('title');

  expect(errors).toEqual([]);
});
