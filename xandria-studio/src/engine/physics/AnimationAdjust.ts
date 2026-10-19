/**
 * AnimationAdjust (physics wave, item 7): procedural animation adjustments
 * LAYERED over the existing jointed animation.
 *
 * Characters.ts animate() is owned by another crew — this module is an
 * OPTIONAL post-pass: call `AnimationAdjust.apply(rig, state)` AFTER
 * rig.animate(t, speed, opts) and the coordinator wires it in. It applies
 * small clamped rotations on top of whatever animate() posed.
 *
 * BOUNDEDNESS (M1, 2026-10-19): every adjustment here MUST be absolute
 * per-frame (assignment, not +=). animate() does not reset every channel —
 * it never writes torso.rotation.x or head.rotation.y — so an accumulated
 * += integrates without bound across frames (the old lean reached 9.8 rad
 * after four sprint bursts). Channels that animate() re-zeros every frame
 * (torso.rotation.y, the limbs) may safely compose with +=.
 *
 *   - slope foot placement: counter-rotate the legs against ground pitch/roll
 *     so feet stay closer to planted on inclines
 *   - accel/brake lean: torso pitches forward under acceleration, back under
 *     braking; torso yaws slightly into turns
 *   - weapon-carry arm pose: relaxed raise of the weapon arm when carrying
 *     (skipped while the rig is mid-swing — pass attacking=true then)
 *
 * All rotations are clamped and bounded per-frame (see BOUNDEDNESS above);
 * the hot path allocates nothing (state is caller-owned). Dead rigs are skipped.
 */
import * as THREE from 'three';
import type { CharacterRig } from '../gfx/Characters';

export interface AdjustState {
  /** ground normal under the character (from terrain.normalAt); omit for flat */
  slopeNormal?: THREE.Vector3;
  /** planar acceleration magnitude (m/s²) — lean forward */
  accel: number;
  /** braking magnitude (m/s²) — lean back */
  brake: number;
  /** yaw rate (rad/s) — lean into the turn */
  turnRate: number;
  /** true when a weapon is equipped and the rig is NOT mid-swing */
  weaponCarry: boolean;
  /** true while the rig is in its attack animation — skip the arm pose */
  attacking?: boolean;
  /** true for corpses / ragdoll-lite tumble — skip everything */
  dead?: boolean;
}

const clamp = THREE.MathUtils.clamp;

export const AnimationAdjust = {
  apply(rig: CharacterRig, s: AdjustState): void {
    if (s.dead) return;
    const L = rig.limbs;
    if (!L) return;

    // --- accel / brake / turn lean (torso) ---
    const leanF = clamp(s.accel * 0.045, 0, 0.32);
    const leanB = clamp(s.brake * 0.055, 0, 0.38);
    const leanT = clamp(s.turnRate * 0.06, -0.25, 0.25);
    // M1 (2026-10-19): SET absolute per-frame values — never +=. animate()
    // never writes torso.rotation.x or head.rotation.y, so an accumulated +=
    // integrates without bound (2.6 rad after one sprint burst, 9.8 after four).
    L.torso.rotation.x = leanF - leanB;
    // torso.rotation.y keeps += : animate() re-zeros it (or sets the attack
    // coil) every frame before this post-pass runs, so it stays bounded AND
    // composed with the coil. Head yaw is absolute so it can't drift.
    L.torso.rotation.y += leanT;
    L.head.rotation.y = -leanT * 0.5; // head counter-stabilizes into the turn

    // --- slope foot placement: pitch/roll the legs against the ground ---
    const n = s.slopeNormal;
    if (n && (Math.abs(n.x) > 0.02 || Math.abs(1 - n.y) > 0.02)) {
      // pitch: forward slope tilts the character's forward axis (z); roll: x.
      // Counter-rotate legs so the feet track the surface.
      const pitch = Math.atan2(n.z, n.y);
      const roll = Math.atan2(n.x, n.y);
      const pk = clamp(pitch * 0.55, -0.4, 0.4);
      const rk = clamp(roll * 0.55, -0.3, 0.3);
      L.legL.rotation.x += pk;
      L.legR.rotation.x += pk;
      L.legL.rotation.z += rk;
      L.legR.rotation.z -= rk;
      // knees absorb the residual so the hips don't jackknife
      const j = L.joints;
      if (j) {
        j.kneeL.rotation.x -= pk * 0.6;
        j.kneeR.rotation.x -= pk * 0.6;
      }
    }

    // --- weapon-carry arm pose (idle carry, not mid-swing) ---
    if (s.weaponCarry && !s.attacking) {
      L.armR.rotation.x += -0.55; // raise the weapon arm forward
      L.armR.rotation.z += -0.15;
      const elb = L.elbowR ?? L.joints?.elbowR;
      if (elb) elb.rotation.x += -0.5; // elbow bend, weapon up
      L.armL.rotation.x += -0.25; // off-hand steadies
    }
  },
};
