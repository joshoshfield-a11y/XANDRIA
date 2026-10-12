/**
 * Beta playthrough bots — workstream A.
 *
 * One deterministic playthrough bot per genre. Each bot drives the game ONLY
 * through window.__XANDRIA__ (via the shared contract in ./lib.ts) — no game
 * source is imported or modified.
 *
 * Loop: lib.readWorld() every ~400ms real time, apply a per-genre policy,
 * until engine.frame advances the genre's frame budget (180 default, 300 for
 * racing — see GENRE_FRAMES) of rendered frames, or a real-time cap hits. NOTE on frame counting: ?test=1 runs 10 sim substeps per rendered
 * frame and engine.frame counts RENDERED frames.
 *
 * RUNTIME ADJUSTMENT (2026-10-10): headless SwiftShader here renders
 * ~0.25-0.4 fps, so the original 1080-frame target (3 sim-minutes) would take
 * ~45+ real minutes per genre. Target is 180 rendered frames (~30 sim-seconds)
 * or the 12-minute real-time cap, whichever comes first — enough for a
 * competent bot to demonstrate genuine progress. Set BOT_FRAMES to override.
 * Racing gets 300 frames / 14-minute cap / 18-minute timeout (2026-10-11):
 * the seeded 827 m track needs ~40 sim-sec for a genuine lap at the bot's
 * safe cruise pace — 180 frames can only "lap" via start-line dithering.
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
// Per-genre frame budgets. Racing needs 300: 180 frames = 30 sim-seconds at
// 10 substeps/frame, but the seeded 827 m track needs ~40 sim-sec for a
// genuine lap at the bot's safe 20 m/s cruise — 180 frames can only ever
// "complete" a lap via start-line dithering artifacts, not real driving.
const GENRE_FRAMES: Record<string, number> = { racing: 300 };
const GENRE_CAP_MS: Record<string, number> = { racing: 14 * 60 * 1000 };
const GENRE_TIMEOUT_MIN: Record<string, number> = { racing: 18 };
const TARGET_FRAMES_DEFAULT = 180;
const REAL_CAP_MS_DEFAULT = 12 * 60 * 1000;
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
    /**
     * Racing telemetry + pure-pursuit target, computed in-browser in one shot
     * (one page.evaluate per tick instead of several round trips).
     *
     * The old fixed 3-sample lookahead (~16 m) was far too close at boost
     * speeds: the car oscillated, scraped barriers, and on some runs never
     * finished the lap it had nearly completed during calibration. The new
     * target walks forward along the centerline by a speed-scaled lookahead
     * (pure pursuit), and the policy also gets curvature-ahead, the nearest
     * curve param (same convention as the game's own nearestT), a wrong-way
     * flag, and the distance to the next checkpoint gate.
     */
    B.raceState = (backup: boolean): {
      px: number; pz: number; speed: number;
      tx: number; tz: number; err: number; curveAhead: number; curveFar: number;
      playerT: number; wrongWay: boolean; distToCp: number; nextCp: number;
      aiD: number; steerU: number;
    } => {
      const track = X.blueprint.track;
      const ch = X.blueprint.car.chassis;
      if (!B.raceSamples) {
        B.raceSamples = track.curve.getSpacedPoints(300);
        B.raceTrackLen = track.curve.getLength();
      }
      const S = B.raceSamples as { x: number; z: number }[];
      const N = S.length;
      const px = ch.position.x, pz = ch.position.z;
      const vx = ch.velocity.x, vz = ch.velocity.z;
      const speed = Math.hypot(vx, vz);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < N; i++) {
        const d = (S[i].x - px) ** 2 + (S[i].z - pz) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      const playerT = bi / N;
      // pure-pursuit lookahead, speed-scaled. When backing up (car faces
      // backward at spawn), walk the centerline BACKWARD so the target is
      // ahead in the direction the car faces.
      const L = Math.min(45, Math.max(8, 8 + speed * 0.8));
      const walk = (from: number, dist: number): number => {
        let acc = 0;
        for (let k = 1; k <= N; k++) {
          const a = S[(from + k - 1) % N], b = S[(from + k) % N];
          acc += Math.hypot(b.x - a.x, b.z - a.z);
          if (acc >= dist) return (from + k) % N;
        }
        return from;
      };
      const walkBack = (from: number, dist: number): number => {
        let acc = 0;
        for (let k = 1; k <= N; k++) {
          const a = S[(((from - k + 1) % N) + N) % N], b = S[(((from - k) % N) + N) % N];
          acc += Math.hypot(b.x - a.x, b.z - a.z);
          if (acc >= dist) return (((from - k) % N) + N) % N;
        }
        return from;
      };
      const w = backup ? walkBack : walk;
      const ti = w(bi, L);
      const fi = w(ti, L);
      const gi = w(fi, L); // one more lookahead for early braking decisions
      const tgt = S[ti], f = S[fi], g = S[gi];
      // curvature ahead: angle between (car→target) and (target→further)
      const d1x = tgt.x - px, d1z = tgt.z - pz;
      const d2x = f.x - tgt.x, d2z = f.z - tgt.z;
      const m1 = Math.hypot(d1x, d1z) || 1, m2 = Math.hypot(d2x, d2z) || 1;
      const cosA = Math.max(-1, Math.min(1, (d1x * d2x + d1z * d2z) / (m1 * m2)));
      const curveAhead = Math.acos(cosA);
      // far curvature (for early braking): angle between (target→further)
      // and (further→even further) — sees turns 2L..3L ahead
      const e1x = f.x - tgt.x, e1z = f.z - tgt.z;
      const e2x = g.x - f.x, e2z = g.z - f.z;
      const n1 = Math.hypot(e1x, e1z) || 1, n2 = Math.hypot(e2x, e2z) || 1;
      const cosB = Math.max(-1, Math.min(1, (e1x * e2x + e1z * e2z) / (n1 * n2)));
      const curveFar = Math.acos(cosB);
      // heading error to target (car forward = local -z → bearing yaw+PI)
      const q = ch.quaternion;
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
      const err = B.wrapPi(Math.atan2(tgt.x - px, tgt.z - pz) - (yaw + Math.PI));
      // wrong-way: velocity opposes the track tangent at the nearest point
      const tA = S[(bi + 2) % N], tB = S[(bi - 2 + N) % N];
      let gx = tA.x - tB.x, gz = tA.z - tB.z;
      const gm = Math.hypot(gx, gz) || 1; gx /= gm; gz /= gm;
      const wrongWay = speed > 4 && (vx * gx + vz * gz) < 0;
      // next checkpoint gate (gates at t = 0.25/0.5/0.75, then the lap wrap)
      let nextCp = 1.0;
      for (const c of [0.25, 0.5, 0.75]) if (c > playerT + 0.01) { nextCp = c; break; }
      const distToCp = (nextCp - playerT) * (B.raceTrackLen as number);
      // nearest AI car (collision-avoidance + diagnostics)
      let aiD = Infinity;
      for (const a of (X.blueprint.aiCars || [])) {
        const mp = a.mesh.position;
        const d = Math.hypot(mp.x - px, mp.z - pz);
        if (d < aiD) aiD = d;
      }
      // Geometric pure-pursuit steering: δ = atan(2·wheelbase·sin(err)/L),
      // normalized by the speed-sensitive maxSteer (mirrors
      // VehicleController). Proportional — no bang-bang weaving.
      // steerU > 0 ⇒ steer left ⇒ injected as axes.x = -steerU.
      // NOTE: sin(err)≈0 at err≈π (facing exactly away) — the geometric
      // formula gives ~zero steering there. The Node policy overrides with
      // full lock for |err|>1.0 (see below), so this is only used for
      // fine tracking.
      const wheelbase = 2.3;
      const delta = Math.atan2(2 * wheelbase * Math.sin(err), L);
      const maxSteer = 0.55 / (1 + speed * 0.045);
      const steerU = Math.max(-1, Math.min(1, delta / maxSteer));
      return { px, pz, speed, tx: tgt.x, tz: tgt.z, err, curveAhead, curveFar, playerT, wrongWay, distToCp, nextCp, aiD, steerU };
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
 * Racing: pure-pursuit steering toward a speed-scaled lookahead point on the
 * track centerline (X.blueprint.track.curve IS exposed), with speed control:
 * boost only when roughly straight, coast (lift throttle — engine braking
 * applies, no handbrake: brake is a drift initiator) on very sharp turns at
 * speed. Wrong-way driving is detected and recovered by steering the car
 * around (err ≈ π saturates the bang-bang steer). Tap 'reset' if stuck.
 *
 * Steering-sign calibration is TWO-SIDED and verified: a single-sided
 * Δheading measurement is unreliable here — at ~0.6 fps the car can clip a
 * barrier or catch air during the measurement window, flipping the apparent
 * sign (observed across runs: -0.738 vs +0.921 for the same input). So we
 * measure 'left' AND 'right' on the smooth velocity heading (not the
 * bump-noisy chassis quaternion) and only accept the result if both phases
 * moved >3 m at >4 m/s, both |Δ|>0.05, and the signs oppose. Up to 3
 * attempts (rebuild speed between them); otherwise fall back to +1 — the
 * analytic mapping (err>0 ⇒ target left of nose ⇒ press 'left'; derived from
 * VehicleController's steer = -axes.x·maxSteer and cannon-es' +steer = left),
 * which drove a full lap in the verified run.
 */
function racingPolicy(): Policy {
  return {
    async init(page, ctx) {
      // Steering sign: analytic leftSign=+1 (err>0 ⇒ target left of nose ⇒
      // press 'left'). Derived from VehicleController (steer=-axes.x·maxSteer;
      // 'left' ⇒ axes.x=-1 ⇒ +steer) and cannon-es (+steer rotates the wheels
      // left about +y), and confirmed by the pre-hardening bot's verified
      // full lap on this default. The old empirical calibration is GONE:
      // at ~0.6 fps its full-lock full-speed phases always ended with the car
      // crashed off the racing line (v≈0, nearestT jumping discontinuously
      // across the infield — the "score 300 at baseline" was 3 gates awarded
      // via that jump, not real driving), poisoning the whole run: the car
      // then spent 180 frames dithering near the finish, clipping the start
      // gantry post, instead of driving the lap from the start line.
      ctx.data.leftSign = 1;
      ctx.notes.push('steer sign: analytic leftSign=+1 (empirical calibration removed — it crashed the car off-track)');
      const facts = await page.evaluate(() => {
        const X = (window as any).__XANDRIA__;
        return { len: X.blueprint.track.curve.getLength() as number, width: X.blueprint.track.width as number };
      });
      ctx.notes.push(`track length=${facts.len.toFixed(0)}m width=${facts.width}m`);
      ctx.data.trackLen = facts.len;
      ctx.data.distDrivenM = 0;
      ctx.data.lastPlayerT = undefined;
      ctx.data.lastCheck = null;
      ctx.data.lastResetFrame = -1e9;
      ctx.data.wrongStreak = 0;
      ctx.data.wrongWayTotal = 0;
      ctx.data.maxPlayerT = 0;
      ctx.data.minDistToCp = Infinity;
      ctx.data.checkpoints = 0;
      ctx.data.resets = 0;
      ctx.data.escapeUntilFrame = -1;
      ctx.data.resetPos = null;
      ctx.data.uturnMode = false;
      ctx.data.lastScore = (await lib.readWorld(page)).score;
    },
    async tick(page, snap, tickIdx, ctx) {
      const backingUp = !!ctx.data.backingUp;
      const st = await page.evaluate((b) => (window as any).__BOT__.raceState(b), backingUp);
      const leftSign = (ctx.data.leftSign as number) ?? 1;

      // Backup phase: at spawn the car faces backward. Drive 30 m "backward"
      // (in -t, which is forward in the direction the car faces) to get room
      // for the U-turn, then turn around with plenty of longitudinal space.
      if (!ctx.data.backedUp && Math.abs(st.err) > 2.4 && !backingUp) {
        ctx.data.backingUp = true;
        ctx.data.backupSx = st.px; ctx.data.backupSz = st.pz;
      }
      if (backingUp) {
        const dx = st.px - (ctx.data.backupSx as number);
        const dz = st.pz - (ctx.data.backupSz as number);
        if (Math.hypot(dx, dz) > 30) {
          ctx.data.backingUp = false;
          ctx.data.backedUp = true;
        }
      }

      // Genuine-driving odometer: forward meters along the track, wrap-aware.
      // Deltas >41 m in one tick are nearestT discontinuities (infield jumps),
      // not driving — ignored. Reversing is not counted either.
      const lpT = ctx.data.lastPlayerT as number | undefined;
      if (typeof lpT === 'number') {
        let dpt = st.playerT - lpT;
        if (dpt < -0.5) dpt += 1; else if (dpt > 0.5) dpt -= 1;
        if (dpt > 0 && dpt < 0.05) {
          ctx.data.distDrivenM = (ctx.data.distDrivenM as number) + dpt * (ctx.data.trackLen as number);
        }
      }
      ctx.data.lastPlayerT = st.playerT;

      // Post-reset escape maneuver: respawn drops the car at a safe snapshot,
      // but the pure-pursuit target can route straight back into the same
      // barrier pocket (observed: re-pin within 4 frames of a reset). For a
      // bounded window after each bot-initiated reset, reverse out with
      // mirrored steering until the car is >8 m from its post-reset spot
      // (or the frame budget for the maneuver expires), then resume pursuit.
      if (!ctx.data.resetPos && (ctx.data.escapeUntilFrame as number) >= 0) {
        ctx.data.resetPos = { x: st.px, z: st.pz };
      }
      const rp = ctx.data.resetPos as { x: number; z: number } | null;
      if (rp && snap.frame < (ctx.data.escapeUntilFrame as number)
          && dist2(rp.x, rp.z, st.px, st.pz) < 8) {
        // reverse out with mirrored proportional steering (steering mirrors
        // in reverse: negate steerU) and moderate reverse throttle
        await page.evaluate(
          ([x, y]) => (window as any).__XANDRIA__.engine.input.inject([], { lx: x, ly: y }),
          [st.steerU, 0.5] as const,
        );
        return false;
      }
      if (rp) {
        const wasEscaping = (ctx.data.escapeUntilFrame as number) >= 0;
        ctx.data.resetPos = null;
        ctx.data.escapeUntilFrame = -1;
        if (wasEscaping) ctx.notes.push(`post-reset escape complete at frame ${snap.frame}`);
      }

      // checkpoint-crossing detection via score jumps (+100 per gate, +500/lap)
      if (snap.score > (ctx.data.lastScore as number)) {
        ctx.data.checkpoints = (ctx.data.checkpoints as number) + 1;
        ctx.notes.push(`checkpoint #${ctx.data.checkpoints} crossed at frame ${snap.frame} (score ${ctx.data.lastScore}→${snap.score})`);
      }
      ctx.data.lastScore = snap.score;
      if (st.playerT > (ctx.data.maxPlayerT as number)) ctx.data.maxPlayerT = st.playerT;
      if (st.distToCp < (ctx.data.minDistToCp as number)) ctx.data.minDistToCp = st.distToCp;

      // --- adaptive cruise: target speed from upcoming curvature ---
      // The car hits ~49 m/s on plain throttle but the 70° pre-finish turn
      // needs ~10 m/s. A fixed cruise either crashes (too fast) or can't lap
      // in the frame budget (too slow). Target speed follows curveAhead:
      // fast on straights, slow in turns. 'brake' is a drift initiator, so
      // it is ONLY used in the brakeZone (|err| < 0.1 ⇒ no steering ⇒ no
      // drift kick — pure deceleration in a straight line). Boost is
      // deliberately unused: it only adds crash energy.
      const curve = st.curveAhead;
      // Anticipate: the max of near and (discounted) far curvature, so the
      // target speed drops BEFORE the hairpin, not when we're in it.
      const c = Math.max(curve, st.curveFar * 0.8);
      let target = 25;
      if (c > 1.0) target = 8;
      else if (c > 0.6) target = 12;
      else if (c > 0.3) target = 18;
      // U-turn: facing away from the target (spawn faces backward) — turn
      // slowly so the car doesn't slide into the barrier mid-turn. Latched:
      // the |err|>2.4 entry condition alone releases mid-turn (err falls as
      // the car rotates, speed jumps back up, the arc goes wide and beaches
      // U-turn via wiggle (K-turn): a 180° arc needs ~15 m but the track is
      // 12 m, so a single forward arc pins on the barrier. Instead, alternate
      // forward/reverse with full lock — each segment rotates the nose ~90°
      // in place, and the car keeps moving (no softlock). Mirrored steering
      // when reversing keeps the nose rotating the same way.
      // 5 m/s: turn radius ≈ wheelbase/tan(maxSteer) ≈ 4.8 m, so the 180°
      // arc (≈9.6 m across) fits the 12 m track.
      if (Math.abs(st.err) > 2.4) ctx.data.uturnMode = true;
      else if (Math.abs(st.err) < 0.5) ctx.data.uturnMode = false;
      if (ctx.data.uturnMode || Math.abs(st.err) > 0.5) target = Math.min(target, 5);
      // AI traffic: don't rear-end a slower car directly ahead — lift.
      if (st.aiD < 12 && st.speed > 14) target = Math.min(target, 10);
      // Brake when well above target and straight enough not to drift.
      // (No curve<0.4 gate: if a hairpin is ahead we must slow NOW, even if
      // we're already at its entry — the |err| gate keeps it drift-free.)
      const brakeZone = st.speed > target + 6 && Math.abs(st.err) < 0.15;
      // --- proportional control via continuous axes injection ---
      // steerU (+ = left) from geometric pure-pursuit; throttle proportional
      // to the speed deficit. inject([], {lx, ly}): axes.x = lx (steer =
      // -axes.x·maxSteer ⇒ lx = -steerU), axes.y = -ly, throttle = -axes.y
      // ⇒ ly = -throttleCmd. Verified empirically in-probe.
      // Full lock for large errors: the geometric formula has a singularity
      // at err≈π (sin π = 0 ⇒ no steering when facing exactly away).
      const steerMag = Math.abs(st.err) > 1.0 ? 1 : Math.abs(st.steerU);
      const steerU = Math.sign(st.err) * steerMag;
      const throttleCmd = Math.max(0, Math.min(1, (target - st.speed) * 0.25));
      const lx = -steerU;
      const ly = -throttleCmd;
      const brakeActs = brakeZone ? ['brake'] : [];
      await page.evaluate(
        ([a, x, y]) => (window as any).__XANDRIA__.engine.input.inject(a, { lx: x, ly: y }),
        [brakeActs, lx, ly] as const,
      );

      // wrong-way recovery: pure-pursuit already steers the car around
      // (err≈π saturates steerU); note on the 3rd consecutive tick
      if (st.wrongWay) {
        ctx.data.wrongStreak = (ctx.data.wrongStreak as number) + 1;
        ctx.data.wrongWayTotal = (ctx.data.wrongWayTotal as number) + 1;
        if ((ctx.data.wrongStreak as number) === 3) {
          ctx.notes.push(`wrong-way driving at frame ${snap.frame} (playerT=${st.playerT.toFixed(2)}) — steering to turn around`);
        }
      } else {
        ctx.data.wrongStreak = 0;
      }

      // position trail for post-run analysis (every ~30 s wall)
      if (tickIdx % 75 === 0) {
        ctx.notes.push(
          `trail f${snap.frame} pos=(${st.px.toFixed(1)},${st.pz.toFixed(1)}) ` +
          `spd=${st.speed.toFixed(1)} t=${st.playerT.toFixed(2)} dCp=${st.distToCp.toFixed(0)}m ` +
          `err=${st.err.toFixed(2)} curve=${st.curveAhead.toFixed(2)} aiD=${st.aiD.toFixed(0)}m` +
          `${st.wrongWay ? ' WRONGWAY' : ''}`);
      }
      // Stuck detection is WALL-CLOCK based, matching the softlock assertion's
      // 20 s wall windows. 5 s: a pinned car must be reset fast — a slow
      // U-turn pin was eating whole 20 s windows even with 8 s detection.
      // 5 s ≈ 3 frames; a healthy car covers 15+ m in that time, so <1 m is
      // unambiguous. False positives just cost a reset (safe respawn).
      const STUCK_MS = 5_000;
      const lc = ctx.data.lastCheck as { t: number; x: number; z: number; f: number } | null;
      const nowMs = Date.now();
      const lastResetF = (ctx.data.lastResetFrame as number) ?? -1e9;
      if (!lc || nowMs - lc.t >= STUCK_MS) {
        if (lc
            && dist2(lc.x, lc.z, st.px, st.pz) < 1
            && snap.frame - lc.f >= 2
            && snap.frame - lastResetF >= 3) {
          await tap(page, 'reset');
          ctx.data.lastResetFrame = snap.frame;
          ctx.data.resets = (ctx.data.resets as number) + 1;
          ctx.data.escapeUntilFrame = snap.frame + 6; // bounded reverse-out window
          ctx.data.resetPos = null; // captured on the next tick (post-respawn)
          ctx.notes.push(`stuck (<1m in ${STUCK_MS / 1000}s wall) — tapped 'reset' at frame ${snap.frame}`);
        }
        ctx.data.lastCheck = { t: nowMs, x: st.px, z: st.pz, f: snap.frame };
      }
      return false;
    },
  };
}

// ------------------------------------------------------------------- runner

interface BotMetrics {
  frames: number; scoreStart: number; scoreEnd: number;
  progressStart: number; progressEnd: number; softlockWindows: number;
  /** Racing diagnostics (populated by racingPolicy via ctx.data). */
  checkpoints?: number; minDistToCpM?: number; maxPlayerT?: number;
  wrongWayTicks?: number; resets?: number; steerSign?: number;
  /** Forward meters driven along the track (wrap-aware, jumps ignored). */
  distDrivenM?: number;
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
  const targetFrames = Number(process.env.BOT_FRAMES ?? GENRE_FRAMES[def.name] ?? TARGET_FRAMES_DEFAULT);
  const realCapMs = Number(process.env.BOT_REAL_CAP_MS ?? GENRE_CAP_MS[def.name] ?? REAL_CAP_MS_DEFAULT);

  try {
    await lib.boot(page, def.intent, def.genre);
    await installBotHelpers(page);
    await lib.drainEngineErrors(page, cap.errors);
    const policy = makePolicy();
    if (policy.init) await policy.init(page, ctx);
    snap0 = await lib.readWorld(page);
    notes.push(`baseline frame=${snap0.frame} score=${snap0.score} progress=${snap0.progress}`);
    const frameTarget = snap0.frame + targetFrames;
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
      if (snap.frame >= frameTarget) { notes.push(`reached ${targetFrames} rendered frames`); break; }
      if (now - started > realCapMs) { notes.push('hit real-time cap; stopping bot'); break; }
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
      // racing diagnostics, when the policy recorded them
      ...(typeof ctx.data.checkpoints === 'number' ? {
        checkpoints: ctx.data.checkpoints as number,
        minDistToCpM: ctx.data.minDistToCp as number,
        maxPlayerT: ctx.data.maxPlayerT as number,
        wrongWayTicks: ctx.data.wrongWayTotal as number,
        resets: ctx.data.resets as number,
        steerSign: ctx.data.leftSign as number,
        distDrivenM: Math.round(ctx.data.distDrivenM as number),
      } : {}),
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
    test.setTimeout((GENRE_TIMEOUT_MIN[g.name] ?? 15) * 60 * 1000);
    const report = await runBot(page, g, POLICIES[g.name]);
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `bots-${g.name}.json`), JSON.stringify(report, null, 2) + '\n');
    expect(report.passed, `[${g.name}] ${report.summary}\nnotes: ${report.notes.join(' / ')}`).toBe(true);
  });
}
