/**
 * Enemies wave (workstream C): Studio-authored enemy count resolution.
 *
 * Reads `spec.custom.enemies` (see EnemyTuningCustom in spec/schema.ts —
 * the World-tab density control writes it) and the resolved perf tier, and
 * returns the density multiplier EnemyManager applies to every spec count
 * on the portal-arrival path:
 *
 *   perSpecCount = round((spec.count ?? 1) * density)
 *   density = clampedDensity * (tier === 'desktop' ? 1 : lowTierScale)
 *
 * The Studio density slider (0..1, default 1) scales the authored roster;
 * on reduced-fidelity tiers (s25) the lowTierScale multiplier (default
 * 0.5) halves it, keeping enemy draw cost proportional to the tier's other
 * tuned-down budgets. Density never affects the seed or the per-enemy
 * streams: spawnForMap consumes the map-seeded Rng in spawn order, so
 * count N is always the first N of the full roster.
 *
 * Unlike the NPC density control (slider writes the spec; no production
 * spawn path reads it yet), this one IS wired: every blueprint passes
 * `density: resolveEnemyDensity(spec, engine.tiers.tier)` into
 * EnemyManagerOpts. NPC density is untouched.
 */
import type { GameSpec } from '@spec';
import type { PerfTier } from '../core/PerformanceManager';

export const DEFAULT_ENEMY_DENSITY = 1;
export const DEFAULT_ENEMY_LOW_TIER_SCALE = 0.5;

/**
 * Resolve the enemy density multiplier for a map. Pure function — no
 * randomness, no engine access — so it's unit-testable and safe to call
 * from spawn paths.
 */
export function resolveEnemyDensity(
  spec: GameSpec,
  tier: PerfTier,
): number {
  const t = spec.custom?.enemies;
  const density = t?.density ?? DEFAULT_ENEMY_DENSITY;
  const lowTierScale = t?.lowTierScale ?? DEFAULT_ENEMY_LOW_TIER_SCALE;
  const clampedDensity = Math.min(1, Math.max(0, density));
  const clampedScale = Math.min(1, Math.max(0, lowTierScale));
  return tier === 'desktop' ? clampedDensity : clampedDensity * clampedScale;
}
