/**
 * Beta-test shared harness (tests/e2e/beta/).
 *
 * Contract for all beta spec files (bots, fuzz, perf, soak):
 * - boot(page, intent, genre): load + wait for 'playing', assert genre.
 * - attachErrorCapture(page): capture pageerror + console errors into an array.
 * - readWorld(page): one serializable snapshot of bot-relevant state.
 * - nanScan(page): list of "path" strings where NaN/±Infinity was found.
 * - mulberry32(seed): deterministic RNG for the Node side.
 *
 * In-browser state shape (readWorld):
 * {
 *   state, frame, score, progress,
 *   player: { x, y, z, yaw } | null,        // car chassis or avatar ctrl
 *   enemies: [{ x, y, z, alive }],          // blueprint.enemies.enemies
 *   pickups: [{ x, y, z, kind }],           // blueprint.pickups.list
 *   camera: { x, y, z },
 * }
 *
 * Do NOT import game source here — everything goes through window.__XANDRIA__.
 */
import { Page, expect } from '@playwright/test';

export interface GenreDef {
  name: string;
  intent: string;
  genre: string;
}

export const GENRES: GenreDef[] = [
  { name: 'tp-action', intent: 'sword adventure in ancient ruins', genre: 'third-person-action' },
  { name: 'fps-arena', intent: 'neon fps arena at night', genre: 'fps-arena' },
  { name: 'racing', intent: 'desert racing grand prix', genre: 'racing' },
  { name: 'platformer', intent: 'dreamy platformer', genre: 'platformer' },
  { name: 'topdown', intent: 'top-down horde shooter', genre: 'top-down-shooter' },
];

export interface WorldSnapshot {
  state: string;
  frame: number;
  score: number;
  progress: number;
  player: { x: number; y: number; z: number; yaw: number } | null;
  enemies: { x: number; y: number; z: number; alive: boolean }[];
  pickups: { x: number; y: number; z: number; kind: string }[];
  camera: { x: number; y: number; z: number };
}

export async function boot(page: Page, intent: string, expectedGenre: string): Promise<void> {
  await page.goto(`/player.html?test=1&intent=${encodeURIComponent(intent)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });
  const genre = await page.evaluate(() => (window as any).__XANDRIA__.spec.meta.genre);
  expect(genre).toBe(expectedGenre);
}

/** Capture pageerrors + console errors into a live array. */
export function attachErrorCapture(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e && (e as Error).message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  return { errors };
}

/** Drain the engine's own error log (__XANDRIA_ERRORS) into the captured array. */
export async function drainEngineErrors(page: Page, into: string[]): Promise<void> {
  const errs: string[] = await page.evaluate(() => {
    const arr: string[] = ((window as any).__XANDRIA_ERRORS ?? []) as string[];
    (window as any).__XANDRIA_ERRORS = [];
    return arr;
  });
  for (const e of errs) into.push('[engine] ' + e);
}

export async function readWorld(page: Page): Promise<WorldSnapshot> {
  return page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const b: any = X.blueprint ?? {};
    const eng: any = X.engine;
    const num = (v: any) => (typeof v === 'number' ? v : NaN);
    let player: WorldSnapshot['player'] = null;
    if (b.car?.chassis?.position) {
      const p = b.car.chassis.position;
      const q = b.car.chassis.quaternion;
      // car forward yaw from quaternion (for steering decisions)
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
      player = { x: num(p.x), y: num(p.y), z: num(p.z), yaw };
    } else if (b.avatar?.ctrl?.position) {
      const p = b.avatar.ctrl.position;
      player = { x: num(p.x), y: num(p.y), z: num(p.z), yaw: num(b.avatar.ctrl.yaw) };
    }
    const enemies: WorldSnapshot['enemies'] = ((b.enemies?.enemies ?? []) as any[]).map((e: any) => ({
      x: num(e.position?.x), y: num(e.position?.y), z: num(e.position?.z), alive: !!e.alive,
    }));
    // FIX (beta-D soak): Pickup has .pos / .mesh.position, not .position
    // (see engine/game/Pickups.ts). Fall back through all three shapes.
    const pickups: WorldSnapshot['pickups'] = ((b.pickups?.list ?? []) as any[]).map((p: any) => {
      const pp = p.pos ?? p.mesh?.position ?? p.position;
      return { x: num(pp?.x), y: num(pp?.y), z: num(pp?.z), kind: String(p.kind ?? '?') };
    });
    const cp = eng.camera?.position ?? {};
    return {
      state: String(eng.state),
      frame: num(eng.frame),
      score: num(eng.score),
      progress: num(b.objectives?.progress),
      player,
      enemies,
      pickups,
      camera: { x: num(cp.x), y: num(cp.y), z: num(cp.z) },
    };
  });
}

/** Return dotted paths where NaN or ±Infinity appears in key sim state. */
export async function nanScan(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const X = (window as any).__XANDRIA__;
    const b: any = X.blueprint ?? {};
    const eng: any = X.engine;
    const finite = (v: any) => typeof v === 'number' && Number.isFinite(v);
    const checkVec = (path: string, v: any) => {
      if (!v) { bad.push(path + ' missing'); return; }
      for (const k of ['x', 'y', 'z']) if (!finite(v[k])) bad.push(`${path}.${k}=${v[k]}`);
    };
    if (b.car?.chassis?.position) checkVec('car.chassis.position', b.car.chassis.position);
    else checkVec('avatar.ctrl.position', b.avatar?.ctrl?.position);
    ((b.enemies?.enemies ?? []) as any[]).forEach((e: any, i: number) => checkVec(`enemies[${i}].position`, e.position));
    // (pickup shape fix mirrors readWorld: .pos / .mesh.position, not .position)
    ((b.pickups?.list ?? []) as any[]).forEach((p: any, i: number) => checkVec(`pickups[${i}].position`, p.pos ?? p.mesh?.position ?? p.position));
    checkVec('camera.position', eng.camera?.position);
    if (!finite(eng.score)) bad.push(`engine.score=${eng.score}`);
    return bad;
  });
}

/** Deterministic PRNG for the Node side (fuzz intents, monkey input). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
