/**
 * Wave 3A flow e2e: title screen, autostart bypass, pause-menu state machine,
 * in-place restart determinism, and settings persistence — all against the
 * real Engine in headless Chromium.
 */
import { test, expect } from '@playwright/test';

const INTENT = 'neon fps arena at night';
const URL = (q: string) => `/player.html?${q}&intent=${encodeURIComponent(INTENT)}`;
const stateOf = () => (window as any).__XANDRIA__?.engine?.state;

test('title screen shows premise/controls and starts the run on click', async ({ page }) => {
  await page.goto(URL(''), { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'title', null, { timeout: 30000 });

  const info = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    return {
      name: X.spec.meta.name,
      text: document.querySelector('.xhud .title-screen')?.textContent ?? '',
    };
  });
  expect(info.text).toContain(info.name);
  expect(info.text).toContain('CLICK TO START');
  expect(info.text).toContain('XANDRIA');
  expect(info.text).toMatch(/WASD|move/i);

  // the start button has an infinite pulse animation, so click it via evaluate
  // (bypasses Playwright's actionability stability check)
  await page.evaluate(() => (document.querySelector('.xhud .title-screen .start-btn') as HTMLElement).click());
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 10000 });
  const gone = await page.evaluate(() => !document.querySelector('.xhud .title-screen'));
  expect(gone).toBe(true);
});

test('?autostart=1 skips the title screen', async ({ page }) => {
  await page.goto(URL('autostart=1'), { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });
  const title = await page.evaluate(() => !!document.querySelector('.xhud .title-screen'));
  expect(title).toBe(false);
});

test('pause menu state machine: Esc toggles, modal pause is sticky', async ({ page }) => {
  await page.goto(URL('autostart=1'), { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'paused', null, { timeout: 5000 });
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('.xhud .overlay button')].map((b) => b.textContent),
  );
  expect(buttons).toEqual(['RESUME', 'RESTART', 'SETTINGS', 'QUIT TO TITLE']);

  // Esc resumes from a menu pause
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 5000 });

  // a modal pause (level-up style) must NOT be dismissed by Esc
  await page.evaluate(() => (window as any).__XANDRIA__.engine.pause());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  let st = await page.evaluate(() => (window as any).__XANDRIA__.engine.state);
  expect(st).toBe('paused');
  await page.evaluate(() => (window as any).__XANDRIA__.engine.resume());
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 5000 });
  st = await page.evaluate(() => (window as any).__XANDRIA__.engine.state);
  expect(st).toBe('playing');
});

test('in-place restart rebuilds the run deterministically', async ({ page }) => {
  await page.goto(URL('test=1'), { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });

  const snapshot = () =>
    page.evaluate(() => {
      const X = (window as any).__XANDRIA__;
      const eng = X.engine;
      const bp: any = X.blueprint;
      const p = bp.avatar.ctrl.position;
      return {
        frame: eng.frame as number,
        avatar: [p.x, p.y, p.z] as number[],
        enemies: bp.enemies.enemies.length as number,
        bodies: eng.physics.world.bodies.length as number,
        children: eng.scene.children.length as number,
        hooks: (eng as any).updateHooks.length as number,
        state: eng.state as string,
      };
    });

  const before = await snapshot();
  expect(before.state).toBe('playing');

  await page.evaluate(() => (window as any).__XANDRIA__.engine.restart());
  // replay the same number of sim frames the first run had elapsed
  await page.waitForFunction(
    (f: number) => {
      const e = (window as any).__XANDRIA__.engine;
      return e.frame >= f && e.state === 'playing';
    },
    before.frame,
    { timeout: 30000 },
  );
  const after = await snapshot();

  expect(after.state).toBe('playing');
  expect(after.enemies).toBe(before.enemies);
  expect(after.bodies).toBe(before.bodies);
  expect(after.children).toBe(before.children);
  expect(after.hooks).toBe(before.hooks);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(after.avatar[i] - before.avatar[i])).toBeLessThan(1e-6);
  }
});

test('settings persist across reload', async ({ page }) => {
  await page.goto(URL('autostart=1'), { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine, null, { timeout: 30000 });
  await page.evaluate(() => {
    (window as any).__XANDRIA__.engine.settings.set({ volume: 0.33, muted: true, quality: 'high' });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine, null, { timeout: 30000 });
  const s = await page.evaluate(() => (window as any).__XANDRIA__.engine.settings.data);
  expect(s.volume).toBeCloseTo(0.33);
  expect(s.muted).toBe(true);
  expect(s.quality).toBe('high');
});
