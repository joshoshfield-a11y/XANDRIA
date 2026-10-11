/**
 * Soak test — beta workstream D.
 *
 * Single 10-minute unattended endurance run on third-person-action
 * ('sword adventure in ancient ruins'):
 *  - boots via the beta lib, attaches page/console/engine error capture
 *  - runs a deliberately SIMPLE Node-side bot: steer toward the nearest
 *    live enemy (else nearest pickup), tap attack when an enemy is within
 *    ~8 m; if state becomes 'won'/'lost' the bot loop stops but the page
 *    stays alive to the 10-minute mark (a finished run idling is itself
 *    a soak signal)
 *  - samples usedJSHeapSize + engine.frame + player pos every 30 s
 *
 * PASS: (1) error capture empty for the whole run; (2) heap at end <
 * 1.5x the 60 s mark AND linear-fit slope over post-warmup samples
 * projects <= 2x growth over the next hour; (3) lib.nanScan() clean at
 * end; (4) engine.frame increased in every 60 s window while 'playing'.
 *
 * Writes tests/e2e/beta/results/soak.json for the workstream-E harness.
 *
 * Env override SOAK_MS exists only for smoke-testing the harness logic
 * (e.g. SOAK_MS=90000); the graded run uses the default 10 minutes.
 *
 * Test code ONLY — never touches xandria-studio/src.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
import {
  boot, attachErrorCapture, drainEngineErrors, readWorld, nanScan, GENRES,
  type WorldSnapshot,
} from './lib';

const DURATION_MS = Number(process.env.SOAK_MS ?? 10 * 60 * 1000);
const TICK_MS = 500;
const SAMPLE_MS = 30_000;
const WARMUP_MS = 60_000;
const WINDOW_MS = 60_000;
const ATTACK_RANGE_M = 8;
const TAP_COOLDOWN_MS = 1200;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface Target { x: number; y: number; z: number }

function nearestLiveEnemy(snap: WorldSnapshot): { t: Target; d: number } | null {
  if (!snap.player || !finite(snap.player.x)) return null;
  const p = snap.player;
  let best: { t: Target; d: number } | null = null;
  for (const e of snap.enemies) {
    if (!e.alive || !finite(e.x) || !finite(e.y) || !finite(e.z)) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z);
    if (!best || d < best.d) best = { t: { x: e.x, y: e.y, z: e.z }, d };
  }
  return best;
}

function nearestPickup(snap: WorldSnapshot): Target | null {
  if (!snap.player || !finite(snap.player.x)) return null;
  const p = snap.player;
  let best: { t: Target; d: number } | null = null;
  for (const k of snap.pickups) {
    if (!finite(k.x) || !finite(k.y) || !finite(k.z)) continue;
    const d = Math.hypot(k.x - p.x, k.y - p.y, k.z - p.z);
    if (!best || d < best.d) best = { t: { x: k.x, y: k.y, z: k.z }, d };
  }
  return best?.t ?? null;
}

/**
 * Steering in world frame. The avatar moves camera-relative: 'forward'
 * drives along the camera view direction, 'right' strafes along
 * right = view x up. We approximate the view direction as
 * normalize(player - camera) in the xz-plane (third-person follow cam
 * looks at the avatar). Then axes = (dot(d,right), dot(d,view)) and the
 * injected stick is { lx: ax, ly: -ay } because Input.axes does
 * y -= injected.ly.
 */
function steerAxes(snap: WorldSnapshot, target: Target | null): { lx: number; ly: number } {
  const p = snap.player;
  if (!p || !finite(p.x) || !finite(p.z)) return { lx: 0, ly: 0 };
  let vx = p.x - snap.camera.x;
  let vz = p.z - snap.camera.z;
  const vl = Math.hypot(vx, vz);
  if (vl < 1e-6 || !target) return { lx: 0, ly: -1 }; // no view info / no target: walk forward
  vx /= vl; vz /= vl;
  const rx = -vz, rz = vx; // right = view x up
  let dx = target.x - p.x;
  let dz = target.z - p.z;
  const dl = Math.hypot(dx, dz);
  if (dl < 1e-6) return { lx: 0, ly: -1 };
  dx /= dl; dz /= dl;
  return { lx: clamp(dx * rx + dz * rz, -1, 1), ly: -clamp(dx * vx + dz * vz, -1, 1) };
}

