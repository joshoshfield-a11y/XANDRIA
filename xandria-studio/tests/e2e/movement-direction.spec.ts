/**
 * Directional movement regression test (wave-character workstream A).
 *
 * Root cause (MOBILE-GRAPHICS-TRIAGE-2026-10-10 §1): CharacterController maps
 * input "forward" to (-sin camYaw, -cos camYaw), but the third-person camera
 * rig looks along (+sin, +cos) — 180° off. Pressing forward drove the character
 * TOWARD the camera. The joystick/Input.axes chain is correct and untouched;
 * the fix is a +PI yaw offset where the manual rigs feed the controller.
 *
 * These tests assert movement direction RELATIVE TO THE CAMERA (or the car's
 * own forward), which no earlier test did — every prior test only asserted
 * local consistency ("did it move > 0.5 m").
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
});

interface Vec { x: number; y: number; z: number; }

/** Drive `actions` for `ms`, return displacement + camera view direction. */
async function drive(page: any, actions: string[], ms = 2500): Promise<{ d: Vec; view: Vec; dist: number }> {
  return page.evaluate(async ([acts, wait]: [string[], number]) => {
    const X = (window as any).__XANDRIA__;
    const eng = X.engine;
    const b: any = X.blueprint;
    const body = b?.car ? b.car.chassis : b?.avatar?.ctrl?.position;
    const read = () => {
      const p = b?.car ? b.car.chassis.position : b?.avatar?.ctrl?.position;
      return { x: p.x, y: p.y, z: p.z };
    };
    const p0 = read();
    eng.input.inject(acts);
    await new Promise((r) => setTimeout(r, wait));
    eng.input.inject([], null);
    const p1 = read();
    const d = { x: p1.x - p0.x, y: 0, z: p1.z - p0.z };
    // camera view dir = -z column of the camera's world matrix (no THREE needed in-page)
    const e = eng.camera.matrixWorld.elements;
    const view = { x: -e[8], y: -e[9], z: -e[10] };
    const dist = Math.hypot(d.x, d.z);
    return { d, view, dist };
  }, [actions, ms]);
}

async function boot(page: any, intent: string, genre: string) {
  await page.goto(`/player.html?test=1&intent=${encodeURIComponent(intent)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });
  const g = await page.evaluate(() => (window as any).__XANDRIA__.spec.meta.genre);
  expect(g).toBe(genre);
}

const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;

test('tp-action: forward drives the character AWAY from the camera', async ({ page }) => {
  await boot(page, 'sword adventure in ancient ruins', 'third-person-action');
  const { d, view, dist } = await drive(page, ['forward']);
  expect(dist).toBeGreaterThan(0.5); // it actually moved
  expect(dot(d, view)).toBeGreaterThan(0); // ...away from the camera, not toward it
});

test('tp-action: back drives the character toward the camera', async ({ page }) => {
  await boot(page, 'sword adventure in ancient ruins', 'third-person-action');
  const { d, view, dist } = await drive(page, ['back']);
  expect(dist).toBeGreaterThan(0.5);
  expect(dot(d, view)).toBeLessThan(0);
});

test('fps-arena: forward still drives away from the camera (guard)', async ({ page }) => {
  await boot(page, 'neon fps arena at night', 'fps-arena');
  const { d, view, dist } = await drive(page, ['forward']);
  expect(dist).toBeGreaterThan(0.5);
  expect(dot(d, view)).toBeGreaterThan(0);
});

test('topdown: forward still drives away from the camera (guard)', async ({ page }) => {
  await boot(page, 'top-down horde shooter', 'top-down-shooter');
  const { d, view, dist } = await drive(page, ['forward']);
  expect(dist).toBeGreaterThan(0.5);
  expect(dot(d, view)).toBeGreaterThan(0);
});

test('platformer: D drives screen-right (+x), not into the screen (+z)', async ({ page }) => {
  await boot(page, 'dreamy platformer', 'platformer');
  const { d, dist } = await drive(page, ['right']);
  expect(dist).toBeGreaterThan(0.5);
  expect(d.x).toBeGreaterThan(0.5); // screen-right is world +x for the side camera
  expect(Math.abs(d.z)).toBeLessThan(Math.abs(d.x)); // not drifting into the screen
});

test('platformer: forward drives away from the side camera', async ({ page }) => {
  await boot(page, 'dreamy platformer', 'platformer');
  const { d, view, dist } = await drive(page, ['forward']);
  expect(dist).toBeGreaterThan(0.5);
  expect(dot(d, view)).toBeGreaterThan(0);
});

test('racing: W throttles the car along its own forward (-z local)', async ({ page }) => {
  await boot(page, 'desert racing grand prix', 'racing');
  const res = await page.evaluate(async () => {
    const X = (window as any).__XANDRIA__;
    const eng = X.engine;
    const car = X.blueprint.car;
    // car's forward = local -z rotated by the chassis quaternion
    const q = car.chassis.quaternion;
    const fwd = {
      x: -2 * (q.x * q.z + q.w * q.y),
      y: 0,
      z: 2 * (q.x * q.x + q.y * q.y) - 1,
    };
    const p0 = { x: car.chassis.position.x, z: car.chassis.position.z };
    eng.input.inject(['forward']);
    await new Promise((r) => setTimeout(r, 2500));
    eng.input.inject([], null);
    const p1 = { x: car.chassis.position.x, z: car.chassis.position.z };
    const d = { x: p1.x - p0.x, y: 0, z: p1.z - p0.z };
    return { d, fwd, dist: Math.hypot(d.x, d.z) };
  });
  expect(res.dist).toBeGreaterThan(1.0);
  expect(dot(res.d, res.fwd)).toBeGreaterThan(0);
});
