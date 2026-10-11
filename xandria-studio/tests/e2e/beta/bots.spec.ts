/**
 * Beta playthrough bots — workstream A.
 *
 * One deterministic playthrough bot per genre. Each bot drives the game ONLY
 * through window.__XANDRIA__ (via the shared contract in ./lib.ts) — no game
 * source is imported or modified.
 *
 * Loop: lib.readWorld() every ~400ms real time, apply a per-genre policy,
 * until engine.frame advances TARGET_FRAMES rendered frames, or a real-time
 * cap hits. NOTE on frame counting: ?test=1 runs 10 sim substeps per rendered
 * frame and engine.frame counts RENDERED frames.
 *
 * RUNTIME ADJUSTMENT (2026-10-10): headless SwiftShader here renders
 * ~0.25-0.4 fps, so the original 1080-frame target (3 sim-minutes) would take
 * ~45+ real minutes per genre. Target is 180 rendered frames (~30 sim-seconds)
 * or the 12-minute real-time cap, whichever comes first — enough for a
 * competent bot to demonstrate genuine progress. Set BOT_FRAMES to override.
 *
 * Env overrides (for smoke tests): BOT_FRAMES, BOT_REAL_CAP_MS.
 *
 * Assertions per bot:
 *  (1) error capture (pageerror + console.error + drained __XANDRIA_ERRORS) empty
 *  (2) score or objectives.progress strictly greater than at start
 *  (3) no softlock: player position changes >1m in every rolling 20s window,
 *      unless the bot was continuously engaging an enemy in that window
 *  (4) lib.nanScan() returns []
 *
 * Results contract: each test writes tests/e2e/beta/results/bots-<name>.json
 * { suite:'bots', name, genre, passed, durationMs, metrics:{...}, errors:[], notes }.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from './lib';

// ---------------------------------------------------------------- constants

const TICK_MS = 400;
const TARGET_FRAMES = Number(process.env.BOT_FRAMES ?? 180); // 180 rendered frames ≈ 30 sim-seconds @10 substeps/frame
const REAL_CAP_MS = Number(process.env.BOT_REAL_CAP_MS ?? 12 * 60 * 1000);
const WINDOW_MS = 20_000;
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'results');

// ---------------------------------------------------------------- small utils

const wrapPi = (a: number): number => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const dist2 = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz);

interface TickRec { t: number; x: number; z: number; engaging: boolean; }
interface BotCtx { notes: string[]; data: Record<string, unknown>; }
interface Policy {
  init?(page: Page, ctx: BotCtx): Promise<void>;
  /** One control tick. Returns true if the bot was engaging an enemy this tick. */
  tick(page: Page, snap: lib.WorldSnapshot, tickIdx: number, ctx: BotCtx): Promise<boolean>;
}