test('soak: 10-minute unattended endurance run (tp-action)', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  const genre = GENRES.find((g) => g.name === 'tp-action')!;
  const tStart = Date.now();
  const cap = attachErrorCapture(page);
  const errors: string[] = [];
  const notes: string[] = [`duration target: ${DURATION_MS}ms (SOAK_MS override ${process.env.SOAK_MS ? 'ACTIVE' : 'not set'})`];
  const samples: Array<{ t: number; heapBytes: number | null; frame: number; pos: { x: number; y: number; z: number } | null }> = [];
  const checkpoints: Array<{ t: number; frame: number; state: string }> = [];
  let outcome = 'unknown';
  let passed = false;

  try {
    await boot(page, genre.intent, genre.genre);
    const t0 = Date.now();
    notes.push(`booted in ${t0 - tStart}ms`);

    const takeSample = async (snap: WorldSnapshot) => {
      const heapBytes = await page.evaluate((): number | null => {
        const pm = (performance as unknown as { memory?: { usedJSHeapSize?: unknown } }).memory;
        return pm && typeof pm.usedJSHeapSize === 'number' ? pm.usedJSHeapSize : null;
      });
      samples.push({
        t: Date.now() - t0,
        heapBytes,
        frame: snap.frame,
        pos: snap.player && finite(snap.player.x)
          ? { x: snap.player.x, y: snap.player.y, z: snap.player.z } : null,
      });
    };

    let snap = await readWorld(page);
    checkpoints.push({ t: 0, frame: snap.frame, state: snap.state });
    await takeSample(snap); // t≈0 baseline (pre-warmup, for context only)

    const endAt = t0 + DURATION_MS;
    let botActive = true;
    let lastTap = 0;
    let lastSampleT = 0;
    let nextCheckpointT = WINDOW_MS;
    let lastHeartbeat = 0;
    outcome = 'playing-throughout';

    while (Date.now() < endAt) {
      const now = Date.now();
      const t = now - t0;
      snap = await readWorld(page);

      if (botActive) {
        if (snap.state !== 'playing') {
          outcome = snap.state;
          notes.push(
            `bot loop STOPPED at t=${(t / 1000).toFixed(0)}s: state='${snap.state}' ` +
            `score=${snap.score} progress=${snap.progress} frame=${snap.frame}`,
          );
          await page.evaluate(() => {
            (window as unknown as { __XANDRIA__: { engine: { input: { inject: (a: string[], b: null) => void } } } })
              .__XANDRIA__.engine.input.inject([], null);
          });
          botActive = false;
        } else {
          const enemy = nearestLiveEnemy(snap);
          const target = enemy?.t ?? nearestPickup(snap);
          const { lx, ly } = steerAxes(snap, target);
          const doTap = enemy !== null && enemy.d <= ATTACK_RANGE_M && now - lastTap >= TAP_COOLDOWN_MS;
          if (doTap) lastTap = now;
          await page.evaluate(
            ([ax, ay, tap]: [number, number, boolean]) => {
              const eng = (window as unknown as { __XANDRIA__: { engine: { input: {
                inject: (a: string[], b: { lx: number; ly: number } | null) => void;
                tap: (a: string) => void;
              } } } }).__XANDRIA__.engine;
              eng.input.inject([], { lx: ax, ly: ay });
              if (tap) eng.input.tap('attack');
            },
            [lx, ly, doTap] as [number, number, boolean],
          );
        }
      }

      if (t - lastSampleT >= SAMPLE_MS) {
        lastSampleT = t;
        await takeSample(snap);
        const s = samples[samples.length - 1];
        console.log(
          `[soak] t=${(t / 1000).toFixed(0)}s frame=${snap.frame} ` +
          `heap=${s.heapBytes == null ? 'n/a' : (s.heapBytes / 1048576).toFixed(1) + 'MB'} ` +
          `state=${snap.state} bot=${botActive ? 'active' : 'stopped:' + outcome}`,
        );
      }
      if (t >= nextCheckpointT) {
        checkpoints.push({ t, frame: snap.frame, state: snap.state });
        nextCheckpointT += WINDOW_MS;
      }
      if (t - lastHeartbeat >= 60_000) {
        lastHeartbeat = t;
        console.log(`[soak] heartbeat t=${(t / 1000).toFixed(0)}s/${(DURATION_MS / 1000).toFixed(0)}s`);
      }

      const spent = Date.now() - now;
      await new Promise((r) => setTimeout(r, Math.max(0, TICK_MS - spent)));
    }

    if (botActive) notes.push(`bot survived the full run (state stayed 'playing')`);
    notes.push(`final frame=${snap.frame}; approx sim time=${(snap.frame * 10 / 60 / 60).toFixed(1)} sim-min ` +
      `(test mode: 10 substeps x 1/60s per rendered frame)`);

    // ---- end-of-run checks ----
    await drainEngineErrors(page, errors);
    for (const e of cap.errors) errors.push(e);
    const nan = await nanScan(page);
    if (nan.length) notes.push(`nanScan findings: ${nan.join('; ')}`);

    // memory: post-warmup samples only
    const postWarm = samples.filter((s) => s.t >= WARMUP_MS && s.heapBytes != null);
    let heapStart: number | null = null;
    let heapEnd: number | null = null;
    let growthFactor: number | null = null;
    let slopePerMin: number | null = null;
    let memoryCheck: 'pass' | 'fail' | 'skipped' = 'skipped';
    if (postWarm.length >= 2) {
      heapStart = postWarm[0].heapBytes!;
      heapEnd = postWarm[postWarm.length - 1].heapBytes!;
      growthFactor = heapEnd / heapStart;
      const ts = postWarm.map((s) => s.t / 1000);
      const hs = postWarm.map((s) => s.heapBytes as number);
      const mt = ts.reduce((a, b) => a + b, 0) / ts.length;
      const mh = hs.reduce((a, b) => a + b, 0) / hs.length;
      let num = 0, den = 0;
      for (let i = 0; i < ts.length; i++) { num += (ts[i] - mt) * (hs[i] - mh); den += (ts[i] - mt) ** 2; }
      const slopePerSec = den > 0 ? num / den : 0;
      slopePerMin = slopePerSec * 60;
      const projectedVsStart = (heapStart + slopePerSec * 3600) / heapStart;
      notes.push(
        `heap: start(60s)=${(heapStart / 1048576).toFixed(1)}MB end=${(heapEnd / 1048576).toFixed(1)}MB ` +
        `growthFactor=${growthFactor.toFixed(3)} slope=${(slopePerMin / 1048576).toFixed(2)}MB/min ` +
        `projected-1h=${projectedVsStart.toFixed(2)}x (n=${postWarm.length})`,
      );
      memoryCheck = growthFactor < 1.5 && projectedVsStart <= 2.0 ? 'pass' : 'fail';
      if (postWarm.length >= 5 && new Set(postWarm.map((s) => s.heapBytes)).size === 1) {
        notes.push('HEAP QUANTIZATION WARNING: all post-warmup heap samples bit-identical ' +
          `(${(heapStart! / 1048576).toFixed(1)}MB) — performance.memory may be frozen/quantized ` +
          'in this environment; treat the memory gate as weak evidence, not a strong pass.');
      }
    } else {
      const anyHeap = samples.some((s) => s.heapBytes != null);
      notes.push(`memory check SKIPPED: only ${postWarm.length} post-warmup heap samples ` +
        `(performance.memory ${anyHeap ? 'present but too few samples' : 'UNAVAILABLE in this browser'})`);
    }

    // sim advancement: frame must increase in every 60s window while 'playing'
    const windowIssues: string[] = [];
    for (let i = 1; i < checkpoints.length; i++) {
      const a = checkpoints[i - 1], b = checkpoints[i];
      if (a.state === 'playing' && b.state === 'playing' && !(b.frame > a.frame)) {
        windowIssues.push(`frame stalled t=${a.t}ms->${b.t}ms (${a.frame}->${b.frame})`);
      }
    }
    const playingWindows = checkpoints.slice(1).filter((c, i) => checkpoints[i].state === 'playing' && c.state === 'playing').length;
    if (windowIssues.length) notes.push(`sim-advance issues: ${windowIssues.join('; ')}`);
    else notes.push(`sim advanced in all ${playingWindows} 'playing' 60s windows`);

    notes.push(
      `honest limits: 10 real minutes is not 10 hours; this scene renders ~0.4fps under ` +
      `SwiftShader here (heavier than the ~3fps assumption), so the run covers only ~40-60 ` +
      `sim-seconds — an endurance signal for leaks/crashes, not a long-horizon stability proof; ` +
      `single genre (third-person-action); bot is deliberately simple ` +
      `(greedy steer + 8m attack taps, no pathing, no stuck-detection).`,
    );

    passed = errors.length === 0 && nan.length === 0 && windowIssues.length === 0 && memoryCheck !== 'fail'
      && (memoryCheck === 'pass' || DURATION_MS < WARMUP_MS * 2);
    // (the last clause lets short SOAK_MS smoke runs complete without the
    // memory gate; the graded 10-minute run always evaluates it)

    const durationMs = Date.now() - tStart;
    const result = {
      suite: 'soak',
      name: 'soak-10min',
      passed,
      durationMs,
      metrics: {
        samples: samples.map((s) => ({ t: s.t, heapBytes: s.heapBytes, frame: s.frame, pos: s.pos })),
        heapStart,
        heapEnd,
        growthFactor,
        slopePerMin,
        outcome,
        memoryCheck,
        playingWindows,
      },
      errors,
      notes,
    };
    const outDir = join(HERE, 'results');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'soak.json'), JSON.stringify(result, null, 2));
    console.log(`[soak] ${passed ? 'PASS' : 'FAIL'} outcome=${outcome} errors=${errors.length} ` +
      `growthFactor=${growthFactor?.toFixed(3) ?? 'n/a'} duration=${(durationMs / 1000).toFixed(0)}s`);
  } catch (e) {
    notes.push(`EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
    try {
      const outDir = join(HERE, 'results');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'soak.json'), JSON.stringify({
        suite: 'soak', name: 'soak-10min', passed: false,
        durationMs: Date.now() - tStart,
        metrics: { samples: samples.map((s) => ({ t: s.t, heapBytes: s.heapBytes, frame: s.frame, pos: s.pos })),
          heapStart: null, heapEnd: null, growthFactor: null, slopePerMin: null,
          outcome, memoryCheck: 'skipped', playingWindows: 0 },
        errors, notes,
      }, null, 2));
    } catch { /* best effort */ }
    throw e;
  }

  expect(passed).toBe(true);
});
