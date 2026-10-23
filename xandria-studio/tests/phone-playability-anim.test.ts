/**
 * QA fix wave 2026-10-22 (phone-playability), F2 — walk-cycle phase teleports
 * under speed changes above 6 m/s.
 *
 * Pre-fix, makeHumanoid().animate() computed the stride phase as
 *   f = t * (max(speed, 6) / (0.7 * legL0))
 * — a function of ABSOLUTE elapsed time. Below 6 m/s the rate is pinned and
 * the pose is stable; above 6 m/s the rate tracks instantaneous speed, so
 * every speed wobble injects a phase error ∝ t·Δw and limbs teleport frame
 * to frame (measured pre-fix: ~1.39 rad max frame-to-frame hip jump under
 * 7 ± 0.8 m/s jitter @3 Hz). The fix accumulates a per-rig phase integral
 * (stridePhase += w(speed)·dt); the w(speed) rate function (M2 foot-skate
 * matching) and all amplitudes are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import { MaterialLibrary } from '../src/engine/gfx/Materials';

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const rigOf = (): CharacterRig => makeHumanoid(new MaterialLibrary(testSpec), {}, 11);

/** Drive animate() at 60 fps with a time-varying speed; return max |Δ hip|. */
function maxHipJump(rig: CharacterRig, seconds: number, t0: number, speedAt: (tau: number) => number): number {
  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  let prev = 0;
  let maxD = 0;
  for (let i = 0; i <= frames; i++) {
    const tau = i * dt;
    rig.animate(t0 + tau, speedAt(tau), {});
    const th = rig.limbs.legL.rotation.x;
    if (i > 0) maxD = Math.max(maxD, Math.abs(th - prev));
    prev = th;
  }
  return maxD;
}

describe('F2: stride phase continuity under time-varying speed', () => {
  it('7 ± 0.8 m/s jitter @3 Hz from t0=300: no frame-to-frame hip teleport', () => {
    const rig = rigOf();
    const maxD = maxHipJump(rig, 5, 300, (tau) => 7 + 0.8 * Math.sin(2 * Math.PI * 3 * tau));
    // Pre-fix: ≈1.39 rad (FAIL). Post-fix bound: one frame of true phase
    // advance at max rate ≈ 0.7 · w(7.8) / 60 ≈ 0.19 rad; 0.35 leaves margin.
    expect(maxD).toBeLessThan(0.35);
  });

  it('6↔7 m/s threshold-crossing sweep stays continuous', () => {
    const rig = rigOf();
    // slow sine sweeping across the 6 m/s cadence clamp both ways
    const maxD = maxHipJump(rig, 8, 300, (tau) => 6.5 + 1.0 * Math.sin(2 * Math.PI * 0.5 * tau));
    expect(maxD).toBeLessThan(0.35);
  });

  it('control: constant 7 m/s is smooth (passed pre-fix too)', () => {
    const rig = rigOf();
    const maxD = maxHipJump(rig, 3, 300, () => 7);
    expect(maxD).toBeLessThan(0.35);
  });

  it('control: jitter below the clamp (5 ± 0.8 m/s) is smooth', () => {
    const rig = rigOf();
    const maxD = maxHipJump(rig, 5, 300, (tau) => 5 + 0.8 * Math.sin(2 * Math.PI * 3 * tau));
    expect(maxD).toBeLessThan(0.35);
  });
});
