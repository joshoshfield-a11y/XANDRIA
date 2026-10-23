/**
 * UPGRADE LOOP (world-tiers phase): engine-level world tier system.
 *
 * A "world tier" is a per-map difficulty/reward tier, 1..MAX_WORLD_TIER,
 * derived from how deep the map sits in the portal graph. Tiers feed two
 * consumers:
 *  - enemyScaling.ts: the tier raises the spawn-level floor (additive wiring
 *    into effectiveSpawnLevel; tier 1 is the identity, so single-map games
 *    and the origin map behave byte-identically to before this phase).
 *  - loot.ts: the tier shifts loot gear rarity weighting (tier 1 = the
 *    authored tables, byte-identical).
 *
 * DETERMINISM: deriveWorldTier is a pure function of (mapSeed, depth).
 * The seeded jitter comes from `new Rng((mapSeed ^ TIER_SALT) >>> 0)` —
 * never engine.rng / Math.random / Date.now. Same (seed, path) ->
 * identical tier, so portal round-trips preserve the tier for free.
 *
 * Design: tiers unlock every 2 hops of Manhattan depth (|mx| + |my|), with
 * a seeded 30% promotion of +1 tier per map (depth >= 1) for variety. The
 * origin map (depth 0) is ALWAYS tier 1 — a fresh player boots into the
 * identity world. Growth is bounded by MAX_WORLD_TIER by design.
 */
import { Rng } from '../core/Rng';

/**
 * Salt for the tier jitter stream off mapSeed. Distinct from ENEMY_SALT,
 * NPC_SALT, CRAFT_SALT, STATION_SALT, GATHER_SALT, LOOT_SALT, SCALING_SALT
 * (pinned by tests/world-tiers.test.ts).
 */
export const TIER_SALT = 0x7157;

/** Highest world tier. Tiers are 1-based: 1..MAX_WORLD_TIER. */
export const MAX_WORLD_TIER = 5;

/** Promotion chance applied to the depth-derived base tier (depth >= 1). */
export const TIER_PROMOTE_CHANCE = 0.3;

/**
 * World tier for a map. Pure in (mapSeed, depth):
 *   base = 1 + floor(depth / 2)          (a tier every 2 hops)
 *   tier = base + (rng.next() < 0.3 ? 1 : 0)   (seeded promotion, depth >= 1)
 *   clamped to [1, MAX_WORLD_TIER]
 * The origin map (depth 0) is always tier 1.
 */
export function deriveWorldTier(mapSeed: number, depth: number): number {
  const d = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  if (d === 0) return 1;
  const base = 1 + Math.floor(d / 2);
  const rng = new Rng(((mapSeed ^ TIER_SALT) >>> 0));
  const promoted = rng.next() < TIER_PROMOTE_CHANCE ? 1 : 0;
  return Math.min(MAX_WORLD_TIER, base + promoted);
}

/**
 * Manhattan depth of a map from the world origin, read off the stamped
 * spec.custom.portalMap ({mx, my}). Missing stamp (single-map games,
 * tests) = 0. Pure function of the spec.
 */
export function tierDepthFromSpec(spec: { custom?: { portalMap?: { mx?: number; my?: number } } }): number {
  const pm = spec?.custom?.portalMap;
  const mx = Number.isFinite(pm?.mx) ? Math.abs(pm!.mx!) : 0;
  const my = Number.isFinite(pm?.my) ? Math.abs(pm!.my!) : 0;
  return mx + my;
}

/** Clamp an arbitrary value to a valid tier (defensive; spawn paths use this). */
export function clampTier(tier: number): number {
  const t = Number.isFinite(tier) ? Math.floor(tier) : 1;
  return Math.min(MAX_WORLD_TIER, Math.max(1, t));
}