function nearestAlive(
  enemies: lib.WorldSnapshot['enemies'], px: number, pz: number, maxD = Infinity,
): lib.WorldSnapshot['enemies'][number] | null {
  let best: lib.WorldSnapshot['enemies'][number] | null = null;
  let bd = maxD;
  for (const e of enemies) {
    if (!e.alive || !Number.isFinite(e.x) || !Number.isFinite(e.z)) continue;
    const d = dist2(px, pz, e.x, e.z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function nearestPickup(
  pickups: lib.WorldSnapshot['pickups'], px: number, pz: number,
): lib.WorldSnapshot['pickups'][number] | null {
  let best: lib.WorldSnapshot['pickups'][number] | null = null;
  let bd = Infinity;
  for (const p of pickups) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const d = dist2(px, pz, p.x, p.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ------------------------------------------------------- in-browser helpers

/** Install window.__BOT__ helpers (plain JS, no THREE global needed). */
async function installBotHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const X = (window as any).__XANDRIA__;
    const B: any = ((window as any).__BOT__ = {});
    B.wrapPi = (a: number): number => {
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return a;
    };
    /** Drive an avatar blueprint: camera-space axes for a world-space dir.
     *
     *  CharacterController maps input axes to world as
     *    dir = M * [ax.x; ax.y],  M = [[c,-s],[-s,-c]],  c/s = cos/sin(camYaw)
     *  and M is its own inverse, so the exact inverse is
     *    ax.x = c*dx - s*dz,  ax.y = -s*dx - c*dz.
     *  Input.axes reads ax.x = lx, ax.y = -ly from injected axes, hence
     *    lx = c*dx - s*dz,  ly = s*dx + c*dz. */
    B.drive = (actions: string[], dx: number, dz: number): void => {
      const camYaw = (X.blueprint.avatar?.ctrl?.camYaw ?? 0) as number;
      const c = Math.cos(camYaw), s = Math.sin(camYaw);
      X.engine.input.inject(actions, { lx: c * dx - s * dz, ly: s * dx + c * dz });
    };
    B.tap = (a: string): void => { X.engine.input.tap(a); };
    /** FPS aim: one-shot mouse-look turn (yaw + pitch) toward a world point. */
    B.aimAt = (x: number, y: number, z: number): void => {
      const cam = X.engine.camera;
      const e = cam.matrixWorld.elements as number[];
      const fx = -e[8], fy = -e[9], fz = -e[10];
      const curYaw = Math.atan2(fx, fz);
      const curPitch = Math.asin(Math.max(-1, Math.min(1, fy)));
      const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
      const wantYaw = Math.atan2(dx, dz);
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
      X.engine.input.look.x = -B.wrapPi(wantYaw - curYaw) / 0.0026;
      X.engine.input.look.y = -(wantPitch - curPitch) / 0.0024;
    };
    /** Top-down aim: project a world point to NDC and set the aim pointer. */
    B.aimPointer = (x: number, y: number, z: number): boolean => {
      const cam = X.engine.camera;
      const mv = cam.matrixWorldInverse.elements as number[];
      const pr = cam.projectionMatrix.elements as number[];
      const mul = (m: number[], vx: number, vy: number, vz: number): number[] => [
        m[0] * vx + m[4] * vy + m[8] * vz + m[12],
        m[1] * vx + m[5] * vy + m[9] * vz + m[13],
        m[2] * vx + m[6] * vy + m[10] * vz + m[14],
        m[3] * vx + m[7] * vy + m[11] * vz + m[15],
      ];
      const v = mul(mv, x, y, z);
      if (v[2] > 0) return false; // behind the camera
      const c = mul(pr, v[0], v[1], v[2]);
      X.engine.input.setPointerPos(c[0] / c[3], c[1] / c[3]);
      return true;
    };
    /** Racing: target point on the track centerline, a little ahead of the car. */
    B.raceTarget = (): { x: number; z: number } => {
      const track = X.blueprint.track;
      const p = X.blueprint.car.chassis.position;
      if (!B.raceSamples) B.raceSamples = track.curve.getSpacedPoints(150);
      const S = B.raceSamples as { x: number; z: number }[];
      let bi = 0, bd = Infinity;
      for (let i = 0; i < S.length; i++) {
        const d = (S[i].x - p.x) ** 2 + (S[i].z - p.z) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      const ahead = S[(bi + Math.max(2, Math.floor(S.length * 0.02))) % S.length];
      return { x: ahead.x, z: ahead.z };
    };
  });
}

async function driveAvatar(page: Page, actions: string[], dx: number, dz: number): Promise<void> {
  await page.evaluate(
    ([a, dx, dz]) => (window as any).__BOT__.drive(a, dx, dz),
    [actions, dx, dz] as const,
  );
}

async function tap(page: Page, action: string): Promise<void> {
  await page.evaluate((a) => (window as any).__BOT__.tap(a), action);
}

/** Auto-dismiss a blocking modal (level-up / branch choice: both use .lvlopt). */
async function dismissModal(page: Page, notes: string[]): Promise<void> {
  const clicked = await page.evaluate(() => {
    const b = document.querySelector('.lvlopt') as HTMLButtonElement | null;
    if (b) { b.click(); return true; }
    return false;
  });
  notes.push(clicked ? 'auto-dismissed blocking modal (.lvlopt)' : 'paused with no .lvlopt button found');
}

// ------------------------------------------------------------------ policies

function wanderTarget(px: number, pz: number, tickIdx: number): [number, number] {
  const a = tickIdx * 0.3; // deterministic slow yaw drift
  return [px + Math.sin(a) * 12, pz + Math.cos(a) * 12];
}

/** Third-person action: seek pickups, close on enemies, melee swing in range. */
function tpActionPolicy(): Policy {
  return {
    async tick(page, snap, tickIdx) {
      const p = snap.player;
      if (!p || !Number.isFinite(p.x)) return false;
      const foe = nearestAlive(snap.enemies, p.x, p.z, 40);
      const pk = nearestPickup(snap.pickups, p.x, p.z);
      let engaging = false;
      if (foe && dist2(p.x, p.z, foe.x, foe.z) < 3.2) {
        await tap(page, 'attack'); // melee() consumes justPressed('attack')
        engaging = true;
      }
      const tgt = foe ?? pk;
      let tx: number, tz: number;
      if (tgt) { tx = tgt.x; tz = tgt.z; } else [tx, tz] = wanderTarget(p.x, p.z, tickIdx);
      const d = dist2(p.x, p.z, tx, tz) || 1;
      await driveAvatar(page, ['forward', 'sprint'], (tx - p.x) / d, (tz - p.z) / d);
      return engaging;
    },
  };
}

/** FPS arena: steer camera onto the nearest live enemy (yaw+pitch), hold fire. */
function fpsArenaPolicy(): Policy {
  return {
    async tick(page, snap, tickIdx) {
      const p = snap.player;
      if (!p || !Number.isFinite(p.x)) return false;
      const foe = nearestAlive(snap.enemies, p.x, p.z, 32);
      const pk = nearestPickup(snap.pickups, p.x, p.z);
      const engaging = !!foe;
      if (foe) {
        await page.evaluate(
          ([x, y, z]) => (window as any).__BOT__.aimAt(x, y, z),
          [foe.x, foe.y + 1.0, foe.z] as const,
        );
      }
      // movement: close distance while far, hold ground while firing up close
      let tx: number | undefined; let tz: number | undefined;
      let acts: string[];
      if (foe) {
        const d = dist2(p.x, p.z, foe.x, foe.z);
        acts = ['attack']; // pressed('attack') fires the gun
        if (d > 9) { tx = foe.x; tz = foe.z; acts = ['forward', 'attack']; }
        else { tx = p.x; tz = p.z; }
      } else if (pk) {
        tx = pk.x; tz = pk.z; acts = ['forward'];
      } else {
        [tx, tz] = wanderTarget(p.x, p.z, tickIdx); acts = ['forward'];
      }
      const d = dist2(p.x, p.z, tx, tz) || 1;
      await driveAvatar(page, acts, (tx - p.x) / d, (tz - p.z) / d);
      return engaging;
    },
  };
}

/** Top-down: twin-stick — move toward pickups (kite when crowded), aim pointer at nearest foe. */
function topdownPolicy(): Policy {
  return {
    async tick(page, snap, tickIdx) {
      const p = snap.player;
      if (!p || !Number.isFinite(p.x)) return false;
      const foe = nearestAlive(snap.enemies, p.x, p.z, 30);
      const pk = nearestPickup(snap.pickups, p.x, p.z);
      const engaging = !!foe;
      if (foe) {
        await page.evaluate(
          ([x, y, z]) => (window as any).__BOT__.aimPointer(x, y, z),
          [foe.x, foe.y + 1.0, foe.z] as const,
        );
      }
      let tx: number, tz: number;
      if (foe && dist2(p.x, p.z, foe.x, foe.z) < 5) {
        // kite: run directly away from the closest foe
        const d = dist2(p.x, p.z, foe.x, foe.z) || 1;
        tx = p.x - ((foe.x - p.x) / d) * 10;
        tz = p.z - ((foe.z - p.z) / d) * 10;
      } else if (pk) { tx = pk.x; tz = pk.z; }
      else [tx, tz] = wanderTarget(p.x, p.z, tickIdx);
      const d = dist2(p.x, p.z, tx, tz) || 1;
      await driveAvatar(page, engaging ? ['attack'] : [], (tx - p.x) / d, (tz - p.z) / d);
      return engaging;
    },
  };
}

/** Platformer: hold right + sprint, jump every ~1.6s to clear gaps. */
function platformerPolicy(): Policy {
  return {
    async tick(page, _snap, tickIdx) {
      await page.evaluate((doJump: boolean) => {
        const X = (window as any).__XANDRIA__;
        X.engine.input.inject(['right', 'sprint'], null);
        if (doJump) X.engine.input.tap('jump'); // jump is justPressed-driven
      }, tickIdx % 4 === 0);
      return false;
    },
  };
}

/**
 * Racing: full throttle + boost, bang-bang steering toward a lookahead point
 * on the track centerline (X.blueprint.track.curve IS exposed). Steering sign
 * is calibrated empirically at init ('left' Δheading). Tap 'reset' if stuck.
 *
 * Calibration is TWO-SIDED and verified: a single-sided Δheading measurement
 * is unreliable here — at ~0.3 fps the car can clip a barrier or catch air
 * during the measurement window, flipping the apparent sign (observed across
 * runs: -0.738 vs +0.921 for the same input). So we measure 'left' AND 'right'
 * on the smooth velocity heading (not the bump-noisy chassis quaternion) and
 * only accept the result if both phases moved >3 m at >4 m/s, both |Δ|>0.05,
 * and the signs oppose. Otherwise we fall back to +1 (the natural mapping:
 * target left of nose → press left → car turns left), which drove a full lap
 * in the verified run.
 */
function racingPolicy(): Policy {
  return {
    async init(page, ctx) {
      const drive = (acts: string[]) => page.evaluate(
        (a) => (window as any).__XANDRIA__.engine.input.inject(a, null), acts);
      // Frame-based waits: at ~0.3 fps a wall-clock wait is less than one
      // rendered frame, so calibration phases must count frames.
      const waitFrames = async (n: number) => {
        const f0 = await page.evaluate(() => (window as any).__XANDRIA__.engine.frame as number);
        const t0 = Date.now();
        for (;;) {
          const s = await lib.readWorld(page);
          if (s.state === 'paused') await dismissModal(page, ctx.notes);
          if (s.frame - f0 >= n || Date.now() - t0 > 180_000) return;
          await page.waitForTimeout(1000);
        }
      };
      const vel = () => page.evaluate(() => {
        const c = (window as any).__XANDRIA__.blueprint.car.chassis;
        return { hx: c.velocity.x, hz: c.velocity.z, sp: Math.hypot(c.velocity.x, c.velocity.z), px: c.position.x, pz: c.position.z };
      });
      const headOf = (hx: number, hz: number) => Math.atan2(hx, hz);

      await drive(['forward']);
      await waitFrames(8); // build speed on the start straight
      const v0 = await vel();
      await drive(['forward', 'left']);
      await waitFrames(10);
      const v1 = await vel();
      await drive(['forward', 'right']);
      await waitFrames(10);
      const v2 = await vel();
      await drive([]);

      const d1 = wrapPi(headOf(v1.hx, v1.hz) - headOf(v0.hx, v0.hz));
      const d2 = wrapPi(headOf(v2.hx, v2.hz) - headOf(v1.hx, v1.hz));
      const moved1 = Math.hypot(v1.px - v0.px, v1.pz - v0.pz);
      const moved2 = Math.hypot(v2.px - v1.px, v2.pz - v1.pz);
      const ok = v0.sp > 4 && v1.sp > 4 && v2.sp > 4
        && moved1 > 3 && moved2 > 3
        && Math.abs(d1) > 0.05 && Math.abs(d2) > 0.05
        && Math.sign(d1) === -Math.sign(d2);
      const sign = ok ? Math.sign(d1) : 1;
      ctx.data.leftSign = sign;
      ctx.notes.push(
        `steer calibration: left Δ=${d1.toFixed(3)} right Δ=${d2.toFixed(3)} ` +
        `moved=${moved1.toFixed(1)}/${moved2.toFixed(1)}m ` +
        `speed=${v0.sp.toFixed(1)}/${v1.sp.toFixed(1)}/${v2.sp.toFixed(1)}m/s ` +
        `→ ${ok ? 'VERIFIED' : 'UNVERIFIED, default +1'} leftSign=${sign}`);
      ctx.data.lastCheck = null;
      ctx.data.lastResetFrame = -1e9;
    },
    async tick(page, snap, tickIdx, ctx) {
      const p = snap.player;
      if (!p || !Number.isFinite(p.x)) return false;
      const tgt = await page.evaluate(() => (window as any).__BOT__.raceTarget());
      // car forward = local -z → bearing convention atan2(x,z) gives yaw+PI
      const err = wrapPi(Math.atan2(tgt.x - p.x, tgt.z - p.z) - (p.yaw + Math.PI));
      const leftSign = (ctx.data.leftSign as number) ?? 1;
      const acts = ['forward', 'boost'];
      if (err * leftSign > 0.15) acts.push('left');
      else if (err * leftSign < -0.15) acts.push('right');
      await page.evaluate((a) => (window as any).__XANDRIA__.engine.input.inject(a, null), acts);
      // position trail for post-run trap analysis (every ~30 s wall)
      if (tickIdx % 75 === 0) {
        ctx.notes.push(`trail f${snap.frame} pos=(${p.x.toFixed(1)},${p.z.toFixed(1)}) yaw=${p.yaw.toFixed(2)}`);
      }
      // Stuck detection is WALL-CLOCK based, matching the softlock assertion's
      // 20 s wall windows. A frame-count detector is unusable here: at
      // ~0.2 fps, 12 rendered frames ≈ 60 s wall, so every crash would sit
      // through 2-3 softlock windows before the reset fired. Instead: if the
      // car moved <1 m in the last ~12 s wall AND the sim advanced ≥2 frames
      // in that span (don't conclude "stuck" across a render stall) AND ≥3
      // frames elapsed since the last reset (post-respawn acceleration grace),
      // tap reset.
      const STUCK_MS = 12_000;
      const lc = ctx.data.lastCheck as { t: number; x: number; z: number; f: number } | null;
      const nowMs = Date.now();
      const lastResetF = (ctx.data.lastResetFrame as number) ?? -1e9;
      if (!lc || nowMs - lc.t >= STUCK_MS) {
        if (lc
            && dist2(lc.x, lc.z, p.x, p.z) < 1
            && snap.frame - lc.f >= 2
            && snap.frame - lastResetF >= 3) {
          await tap(page, 'reset');
          ctx.data.lastResetFrame = snap.frame;
          ctx.notes.push(`stuck (<1m in ${STUCK_MS / 1000}s wall) — tapped 'reset' at frame ${snap.frame}`);
        }
        ctx.data.lastCheck = { t: nowMs, x: p.x, z: p.z, f: snap.frame };
      }
      return false;
    },
  };
}

// ------------------------------------------------------------------- runner

interface BotMetrics {
  frames: number; scoreStart: number; scoreEnd: number;
  progressStart: number; progressEnd: number; softlockWindows: number;
}
interface BotReport {
  suite: 'bots'; name: string; genre: string; passed: boolean; durationMs: number;
  metrics: BotMetrics; errors: string[]; notes: string[]; summary: string;
}

function checkSoftlock(ticks: TickRec[]): { windows: number; violations: number; detail: string } {
  if (ticks.length === 0) return { windows: 0, violations: 0, detail: 'no ticks recorded' };
  let windows = 0, violations = 0;
  const bad: string[] = [];
  let start = 0;
  for (;;) {
    const t0 = ticks[start].t;
    let end = start;
    while (end < ticks.length && ticks[end].t - t0 < WINDOW_MS) end++;
    const slice = ticks.slice(start, end);
    if (slice.length >= 8) {
      const a = slice[0], b = slice[slice.length - 1];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const engFrac = slice.filter((t) => t.engaging).length / slice.length;
      const ok = Number.isFinite(d) && (d > 1.0 || engFrac >= 0.5);
      if (!ok) {
        violations++;
        bad.push(`window@${Math.round((t0 - ticks[0].t) / 1000)}s moved ${Number.isFinite(d) ? d.toFixed(2) : 'NaN'}m engaging ${(engFrac * 100).toFixed(0)}%`);
      }
      windows++;
    }
    if (end >= ticks.length) break;
    start = end;
  }
  return { windows, violations, detail: bad.join('; ') };
}

async function runBot(
  page: Page, def: { name: string; intent: string; genre: string }, makePolicy: () => Policy,
): Promise<BotReport> {
  const started = Date.now();
  const cap = lib.attachErrorCapture(page);
  const notes: string[] = [];
  const ctx: BotCtx = { notes, data: {} };
  const ticks: TickRec[] = [];
  let snap0: lib.WorldSnapshot | null = null;
  let fatal = '';

  try {
    await lib.boot(page, def.intent, def.genre);
    await installBotHelpers(page);
    await lib.drainEngineErrors(page, cap.errors);
    const policy = makePolicy();
    if (policy.init) await policy.init(page, ctx);
    snap0 = await lib.readWorld(page);
    notes.push(`baseline frame=${snap0.frame} score=${snap0.score} progress=${snap0.progress}`);
    const frameTarget = snap0.frame + TARGET_FRAMES;
    let i = 0;
    for (;;) {
      const snap = await lib.readWorld(page);
      const now = Date.now();
      if (snap.state === 'paused') {
        await dismissModal(page, notes);
        await page.waitForTimeout(250);
        continue;
      }
      if (snap.state !== 'playing') {
        notes.push(`engine left 'playing' → '${snap.state}'; stopping bot`);
        break;
      }
      if (snap.frame >= frameTarget) { notes.push(`reached ${TARGET_FRAMES} rendered frames`); break; }
      if (now - started > REAL_CAP_MS) { notes.push('hit real-time cap; stopping bot'); break; }
      let engaging = false;
      try {
        engaging = await policy.tick(page, snap, i, ctx);
      } catch (e) {
        notes.push(`policy.tick threw: ${String(e).slice(0, 160)}`);
      }
      if (snap.player && Number.isFinite(snap.player.x)) {
        ticks.push({ t: now, x: snap.player.x, z: snap.player.z, engaging });
      }
      i++;
      await page.waitForTimeout(TICK_MS);
    }
  } catch (e) {
    fatal = String(e).slice(0, 300);
    notes.push(`fatal: ${fatal}`);
  }

  await lib.drainEngineErrors(page, cap.errors).catch(() => undefined);
  const snap1 = snap0 ? await lib.readWorld(page).catch(() => null) : null;
  const nan = snap0 ? await lib.nanScan(page).catch(() => ['nanScan threw']) : ['boot failed'];
  const lock = checkSoftlock(ticks);

  const score0 = snap0?.score ?? NaN, score1 = snap1?.score ?? NaN;
  const p0raw = snap0?.progress, p1raw = snap1?.progress;
  const p0 = typeof p0raw === 'number' && Number.isFinite(p0raw) ? p0raw : -1;
  const p1 = typeof p1raw === 'number' && Number.isFinite(p1raw) ? p1raw : -1;
  const errOk = cap.errors.length === 0;
  const progOk = Number.isFinite(score1) && Number.isFinite(score0) && (score1 > score0 || p1 > p0);
  const lockOk = lock.violations === 0 && lock.windows > 0;
  const nanOk = nan.length === 0;
  const passed = !fatal && errOk && progOk && lockOk && nanOk;

  const frames = snap1 && snap0 ? snap1.frame - snap0.frame : 0;
  const summaryParts = [
    `errors:${cap.errors.length}`, `score ${score0}→${score1}`, `progress ${p0}→${p1}`,
    `softlock ${lock.violations}/${lock.windows}`, `nan:${nan.length}`, `frames:${frames}`,
  ];
  if (fatal) summaryParts.push(`FATAL ${fatal}`);
  if (lock.detail) summaryParts.push(`softlock: ${lock.detail}`);

  return {
    suite: 'bots',
    name: def.name,
    genre: def.genre,
    passed,
    durationMs: Date.now() - started,
    metrics: {
      frames, scoreStart: score0, scoreEnd: score1,
      progressStart: p0, progressEnd: p1, softlockWindows: lock.windows,
    },
    errors: cap.errors,
    notes,
    summary: summaryParts.join(' | '),
  };
}

const POLICIES: Record<string, () => Policy> = {
  'tp-action': tpActionPolicy,
  'fps-arena': fpsArenaPolicy,
  'racing': racingPolicy,
  'platformer': platformerPolicy,
  'topdown': topdownPolicy,
};

for (const g of lib.GENRES) {
  test(`bot ${g.name}: ${g.genre} playthrough`, async ({ page }) => {
    test.setTimeout(15 * 60 * 1000);
    const report = await runBot(page, g, POLICIES[g.name]);
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `bots-${g.name}.json`), JSON.stringify(report, null, 2) + '\n');
    expect(report.passed, `[${g.name}] ${report.summary}\nnotes: ${report.notes.join(' / ')}`).toBe(true);
  });
}
