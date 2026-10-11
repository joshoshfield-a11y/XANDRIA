/**
 * Polish wave — ANIMATION crew beauty shot.
 * Close-up of the player character mid-action (attack windup, running legs,
 * forward lean) with the HUD hidden.
 * The sim is paused so the hand-posed windup frame can't be overwritten
 * by the controller; rendering keeps running while paused.
 */
import { test, expect } from '@playwright/test';

test('polish: character close-up mid-action', async ({ page }) => {
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto('/player.html?test=1&intent=sword%20adventure%20in%20ancient%20ruins', { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });

  // run forward briefly so the game is verifiably playing (the pose itself is hand-set below)
  await page.evaluate(async () => {
    const X = (window as any).__XANDRIA__;
    X.engine.input.inject(['forward', 'sprint'], { lx: 0, ly: -1 });
    await new Promise((r) => setTimeout(r, 1000));
    X.engine.input.inject([], null);
  });

  // hide HUD, freeze the sim, hand-pose a windup frame, frame a close-up
  const posed = await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const hud = document.querySelector('.xhud') as HTMLElement | null;
    if (hud) hud.style.display = 'none';
    X.engine.pause();
    const ctrl = X.blueprint.avatar.ctrl;
    ctrl.attackT = -1; // the controller can't overwrite the pose while paused
    // late windup: arm cocked high behind, running legs, cape fluttering (noise via t).
    // Repeated calls also drain any leftover damage-flash blink to its cleared state.
    for (let i = 0; i < 20; i++) ctrl.rig.animate(3.7 + i * 0.016, 2.5, { attacking: 0.3 });
    // front-lit close-up: the camera sits on the sun side (shot 1 showed the sun
    // roughly in the -x/-z azimuth), and the model is turned to face it — the
    // paused sim can't override the facing, so no yaw math is needed.
    // NOTE: ctrl.position is the capsule center (~1.2m above the feet), so the
    // chest is near p.y and the camera sits ~1.6m above the feet.
    const p = ctrl.position;
    const cam = X.engine.camera;
    // camera azimuth rotated ~20° off the sun line: still front-lit, but the sun
    // disc sits off to the side instead of directly behind the character's head
    cam.position.set(p.x - 1.8, p.y + 0.4, p.z - 5.0);
    cam.lookAt(p.x, p.y - 0.15, p.z);
    cam.fov = 36;
    cam.updateProjectionMatrix();
    const dx = cam.position.x - p.x, dz = cam.position.z - p.z;
    ctrl.rig.group.rotation.y = Math.atan2(dx, dz) + 0.45; // right-front three-quarter: sword arm reads
    return { state: X.engine.state, armX: ctrl.rig.limbs.armR.rotation.x };
  });
  // the pose must have stuck (paused sim, windup arm raised past -2)
  expect(posed.state).toBe('paused');
  expect(posed.armX).toBeLessThan(-2);
  // let a few frames render the posed shot
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/e2e/shots/polish-character.png' });

  const errs = await page.evaluate(() => (window as any).__XANDRIA_ERRORS);
  expect(errs).toEqual([]);
});
