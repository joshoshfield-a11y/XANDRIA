/**
 * Surfaces — data-driven ground-surface properties (physics wave, item 1).
 *
 * A surface id maps to movement multipliers + a footstep FX tag. The terrain /
 * biome layer reports a surface id per position (see Terrain.surfaceAt); the
 * CharacterController reads it and multiplies its existing accel/stop terms —
 * no controller branches. New biomes add rows to SURFACES, not code paths.
 *
 * Determinism: pure data + pure lookups. No rng, no Math.random.
 */

export interface SurfaceProps {
  /** multiplies ground acceleration toward the target velocity */
  accelMul: number;
  /** how strongly velocity tracks intent (1 = glued, 0 = no grip) */
  traction: number;
  /** multiplies the stop damping when no input is held */
  stopMul: number;
  /** footstep effect tag the blueprint / juice layer can switch on */
  footstepFX: 'dust' | 'crunch' | 'splash' | 'none';
  label: string;
}

export const SURFACES: Record<string, SurfaceProps> = {
  stone:   { accelMul: 1.0,  traction: 1.0,  stopMul: 1.0,  footstepFX: 'dust',   label: 'Stone' },
  rock:    { accelMul: 0.95, traction: 0.95, stopMul: 0.9,  footstepFX: 'dust',   label: 'Rock' },
  grass:   { accelMul: 0.95, traction: 0.95, stopMul: 0.9,  footstepFX: 'dust',   label: 'Grass' },
  gravel:  { accelMul: 0.9,  traction: 0.9,  stopMul: 0.8,  footstepFX: 'crunch', label: 'Gravel' },
  sand:    { accelMul: 0.8,  traction: 0.85, stopMul: 0.7,  footstepFX: 'dust',   label: 'Sand' },
  mud:     { accelMul: 0.6,  traction: 0.7,  stopMul: 0.5,  footstepFX: 'splash', label: 'Mud' },
  snow:    { accelMul: 0.75, traction: 0.6,  stopMul: 0.55, footstepFX: 'crunch', label: 'Snow' },
  ice:     { accelMul: 0.55, traction: 0.25, stopMul: 0.22, footstepFX: 'none',   label: 'Ice' },
  shallow: { accelMul: 0.7,  traction: 0.75, stopMul: 0.6,  footstepFX: 'splash', label: 'Shallow water' },
};

/** The neutral surface: unknown ids fall back here so behavior never breaks. */
export const DEFAULT_SURFACE_ID = 'stone';

export function surfaceProps(id: string | undefined | null): SurfaceProps {
  if (id && SURFACES[id]) return SURFACES[id];
  return SURFACES[DEFAULT_SURFACE_ID];
}

/**
 * Provider contract for the terrain/biome side. Terrain implements this
 * (additive methods on Terrain: surfaceAt / waterLevelAt); anything that can
 * answer "what surface is at (x, z)?" can stand in (tests, custom worlds).
 */
export interface SurfaceProvider {
  surfaceAt(x: number, z: number): string;
  /** water surface Y at (x, z), or null when there is no water there */
  waterLevelAt(x: number, z: number): number | null;
}
