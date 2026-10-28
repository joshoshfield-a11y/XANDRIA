/**
 * Photo mode — e2e verification.
 *
 * Fixture: npcs.b64 (seed 20261012, tp-action) — the same deterministic
 * world as the hud-polish spec, so the real HUD, avatar and camera rig
 * are all live.
 *
 * Desktop (1280x720): enter via the HUD chip, assert every overlay is
 * hidden exactly, assert the sim is frozen (elapsed + avatar position
 * identical across wall-clock time in photo mode), orbit via real mouse
 * drag + wheel and via synthetic two-pointer pinch, screenshot via the
 * canvas capture path, then exit in one synchronous evaluate and assert
 * the camera + HUD are restored EXACTLY (no frame runs between exit()
 * and the read) and gameplay state is unchanged across the toggle.
 * Escape and the O key are exercised as the exit/toggle paths.
 *
 * Mobile (360x780, hasTouch): same enter/exit through the chip and the
 * photo bar's own buttons, with the >= 28px touch-target floor asserted
 * on the chip and both bar buttons.
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
  const t0 = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      return !!(X?.engine && X?.photoTest && X.engine.state === 'playing' && X.engine.portalsPlayerAvatar);
    });
    if (ready) break;
    if (Date.now() - t0 > 80_000) throw new Error('photo-mode boot timeout');
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => {
    const X = (window as unknown as X).__XANDRIA__;
    X.engine.portalsPlayerAvatar.health = X.engine.portalsPlayerAvatar.maxHealth = 1e9;
  });
}

const approx = (a: number[], b: number[], eps = 1e-6): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

test.describe('photo mode', () => {
  test('desktop: HUD hidden, sim frozen, orbit/zoom, screenshot, exact restore', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors);

    // Chip: present, labelled, >= 28px touch target.
    const chipBox = await page.evaluate(() => {
      const el = document.querySelector('.xphoto-chip') as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, text: el.textContent };
    });
    expect(chipBox).not.toBeNull();
    expect(chipBox!.h).toBeGreaterThanOrEqual(28);
    expect(chipBox!.text).toContain('PHOTO');

    // Enter via the HUD chip.
    await page.click('.xphoto-chip');
    await page.waitForFunction(() => (window as unknown as X).__XANDRIA__?.photoTest.active(), undefined, { timeout: 10_000 });
    // Enter-time gameplay baseline: the first frozen frame has already
    // run, so elapsed/avatar here are the exact frozen values.
    const entered = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const p = X.engine.portalsPlayerAvatar.ctrl.position;
      return { elapsed: X.engine.elapsed, avatar: [p.x, p.y, p.z] };
    });

    // HUD hidden EXACTLY: every container child except the canvas and
    // the photo bar is display:none; the photo bar is visible.
    const hidden = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const container = X.engine.container as HTMLElement;
      const canvas = X.engine.renderer.domElement;
      const out: Array<{ cls: string; display: string }> = [];
      for (const child of Array.from(container.children)) {
        const el = child as HTMLElement;
        if (el === canvas || el.classList.contains('xphoto-bar')) continue;
        out.push({ cls: el.className || el.tagName, display: getComputedStyle(el).display });
      }
      const bar = container.querySelector('.xphoto-bar') as HTMLElement | null;
      const barRect = bar?.getBoundingClientRect();
      return { children: out, barVisible: !!bar && getComputedStyle(bar).display !== 'none' && (barRect?.height ?? 0) > 0 };
    });
    expect(hidden.barVisible).toBe(true);
    expect(hidden.children.length).toBeGreaterThan(0);
    for (const c of hidden.children) expect(c.display).toBe('none');

    // Bar buttons clear the 28px floor.
    const btnSizes = await page.evaluate(() =>
      [...document.querySelectorAll('.xphoto-bar button')].map((b) => {
        const r = (b as HTMLElement).getBoundingClientRect();
        return { text: b.textContent ?? '', w: r.width, h: r.height };
      }));
    expect(btnSizes.length).toBe(2);
    for (const b of btnSizes) { expect(b.w).toBeGreaterThanOrEqual(28); expect(b.h).toBeGreaterThanOrEqual(28); }

    // Frozen: elapsed + avatar position identical across 600ms of frames.
    const frozenA = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const p = X.engine.portalsPlayerAvatar.ctrl.position;
      return { elapsed: X.engine.elapsed, avatar: [p.x, p.y, p.z] };
    });
    await page.waitForTimeout(600);
    const frozenB = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const p = X.engine.portalsPlayerAvatar.ctrl.position;
      return { elapsed: X.engine.elapsed, avatar: [p.x, p.y, p.z] };
    });
    expect(frozenB.elapsed).toBe(frozenA.elapsed);
    expect(frozenB.avatar).toEqual(frozenA.avatar);

    // Orbit via the seam: camera sits at the orbit distance from the look target.
    // SwiftShader renders ~1 frame/sec on this scene, so wait for the
    // framed state itself instead of a fixed timeout.
    await page.evaluate(() => (window as unknown as X).__XANDRIA__.photoTest.setOrbit({ yaw: 0.6, pitch: 0.5, distance: 12 }));
    await page.waitForFunction(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const p = X.engine.portalsPlayerAvatar.ctrl.position;
      const c = X.engine.camera.position;
      return Math.abs(Math.hypot(c.x - p.x, c.y - (p.y + 1.2), c.z - p.z) - 12) < 0.1;
    }, undefined, { timeout: 30_000 });
    const framed = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const p = X.engine.portalsPlayerAvatar.ctrl.position;
      const c = X.engine.camera.position;
      return Math.hypot(c.x - p.x, c.y - (p.y + 1.2), c.z - p.z);
    });
    expect(framed).toBeGreaterThan(11.5);
    expect(framed).toBeLessThan(12.5);

    // Real mouse drag orbits (yaw moves), real wheel zooms (distance shrinks).
    const orbitBefore = await page.evaluate(() => (window as unknown as X).__XANDRIA__.photoTest.orbit());
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.move(740, 360, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction((yaw0: number) =>
      Math.abs((window as unknown as X).__XANDRIA__.photoTest.orbit().yaw - yaw0) > 0.2, orbitBefore.yaw, { timeout: 30_000 });
    const orbitAfterDrag = await page.evaluate(() => (window as unknown as X).__XANDRIA__.photoTest.orbit());
    expect(Math.abs(orbitAfterDrag.yaw - orbitBefore.yaw)).toBeGreaterThan(0.2);
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, -240);
    await page.waitForFunction((d0: number) =>
      (window as unknown as X).__XANDRIA__.photoTest.orbit().distance < d0, orbitAfterDrag.distance, { timeout: 30_000 });
    const orbitAfterWheel = await page.evaluate(() => (window as unknown as X).__XANDRIA__.photoTest.orbit());
    expect(orbitAfterWheel.distance).toBeLessThan(orbitAfterDrag.distance);

    // Synthetic two-pointer pinch zooms (pinch-out: fingers apart -> closer camera).
    const pinch = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const canvas = X.engine.renderer.domElement;
      const before = X.photoTest.orbit().distance;
      const down = (id: number, x: number, y: number) =>
        canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: id, clientX: x, clientY: y, bubbles: true }));
      const move = (id: number, x: number, y: number) =>
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, clientX: x, clientY: y, bubbles: true }));
      const up = (id: number, x: number, y: number) =>
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, clientX: x, clientY: y, bubbles: true }));
      down(1, 600, 360); down(2, 680, 360);
      move(1, 560, 360); move(2, 720, 360);
      up(1, 560, 360); up(2, 720, 360);
      return { before, after: X.photoTest.orbit().distance };
    });
    expect(pinch.after).toBeLessThan(pinch.before);

    // Screenshot via the canvas capture path (consumed on the next frame).
    // Polled with evaluate + wall-clock sleeps: waitForFunction's default
    // rAF polling stalls when SwiftShader renders ~1 frame/sec.
    const shotRequested = await page.evaluate(() => (window as unknown as X).__XANDRIA__.photoTest.requestCapture());
    expect(shotRequested).toBe(true);
    {
      const t0 = Date.now();
      for (;;) {
        const got = await page.evaluate(() => !!(window as unknown as X).__XANDRIA__.photoTest.lastScreenshot());
        if (got) break;
        if (Date.now() - t0 > 30_000) {
          const diag = await page.evaluate(() => ({
            active: (window as unknown as X).__XANDRIA__.photoTest.active(),
            pending: (window as unknown as X).__XANDRIA__.photoTest.capturePending(),
            frame: (window as unknown as X).__XANDRIA__.engine.frame,
          }));
          throw new Error('screenshot never consumed: ' + JSON.stringify(diag));
        }
        await page.waitForTimeout(500);
      }
    }
    const shot = await page.evaluate(() => (window as unknown as X).__XANDRIA__.photoTest.lastScreenshot());
    expect(shot).not.toBeNull();
    expect(shot!.startsWith('data:image/png;base64,')).toBe(true);
    expect(shot!.length).toBeGreaterThan(2000);

    // Exit + exact restore, all inside one synchronous evaluate: no
    // rendered frame may run between exit() and the camera/HUD reads.
    const restored = await page.evaluate(() => {
      const X = (window as unknown as X).__XANDRIA__;
      const saved = X.photoTest.savedCamera();
      const ok = X.photoTest.exit();
      const after = X.photoTest.cameraState();
      const hud = document.querySelector('.xhud') as HTMLElement | null;
      const p = X.engine.portalsPlayerAvatar.ctrl.position;
      const posDelta = saved
        ? Math.max(...after.position.map((v: number, i: number) => Math.abs(v - saved.position.toArray()[i])))
        : -1;
      const quatDelta = saved
        ? Math.max(...after.quaternion.map((v: number, i: number) => Math.abs(v - saved.quaternion.toArray()[i])))
        : -1;
      return {
        ok, saved, after, posDelta, quatDelta,
        active: X.photoTest.active(),
        hudDisplay: hud ? getComputedStyle(hud).display : 'missing',
        elapsed: X.engine.elapsed,
        avatar: [p.x, p.y, p.z],
      };
    });
    expect(restored.ok).toBe(true);
    expect(restored.active).toBe(false);
    expect(restored.saved).not.toBeNull();
    expect(restored.posDelta).toBeLessThan(1e-6);
    expect(restored.quatDelta).toBeLessThan(1e-6);
    expect(restored.after.fov).toBe(restored.saved!.fov);
    expect(restored.hudDisplay).not.toBe('none');
    // Gameplay state unchanged across the whole toggle (baselined at
    // enter time, when the freeze began).
    expect(restored.elapsed).toBe(entered.elapsed);
    expect(restored.avatar).toEqual(entered.avatar);

    // Toggle keys: O enters, Escape exits (Escape must NOT pause).
    await page.keyboard.press('o');
    await page.waitForFunction(() => (window as unknown as X).__XANDRIA__?.photoTest.active(), undefined, { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !(window as unknown as X).__XANDRIA__?.photoTest.active(), undefined, { timeout: 10_000 });
    const stateAfterEsc = await page.evaluate(() => (window as unknown as X).__XANDRIA__.engine.state);
    expect(stateAfterEsc).toBe('playing');

    expect(errors).toEqual([]);
  });

});

test.describe('photo mode mobile', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

  test('mobile 360x780: chip + bar buttons, HUD hidden and restored', async ({ page }) => {
    const errors: string[] = [];
    await boot(page, errors);

    const chipHBefore = await page.evaluate(() => {
      const chip = document.querySelector('.xphoto-chip') as HTMLElement | null;
      return chip?.getBoundingClientRect().height ?? 0;
    });
    expect(chipHBefore).toBeGreaterThanOrEqual(28);

    await page.click('.xphoto-chip');
    await page.waitForFunction(() => (window as unknown as X).__XANDRIA__?.photoTest.active(), undefined, { timeout: 10_000 });
    const mobile = await page.evaluate(() => {
      const hud = document.querySelector('.xhud') as HTMLElement | null;
      const btns = [...document.querySelectorAll('.xphoto-bar button')].map((b) => {
        const r = (b as HTMLElement).getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      return {
        hudHidden: !!hud && getComputedStyle(hud).display === 'none',
        btns,
      };
    });
    expect(mobile.hudHidden).toBe(true);
    expect(mobile.btns.length).toBe(2);
    for (const b of mobile.btns) { expect(b.w).toBeGreaterThanOrEqual(28); expect(b.h).toBeGreaterThanOrEqual(28); }

    // Screenshot through the bar button, exit through the bar button.
    await page.click('.xphoto-bar button[data-photo-action="capture"]');
    {
      const t0 = Date.now();
      for (;;) {
        const got = await page.evaluate(() => !!(window as unknown as X).__XANDRIA__.photoTest.lastScreenshot());
        if (got) break;
        if (Date.now() - t0 > 30_000) throw new Error('mobile screenshot never consumed');
        await page.waitForTimeout(500);
      }
    }
    const shot = await page.evaluate(() => (window as unknown as X).__XANDRIA__.photoTest.lastScreenshot());
    expect(shot?.startsWith('data:image/png;base64,')).toBe(true);
    await page.click('.xphoto-bar button[data-photo-action="exit"]');
    await page.waitForFunction(() => !(window as unknown as X).__XANDRIA__?.photoTest.active(), undefined, { timeout: 10_000 });
    const hudBack = await page.evaluate(() => {
      const hud = document.querySelector('.xhud') as HTMLElement | null;
      return !!hud && getComputedStyle(hud).display !== 'none';
    });
    expect(hudBack).toBe(true);

    expect(errors).toEqual([]);
  });
});
