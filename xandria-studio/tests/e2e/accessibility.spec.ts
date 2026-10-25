/**
 * Accessibility pass — e2e verification (not eyeballing).
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action) — same world as the
 * hud-polish spec, so the real pause/settings UI paths are available.
 *
 * Desktop test (1280x720, no touch):
 *   1. REMAP: pause -> SETTINGS -> rebind interact KeyE -> KeyT via the
 *      capture UI. New key drives interact (pressed() true on keydown),
 *      old key stops (pressed() false). Conflict path: rebinding onto a
 *      bound key shows a rejection note and keeps the old bind.
 *   2. PALETTE: COLORBLIND select -> protanopia changes the sampled HUD
 *      chip colors (score value + CSS variable on the HUD root).
 *   3. REDUCED MOTION: juice.shake() leaves trauma at 0 and particle
 *      bursts emit nothing while on; both work again when off.
 *   4. GAMEPLAY IDENTICAL: the same scripted damage event (avatar.
 *      damage(10) from 100 HP) yields identical HP with reduced motion
 *      on and off — the toggle gates cosmetics only.
 *   5. TEXT SCALE: HUD TEXT SIZE slider to 125% grows the sampled score
 *      font-size from 22px to 27.5px.
 *   6. RELOAD: full page reload restores all four settings from the
 *      profile (keybind, palette, reduced motion, text scale).
 *
 * Mobile test (360x780, hasTouch): remap + palette + reload legs only.
 * Zero console/page errors on both viewports.
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
      && X?.blueprint?.quests && X?.blueprint?.npcs && X?.blueprint?.itemKit
      && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
  }), 240_000);
  // God-mode: the harness must not be mauled mid-test.
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
}

// Node-side evaluate polling (the portal-traverse spec documents RAF
// polling as unreliable in this environment — never waitForFunction here).
async function waitState(page: any, want: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const state = await page.evaluate(() => (window as any).__XANDRIA__?.engine?.state);
    if (state === want) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitState timeout: want ${want}, got ${state}`);
    await page.waitForTimeout(250);
  }
}

async function openSettings(page: any): Promise<void> {
  // Retry the Escape press until paused: a single press can land between
  // frames or be swallowed while a modal settles.
  const t0 = Date.now();
  for (;;) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => (window as any).__XANDRIA__?.engine?.state);
    if (state === 'paused') break;
    if (Date.now() - t0 > 30_000) throw new Error(`openSettings: never paused (state ${state})`);
  }
  await page.getByRole('button', { name: 'SETTINGS' }).click();
  await expect(page.getByLabel('Colorblind palette')).toBeVisible();
}

async function backToPause(page: any): Promise<void> {
  // exact: the 'Rebind back' key button substring-matches 'BACK'.
  await page.getByRole('button', { name: 'BACK', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SETTINGS' })).toBeVisible();
}

async function resume(page: any): Promise<void> {
  await page.getByRole('button', { name: 'RESUME' }).click();
  await waitState(page, 'playing');
}

async function remapLeg(page: any): Promise<void> {
  await openSettings(page);
  const btn = page.getByRole('button', { name: 'Rebind interact' });
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText('E');
  await btn.click();
  await expect(btn).toHaveText('PRESS KEY…');
  await page.keyboard.press('t'); // e.code KeyT
  await expect(btn).toHaveText('T');
  const binds = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.input.getKeybinds());
  expect(binds.interact).toBe('KeyT');
  // Conflict path: rebinding jump onto the now-taken KeyT is rejected.
  const jumpBtn = page.getByRole('button', { name: 'Rebind jump' });
  await jumpBtn.click();
  await page.keyboard.press('t');
  await expect(jumpBtn).toHaveText('SPACE');
  const note = page.locator('.xhud .settings-note').last();
  await expect(note).toContainText('REJECTED');
  const binds2 = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.input.getKeybinds());
  expect(binds2.jump).toBe('Space');
  await backToPause(page);
  await resume(page);
  // Behavioral proof: new key drives interact, old key does not.
  await page.keyboard.down('t');
  const pressedNew = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.input.pressed('interact'));
  expect(pressedNew).toBe(true);
  await page.keyboard.up('t');
  await page.keyboard.down('e');
  const pressedOld = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.input.pressed('interact'));
  expect(pressedOld).toBe(false);
  await page.keyboard.up('e');
}

async function paletteLeg(page: any): Promise<void> {
  await openSettings(page);
  const valColorBefore = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.xhud .score .val') as HTMLElement).color);
  expect(valColorBefore).toBe('rgb(255, 210, 63)'); // #ffd23f
  await page.getByLabel('Colorblind palette').selectOption('protanopia');
  const valColorAfter = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.xhud .score .val') as HTMLElement).color);
  expect(valColorAfter).toBe('rgb(255, 224, 102)'); // #ffe066
  const rootVar = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.xhud') as HTMLElement).getPropertyValue('--a11y-accent').trim());
  expect(rootVar).toBe('#ffe066');
  await backToPause(page);
  await resume(page);
}

async function reducedMotionAndCombatLeg(page: any): Promise<void> {
  const probe = (reduced: boolean) => page.evaluate((r: boolean) => {
    const E = (window as unknown as X).__XANDRIA__!.engine;
    E.applyAccessibilitySettings({ reducedMotion: r });
    E.juice.shake(1);
    const trauma = E.juice.trauma;
    E.particles.burst(E.portalsPlayerAvatar.ctrl.position.clone(), { count: 40 });
    const alive = E.particles.aliveCount('additive');
    return { trauma, alive };
  }, reduced);
  const on = await probe(true);
  expect(on.trauma).toBe(0);
  expect(on.alive).toBe(0);
  const off = await probe(false);
  expect(off.trauma).toBeGreaterThan(0);
  expect(off.alive).toBeGreaterThan(0);
  // Same scripted damage, reduced on vs off -> identical HP outcome.
  const damageRun = (reduced: boolean) => page.evaluate((r: boolean) => {
    const E = (window as unknown as X).__XANDRIA__!.engine;
    E.applyAccessibilitySettings({ reducedMotion: r });
    const av = E.portalsPlayerAvatar;
    av.iframes = 0;
    av.health = 100;
    av.damage(10);
    return av.health;
  }, reduced);
  const hpOn = await damageRun(true);
  // damage() sets a 0.8s iframe window; the harness resets it per run.
  const hpOff = await damageRun(false);
  expect(hpOn).toBe(90);
  expect(hpOff).toBe(90);
  // Leave reduced motion ON for the reload leg.
  await page.evaluate(() => {
    (window as unknown as X).__XANDRIA__!.engine.applyAccessibilitySettings({ reducedMotion: true });
  });
}

async function textScaleLeg(page: any): Promise<void> {
  await openSettings(page);
  const sizeBefore = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.xhud .score .val') as HTMLElement).fontSize);
  expect(sizeBefore).toBe('22px');
  await page.evaluate(() => {
    const sel = document.querySelector('input[aria-label="HUD text size"]') as HTMLInputElement;
    sel.value = '125';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const sizeAfter = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.xhud .score .val') as HTMLElement).fontSize);
  expect(sizeAfter).toBe('27.5px');
  await backToPause(page);
  await resume(page);
}

async function reloadLeg(page: any, full: boolean): Promise<void> {
  await page.reload();
  await page.goto(`/player.html?spec=${encodeURIComponent(B64)}&test=1&autostart=1&splash=0`);
  await page.waitForFunction(() => {
    const X = (window as unknown as X).__XANDRIA__;
    return !!(X?.engine && X.engine.state === 'playing');
  }, null, { timeout: 240_000 });
  const settings = await page.evaluate(() =>
    (window as unknown as X).__XANDRIA__!.engine.getAccessibilitySettings());
  expect(settings.keybinds.interact).toBe('KeyT');
  expect(settings.colorblind).toBe('protanopia');
  const binds = await page.evaluate(() => (window as unknown as X).__XANDRIA__!.engine.input.getKeybinds());
  expect(binds.interact).toBe('KeyT');
  const rootVar = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.xhud') as HTMLElement).getPropertyValue('--a11y-accent').trim());
  expect(rootVar).toBe('#ffe066');
  if (!full) return;
  expect(settings.reducedMotion).toBe(true);
  expect(settings.hudTextScale).toBe(1.25);
  const size = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.xhud .score .val') as HTMLElement).fontSize);
  expect(size).toBe('27.5px');
  const reduced = await page.evaluate(() => {
    const E = (window as unknown as X).__XANDRIA__!.engine;
    E.juice.shake(1);
    return E.juice.trauma;
  });
  expect(reduced).toBe(0);
}

test('accessibility: remap, palette, reduced motion, text scale, reload — desktop', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors: string[] = [];
  await boot(page, errors);
  await remapLeg(page);
  await paletteLeg(page);
  await reducedMotionAndCombatLeg(page);
  await textScaleLeg(page);
  await reloadLeg(page, true);
  expect(errors).toEqual([]);
});

test.describe('accessibility — mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('accessibility: remap, palette, reload — 360x780', async ({ page }) => {
    test.setTimeout(600_000);
    const errors: string[] = [];
    await boot(page, errors);
    await remapLeg(page);
    await paletteLeg(page);
    await reloadLeg(page, false);
    expect(errors).toEqual([]);
  });
});
