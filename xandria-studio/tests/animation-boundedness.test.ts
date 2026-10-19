/**
 * Regression tests for QA round 2026-10-19 (video round).
 *
 * M1: AnimationAdjust lean / head-yaw must be BOUNDED across frames.
 *     The old code did `torso.rotation.x += lean` every frame while
 *     Characters.animate() never reset that channel — the lean integrated
 *     without bound (2.6 rad after one sprint burst, 9.8 rad after four),
 *     producing the permanent "bowing" pose. Head yaw drifted the same way.
 *     The fix sets absolute per-frame values; these tests drive the real
 *     per-frame pipeline (animate() → AnimationAdjust.apply()) the way
 *     CharacterController does.
 *
 * M2: stride frequency must match foot speed to ground speed (no skating).
 *     (tests below)
 */
import { describe, expect, it } from 'vitest';
import { makeHumanoid, type CharacterRig } from '../src/engine/gfx/Characters';
import { MaterialLibrary } from '../src/engine/gfx/Materials';
import { AnimationAdjust, type AdjustState } from '../src/engine/physics/AnimationAdjust';

const testSpec: any = {
  meta: { seed: 7, name: 'Test', genre: 'fps-arena' },
  custom: {},
  theme: { palette: { sky: '#000', ground: '#111', fog: '#222' }, retroFilter: false },
};
const rigOf = (): CharacterRig => makeHumanoid(new MaterialLibrary(testSpec), {}, 11);

/** Drive the real per-frame pipeline: animate() then the AnimationAdjust post-pass. */
function driveFrames(rig: CharacterRig, frames: number, speed: number, s: AdjustState): void {
  for (let i = 0; i < frames; i++) {
    rig.animate(i / 60, speed, {});
    AnimationAdjust.apply(rig, s);
  }
}

describe('M1: AnimationAdjust lean is bounded across frames', () => {
  it('torso lean stays within the clamp under acceleration bursts and returns to ~0', () => {
    const rig = rigOf();
    // 4 s of hard acceleration: leanF = clamp(8*0.045, 0, 0.32) = 0.32.
    // Pre-fix this integrated to ~77 rad.
    driveFrames(rig, 240, 5, { accel: 8, brake: 0, turnRate: 0, weaponCarry: false });
    expect(Math.abs(rig.limbs.torso.rotation.x)).toBeLessThanOrEqual(0.32 + 1e-9);
    // release: no accel/brake → the lean must return to the base pose
    driveFrames(rig, 60, 5, { accel: 0, brake: 0, turnRate: 0, weaponCarry: false });
    expect(Math.abs(rig.limbs.torso.rotation.x)).toBeLessThan(0.01);
  });

  it('torso lean stays bounded under braking too', () => {
    const rig = rigOf();
    // leanB = clamp(10*0.055, 0, 0.38) = 0.38
    driveFrames(rig, 240, 5, { accel: 0, brake: 10, turnRate: 0, weaponCarry: false });
    expect(rig.limbs.torso.rotation.x).toBeGreaterThanOrEqual(-0.38 - 1e-9);
    expect(rig.limbs.torso.rotation.x).toBeLessThan(0);
    driveFrames(rig, 60, 5, { accel: 0, brake: 0, turnRate: 0, weaponCarry: false });
    expect(Math.abs(rig.limbs.torso.rotation.x)).toBeLessThan(0.01);
  });

  it('head yaw stays bounded while turning and returns to ~0', () => {
    const rig = rigOf();
    // leanT = clamp(3*0.06, -0.25, 0.25) = 0.18 → head = -0.09.
    // Pre-fix this integrated to ~-22 rad.
    driveFrames(rig, 240, 5, { accel: 0, brake: 0, turnRate: 3, weaponCarry: false });
    expect(Math.abs(rig.limbs.head.rotation.y)).toBeLessThanOrEqual(0.125 + 1e-9);
    driveFrames(rig, 60, 5, { accel: 0, brake: 0, turnRate: 0, weaponCarry: false });
    expect(Math.abs(rig.limbs.head.rotation.y)).toBeLessThan(0.01);
  });
});
