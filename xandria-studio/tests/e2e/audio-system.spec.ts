/**
 * UPGRADE LOOP (audio-system): e2e verification (not eyeballing).
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action) — same world as the
 * hud-polish spec, so the pause -> SETTINGS flow is available.
 *
 * Desktop (1280x720) + mobile (360x780, touch) legs:
 *   1. BUS MUTES: unlock audio, then music/sfx toggles silence ONLY their
 *      own bus (the other bus keeps its gain, master untouched).
 *   2. SETTINGS UI: pause -> SETTINGS shows Music / Sound FX toggles and
 *      Music / SFX volume sliders; all four controls are >= 28px targets;
 *      toggling Music off in the UI zeroes the music bus gain.
 *   3. SEEDED BIOME LOOP: the audio test seam's pattern for ('forest',
 *      4242) deep-equals the engine's applied pattern, and re-applying
 *      the same seed reproduces it (independent replication: the seam
 *      exposes the pure fn, the engine holds the applied copy).
 *   4. PERSISTENCE: music off + music volume 0.25 survive a full page
 *      reload (per-slot settings in localStorage), reflected both in
 *      engine.settings.data and in the reopened settings UI.
 *
 * Zero console/page errors on both viewports.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NPCS_RAW = readFileSync(resolve(HERE, 'fixtures/npcs.b64'), 'utf8').trim();

// Two full world boots per test (initial + reload leg) exceed the 90s
// config timeout on this box (desktop boot alone runs ~40-70s); the
// reload leg is the point of the persistence check, so raise it here
// rather than splitting the spec and losing the shared-boot legs.
test.setTimeout(300_000);

const withItems = (raw: string): string => {
  const spec = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  spec.custom = spec.custom ?? {};
  spec.custom.items = { defs: {} };
  return Buffer.from(JSON.stringify(spec)).toString('base64');
};
const B64 = withItems(NPCS_RAW);

type X = { __XANDRIA__?: any };

async function boot(page: any, errors: string[]): Promise<void> {
  page.on('pageerror', (e: Error) => errors.push('[pageerror] ' + e.message));
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
    return !!(X?.engine && X?.questTest && X?.gatheringTest && X?.craftingTest
      && X?.audioTest && X?.blueprint?.quests && X?.blueprint?.npcs && X?.blueprint?.itemKit
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
}

async function waitForState(page: any, want: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const state = await page.evaluate(() => (window as any).__XANDRIA__?.engine?.state);
    if (state === want) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForState: want ${want}, got ${state}`);
    await page.waitForTimeout(250);
  }
}

/** Click a pause-overlay button, falling back to an atomic in-page click. */
async function overlayClick(page: any, name: string): Promise<void> {
  const loc = page.getByRole('button', { name, exact: true });
  await loc.click({ timeout: 10_000 }).catch(async () => {
    // The pause overlay can re-render under Playwright's stability wait
    // (seen once as a detach-retry loop); a synchronous query+click in one
    // evaluate still fires the real handler.
    await page.evaluate((label: string) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent === label);
      b?.click();
    }, name);
  });
}

async function openSettings(page: any): Promise<void> {
  // Accessibility-spec pattern: retry Escape until paused, then SETTINGS.
  const t0 = Date.now();
  for (;;) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => (window as any).__XANDRIA__?.engine?.state);
    if (state === 'paused') break;
    if (Date.now() - t0 > 30_000) throw new Error(`openSettings: never paused (state ${state})`);
  }
  await overlayClick(page, 'SETTINGS');
  await expect(page.getByLabel('Music', { exact: true })).toBeVisible();
}

async function resume(page: any): Promise<void> {
  await page.getByRole('button', { name: 'BACK', exact: true }).click().catch(() => {});
  await overlayClick(page, 'RESUME');
  await waitForState(page, 'playing');
}

async function busGains(page: any): Promise<{ music: number; sfx: number; master: number }> {
  return page.evaluate(() => {
    const a = (window as any).__XANDRIA__.engine.audio;
    return {
      music: a.musicBus.gain.value,
      sfx: a.sfxBus.gain.value,
      master: a.master.gain.value,
    };
  });
}

