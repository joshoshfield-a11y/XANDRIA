/**
 * Water interaction (physics wave, item 2): splash enter/exit detection, wading
 * drag for characters, and simplified buoyancy for rigid bodies (item drops).
 *
 * No fluid sim: a horizontal water level + per-body submerged fraction drives
 * everything. Deterministic: bob phase comes from the caller's seeded rng
 * (ItemWorld.item.phase); no Math.random / Date.now anywhere here.
 */
import type * as CANNON from 'cannon-es';

export interface WadingState {
  /** 0..1 fraction of the character capsule below the water surface */
  submerged: number;
  /** true when the feet are in water but the head is above it */
  wading: boolean;
}

/**
 * Submerged fraction of a vertical capsule at center height `centerY` with
 * half-height `halfH`, against water level `wl`. 0 = dry, 1 = fully under.
 */
export function submergedFraction(centerY: number, halfH: number, wl: number): number {
  const d = (wl - (centerY - halfH)) / (2 * halfH);
  return d <= 0 ? 0 : d >= 1 ? 1 : d;
}

/** Build a WadingState for a character capsule. */
export function wadingState(centerY: number, halfH: number, wl: number | null): WadingState {
  if (wl === null) return { submerged: 0, wading: false };
  const s = submergedFraction(centerY, halfH, wl);
  return { submerged: s, wading: s > 0.04 && s < 0.95 };
}

/**
 * Enter/exit edge detector. Feed it each fixed step with the current
 * submerged fraction; it returns 'enter' / 'exit' on transitions, else null.
 * The caller emits splash particles + audio. Allocation-free.
 */
export class SplashDetector {
  private wasIn = false;
  update(submerged: number): 'enter' | 'exit' | null {
    const inNow = submerged > 0.02;
    if (inNow && !this.wasIn) { this.wasIn = true; return 'enter'; }
    if (!inNow && this.wasIn) { this.wasIn = false; return 'exit'; }
    return null;
  }
  reset() { this.wasIn = false; }
}

/**
 * Simplified buoyancy for a rigid body: spring the body toward floating on
 * the surface, damped, with a deterministic bob from `bobPhase` and time `t`.
 * Mutates body.velocity in place; allocation-free. Returns true when the body
 * touched water this step.
 *
 * Physics: upward accel ≈ gravity cancelled at full submersion (neutral
 * buoyancy) + a restoring spring toward `wl + restOffset`, so bodies bob at
 * the surface instead of sinking. Horizontal velocity is water-dragged.
 */
export function applyBuoyancy(
  body: CANNON.Body,
  waterLevel: number,
  radius: number,
  dt: number,
  gravityY: number,
  bobPhase: number,
  t: number,
): boolean {
  const y = body.position.y;
  if (y > waterLevel + radius) return false; // fully above water
  const frac = Math.min(1, Math.max(0, (waterLevel - y + radius) / (2 * radius)));
  if (frac <= 0) return false;
  const g = Math.abs(gravityY);
  // cancel gravity at full submersion; spring toward a floating rest height
  // (bob offset is deterministic: phase from the seeded item rng + global t)
  const bob = Math.sin(t * 2.1 + bobPhase) * 0.06;
  const restY = waterLevel + radius * 0.35 + bob;
  const spring = (restY - y) * 9;
  const v = body.velocity;
  v.y += (g * frac + spring) * dt;
  v.y *= Math.max(0, 1 - 2.6 * frac * dt); // vertical water damping
  const hd = Math.max(0, 1 - 1.8 * frac * dt); // horizontal drag
  v.x *= hd;
  v.z *= hd;
  body.angularVelocity.scale(Math.max(0, 1 - 2.0 * frac * dt), body.angularVelocity);
  body.wakeUp();
  return true;
}
