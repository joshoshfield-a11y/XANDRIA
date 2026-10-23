/**
 * QA fix wave 2026-10-22 (phone-playability), F1 — studio play mode.
 *
 * Pre-fix: above the 720px drawer breakpoint there was NO way to dismiss
 * the studio panel — on the user's S25 in landscape the game iframe got
 * 375 of 915 CSS px (41%) and the fixed spec inspector covered the rest.
 * Play mode (body.playing) now hides all chrome at every width, gives the
 * frame the full viewport, hides the inspector, and offers one floating
 * "✕ Studio" exit chip. These tests measure real layout geometry.
 */
import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { name: 'S25 landscape 915x412', width: 915, height: 412 },
  { name: 'S25 portrait 412x915', width: 412, height: 915 },
  { name: 'small phone 360x780', width: 360, height: 780 },
];

for (const vp of VIEWPORTS) {
  test(`F1 play mode fills the viewport @ ${vp.name}`, async ({ page }) => {
    const shellErrors: string[] = [];
    let generated = false;
    page.on('pageerror', (e) => { if (!generated) shellErrors.push(String(e)); });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    await expect(page.locator('#generate')).toBeAttached();
    if (vp.width <= 720) {
      // phone layout: open the bottom drawer to reach the form
      await page.click('#drawer-fab');
      await expect(page.locator('#side')).toHaveClass(/open/);
    }
    await page.fill('#prompt', 'a heroic knight adventure');
    generated = true;
    await page.click('#generate');
    await page.waitForFunction(() => document.body.classList.contains('playing'), null, { timeout: 15_000 });

    const box = await page.locator('#game').boundingBox();
    expect(box, 'game frame has a box in play mode').not.toBeNull();
    expect(Math.abs(box!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.width - vp.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.height - vp.height)).toBeLessThanOrEqual(2);

    await expect(page.locator('#side')).toBeHidden();
    await expect(page.locator('#sidenav')).toBeHidden();
    const inspDisplay = await page.evaluate(
      () => getComputedStyle(document.querySelector('xandria-spec-inspector')!).display,
    );
    expect(inspDisplay).toBe('none');

    await expect(page.locator('#play-exit')).toBeVisible();
    await page.click('#play-exit');
    await page.waitForFunction(() => !document.body.classList.contains('playing'));
    await expect(page.locator('#sidenav')).toBeVisible();
    expect(shellErrors, 'studio shell loads without page errors').toEqual([]);
  });
}

test('F1 desktop editing layout is preserved outside play mode', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('#generate')).toBeVisible();
  // Pre-generate the iframe itself is display:none (the #empty overlay
  // shows instead), so the edit-mode geometry is measured on #frame-wrap —
  // the flex child the iframe fills 100% once visible.
  const before = await page.locator('#frame-wrap').boundingBox();
  expect(before).not.toBeNull();
  // 1280 − 88 sidenav − 452 side panel = 740 for the frame in edit mode
  expect(Math.abs(before!.width - 740)).toBeLessThanOrEqual(2);

  await page.fill('#prompt', 'a heroic knight adventure');
  await page.click('#generate');
  await page.waitForFunction(() => document.body.classList.contains('playing'), null, { timeout: 15_000 });
  const during = await page.locator('#game').boundingBox();
  expect(Math.abs(during!.width - 1280)).toBeLessThanOrEqual(2);
  expect(Math.abs(during!.height - 800)).toBeLessThanOrEqual(2);

  await page.click('#play-exit');
  await page.waitForFunction(() => !document.body.classList.contains('playing'));
  const after = await page.locator('#frame-wrap').boundingBox();
  expect(Math.abs(after!.width - 740)).toBeLessThanOrEqual(2);
});

test('F1 top-bar play button toggles play mode after a generation', async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await page.goto('/');
  await page.fill('#prompt', 'a heroic knight adventure');
  await page.click('#generate');
  await page.waitForFunction(() => document.body.classList.contains('playing'), null, { timeout: 15_000 });
  await page.click('#play-exit');
  await page.waitForFunction(() => !document.body.classList.contains('playing'));
  // the old decorative avatar "X" is now a real button wired to play mode
  await page.click('#play-toggle');
  await page.waitForFunction(() => document.body.classList.contains('playing'));
  const box = await page.locator('#game').boundingBox();
  expect(Math.abs(box!.width - 915)).toBeLessThanOrEqual(2);
});

test('F1 inspector: collapsed by default at phone width, toggle expands it', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/');
  await expect(page.locator('xandria-spec-inspector')).toBeAttached();
  const collapsed0 = await page.evaluate(
    () => (document.querySelector('xandria-spec-inspector') as unknown as { collapsed: boolean }).collapsed,
  );
  expect(collapsed0).toBe(true);
  await page.evaluate(() => {
    const el = document.querySelector('xandria-spec-inspector')!;
    el.shadowRoot!.querySelector<HTMLButtonElement>('.toggle')!.click();
  });
  const collapsed1 = await page.evaluate(
    () => (document.querySelector('xandria-spec-inspector') as unknown as { collapsed: boolean }).collapsed,
  );
  expect(collapsed1).toBe(false);
});

test('F1 inspector: expanded by default on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('xandria-spec-inspector')).toBeAttached();
  const collapsed = await page.evaluate(
    () => (document.querySelector('xandria-spec-inspector') as unknown as { collapsed: boolean }).collapsed,
  );
  expect(collapsed).toBe(false);
});