async function audioLegs(page: any, errors: string[]): Promise<void> {
  // One state-gated gesture for audio unlock: pause, unlock, resume.
  // (A blind double-Escape preamble flaked once on desktop: the second
  // edge can land while the engine is still settling the pause.)
  await page.keyboard.press('Escape');
  await waitForState(page, 'paused');
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.audio.unlock();
    // Start from known bus settings regardless of earlier legs.
    X.engine.settings.set({ musicEnabled: true, sfxEnabled: true, musicVolume: 0.8, sfxVolume: 0.8, muted: false });
    X.engine.applySettings();
  });
  await page.keyboard.press('Escape');
  await waitForState(page, 'playing');
  const base = await busGains(page);
  expect(base.music).toBeGreaterThan(0);
  expect(base.sfx).toBeGreaterThan(0);
  expect(base.master).toBeGreaterThan(0);

  // Leg 1: per-bus mutes silence only their own bus.
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.settings.set({ musicEnabled: false });
    X.engine.applySettings();
  });
  let g = await busGains(page);
  expect(g.music).toBe(0);
  expect(g.sfx).toBeCloseTo(base.sfx, 6);
  expect(g.master).toBeCloseTo(base.master, 6);
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.settings.set({ musicEnabled: true, sfxEnabled: false });
    X.engine.applySettings();
  });
  g = await busGains(page);
  expect(g.sfx).toBe(0);
  expect(g.music).toBeCloseTo(base.music, 6);
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.settings.set({ sfxEnabled: true });
    X.engine.applySettings();
  });

  // Leg 2: settings UI rows + touch targets + UI toggle drives the bus.
  await openSettings(page);
  for (const label of ['Music', 'Sound effects', 'Music volume', 'SFX volume']) {
    const loc = label === 'Music' ? page.getByLabel(label, { exact: true }) : page.getByLabel(label);
    await expect(loc).toBeVisible();
    const box = await loc.boundingBox();
    expect(box, `${label} box`).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(28);
    expect(box!.height).toBeGreaterThanOrEqual(28);
  }
  await page.getByLabel('Music', { exact: true }).uncheck();
  g = await busGains(page);
  expect(g.music).toBe(0);
  await page.getByLabel('Music', { exact: true }).check();
  g = await busGains(page);
  expect(g.music).toBeCloseTo(base.music, 6);
  // Slider leg: UI volume change lands in settings data + bus gain.
  await page.getByLabel('Music volume').fill('25');
  const mv = await page.evaluate(() => (window as any).__XANDRIA__.engine.settings.data.musicVolume);
  expect(mv).toBeCloseTo(0.25, 2);
  g = await busGains(page);
  expect(g.music).toBeCloseTo(base.music * (0.25 / 0.8), 4);
  await resume(page);

  // Leg 3: seeded biome loop — seam pattern vs engine-applied pattern.
  const biome = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const pattern = X.audioTest.biomeMusicPattern('forest', 4242);
    X.audioTest.setBiome('forest', 4242);
    const applied = X.audioTest.currentBiomePattern();
    X.audioTest.setBiome('forest', 4242);
    const reapplied = X.audioTest.currentBiomePattern();
    const other = X.audioTest.biomeMusicPattern('forest', 4243);
    return { pattern, applied, reapplied, other };
  });
  expect(biome.applied).toEqual(biome.pattern);
  expect(biome.reapplied).toEqual(biome.pattern);
  expect(biome.other).not.toEqual(biome.pattern);

  // Leg 4: persistence across a full reload.
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    X.engine.settings.set({ musicEnabled: false, musicVolume: 0.25 });
    X.engine.applySettings();
  });
  await page.reload();
  await boot(page, errors);
  const persisted = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return {
      musicEnabled: X.engine.settings.data.musicEnabled,
      musicVolume: X.engine.settings.data.musicVolume,
    };
  });
  expect(persisted.musicEnabled).toBe(false);
  expect(persisted.musicVolume).toBeCloseTo(0.25, 2);
  await openSettings(page);
  await expect(page.getByLabel('Music', { exact: true })).not.toBeChecked();
  await resume(page);

  expect(errors).toEqual([]);
}

test.describe('audio-system desktop', () => {
  test('buses, settings UI, seeded biome loop, persistence (1280x720)', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors);
    await audioLegs(page, errors);
  });
});

test.describe('audio-system mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });
  test('buses, settings UI, seeded biome loop, persistence (360x780, touch)', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors);
    await audioLegs(page, errors);
  });
});
