/**
 * Lighting life (polish wave, LOOK crew).
 *
 * - Noise-modulated flicker for registered point lights (torches, neon, the
 *   platformer hazard glow, boss auras) — cheap 2-sine value noise, phase
 *   derived deterministically from registration order (no Math.random, so
 *   seeded runs stay reproducible).
 * - Gentle pulse for emissive materials (neon pylons, chevrons, crystals,
 *   wisps, lava). Registration targets the MaterialLibrary's shared cached
 *   materials, so one uniform update pulses every prop that shares the
 *   material — O(materials), not O(props).
 * - Pooled dynamic lights (plan item #8): 3 round-robin PointLights with
 *   tight distance falloff for muzzle flashes / pickups / explosions.
 *   Callers: engine.sky.lightLife.flash(color, pos, intensity?, distance?, duration?).
 *
 * Per-frame cost is O(registered entries) — a handful of lights and shared
 * materials, no hot loops. Disabled entirely at retro quality: retro keeps
 * its own look, and registration becomes a no-op.
 */
import * as THREE from 'three';

interface Flicker {
  light: THREE.PointLight;
  base: number;
  amp: number;
  speed: number;
  phase: number;
}

interface Pulse {
  mat: THREE.MeshStandardMaterial;
  base: number;
  amp: number;
  speed: number;
  phase: number;
}

interface PoolSlot {
  light: THREE.PointLight;
  life: number;
  span: number;
  peak: number;
}

/** Flicker/pulse noise: two detuned sines, roughly in [-1, 1]. */
function wobble(t: number, speed: number, phase: number): number {
  return (
    0.62 * Math.sin(t * speed + phase) +
    0.38 * Math.sin(t * speed * 2.63 + phase * 1.7)
  );
}

export class LightLife {
  private readonly live: boolean;
  private t = 0;
  private readonly flickers: Flicker[] = [];
  private readonly pulses: Pulse[] = [];
  private readonly pool: PoolSlot[] = [];
  private poolIdx = 0;

  constructor(scene: THREE.Scene, quality: 'retro' | 'standard' | 'high') {
    this.live = quality !== 'retro';
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight('#ffffff', 0, 16, 2);
      l.visible = false;
      scene.add(l);
      this.pool.push({ light: l, life: 0, span: 1, peak: 0 });
    }
  }

  /** Number of pooled flash lights (plan #8 caps this at 3). */
  get poolSize(): number {
    return this.pool.length;
  }

  /**
   * Register a point light for noise-modulated flicker.
   * @param amp fractional intensity swing (0.25 = ±25%)
   * @param speed wobble speed in rad/s
   */
  flicker(light: THREE.PointLight, amp = 0.25, speed = 3): void {
    if (!this.live) return;
    this.flickers.push({
      light,
      base: light.intensity,
      amp,
      speed,
      phase: this.flickers.length * 2.39996, // golden-angle spread, deterministic
    });
  }

  /**
   * Register an emissive material for a gentle intensity pulse. The base is
   * read from the material's current emissiveIntensity at registration.
   */
  pulse(mat: THREE.MeshStandardMaterial, amp = 0.15, speed = 2): void {
    if (!this.live) return;
    this.pulses.push({
      mat,
      base: mat.emissiveIntensity,
      amp,
      speed,
      phase: this.pulses.length * 2.39996,
    });
  }

  /**
   * Fire a pooled flash light (muzzle flashes, pickups, explosions).
   * Round-robin over the 3-slot pool; intensity decays quadratically to 0,
   * then the light is hidden. Additive use only — keep it small.
   */
  flash(
    color: THREE.ColorRepresentation,
    pos: THREE.Vector3,
    intensity = 10,
    distance = 16,
    duration = 0.14,
  ): void {
    if (!this.live) return;
    const s = this.pool[this.poolIdx];
    this.poolIdx = (this.poolIdx + 1) % this.pool.length;
    s.light.color.set(color);
    s.light.position.copy(pos);
    s.light.distance = distance;
    s.peak = intensity;
    s.span = Math.max(duration, 0.01);
    s.life = s.span;
    s.light.intensity = intensity;
    s.light.visible = true;
  }

  update(dt: number): void {
    if (!this.live) return;
    this.t += dt;
    const t = this.t;
    for (const f of this.flickers) {
      f.light.intensity = f.base * (1 + f.amp * wobble(t, f.speed, f.phase));
    }
    for (const p of this.pulses) {
      p.mat.emissiveIntensity = Math.max(0, p.base * (1 + p.amp * wobble(t, p.speed, p.phase)));
    }
    for (const s of this.pool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.light.intensity = 0;
        s.light.visible = false;
        continue;
      }
      const k = s.life / s.span;
      s.light.intensity = s.peak * k * k;
    }
  }
}
