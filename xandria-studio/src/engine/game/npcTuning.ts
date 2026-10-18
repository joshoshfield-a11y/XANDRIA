/**
 * NPCs wave (workstream C): Studio-authored NPC count resolution.
 *
 * Reads `spec.custom.npcs` (see NpcTuningCustom in spec/schema.ts — the
 * World-tab density control writes it) and the resolved perf tier, and
 * returns the roster count a manager should spawn for this map.
 *
 *   count = round(baseCount * density * (tier === 'desktop' ? 1 : lowTierScale))
 *
 * The Studio density slider (0..1, default 1) scales the default 8-NPC
 * roster; on reduced-fidelity tiers (s25) the lowTierScale multiplier
 * (default 0.5) halves it, keeping NPC draw cost proportional to the
 * tier's other tuned-down budgets. Density never affects the seed or the
 * per-NPC streams: spawnNpcsForMap consumes the map-seeded Rng in spawn
 * order, so count N is always the first N of the full roster.
 */
import type { GameSpec } from '@spec';
import type { PerfTier } from '../core/PerformanceManager';

export const DEFAULT_NPC_DENSITY = 1;
export const DEFAULT_NPC_LOW_TIER_SCALE = 0.5;
export const DEFAULT_NPC_ROSTER = 8;

/**
 * Resolve the NPC roster count for a map. Pure function — no randomness,
 * no engine access — so it's unit-testable and safe to call from spawn
 * paths.
 */
export function resolveNpcCount(
  spec: GameSpec,
  tier: PerfTier,
  baseCount = DEFAULT_NPC_ROSTER,
): number {
  const t = spec.custom?.npcs;
  const density = t?.density ?? DEFAULT_NPC_DENSITY;
  const lowTierScale = t?.lowTierScale ?? DEFAULT_NPC_LOW_TIER_SCALE;
  const clampedDensity = Math.min(1, Math.max(0, density));
  const clampedScale = Math.min(1, Math.max(0, lowTierScale));
  const mult = tier === 'desktop' ? clampedDensity : clampedDensity * clampedScale;
  return Math.max(0, Math.round(baseCount * mult));
}
