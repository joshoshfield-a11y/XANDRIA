/**
 * UPGRADE LOOP (enemy-scaling phase): world difficulty scaling.
 *
 * Enemies scale with the player's power, not just the map seed. ALL tuning
 * lives in the single data-driven ENEMY_LEVEL_BANDS table below — bands of
 * 5 levels, each carrying hp/damage/xp multipliers plus a seeded per-enemy
 * variance fraction.
 *
 * Spawn-level derivation: the band for a spawn comes from
 *   effectiveLevel = max(playerLevel, 1 + mapDist)
 * where playerLevel is the live Progression level and mapDist is the
 * Manhattan distance of the current map from the world origin
 * (|mx| + |my| from spec.custom.portalMap, 0 on single-map games), so
 * travelling deeper into the portal graph toughens encounters even when
 * the player hasn't leveled.
 *
 * Determinism: given the same (mapSeed, playerLevel, mapDist, tier,
 * roster specs) every enemy's band AND variance draws are identical.
 * Variance is drawn
 * from `new Rng((enemySeed ^ SCALING_SALT) >>> 0)`, where enemySeed is the
 * per-enemy spawn seed already derived from mapSeed — a pure function of
 * the inputs. engine.rng, Math.random and Date.now are never touched.
 *
 * Band 0 (levels 1-5) is the identity band: all multipliers 1.0, variance 0 —
 * so blueprint initial builds (fresh player, origin map) are byte-identical
 * to before this feature existed.
 *
 * WORLD-TIERS (upgrade loop): applyEnemyScaling takes an optional world
 * tier (default 1 = identity). The tier flows from Engine.worldTier, itself
 * a pure function of (mapSeed, map depth).
 */
import { Rng } from '../core/Rng';
import type { EnemySpec } from '@spec';

/** Salt mixed into the per-enemy spawn seed for the scaling variance stream. */
export const SCALING_SALT = 0x5ca1e9;

/** Levels per band. */
export const SCALING_BAND_WIDTH = 5;

export interface ScalingBand {
  /** 1-based first level of this band */
  minLevel: number;
  /** 1-based last level of this band */
  maxLevel: number;
  /** multiplier applied to spec.health */
  hpMult: number;
  /** multiplier applied to spec.damage */
  dmgMult: number;
  /** multiplier applied to the XP a kill grants */
  xpMult: number;
  /** per-enemy seeded jitter: stat *= 1 + range(-variance, +variance) */
  variance: number;
}

/**
 * The whole difficulty ladder. Design intent: hp grows fastest (fights get
 * longer), damage grows slower (fights stay fair), XP grows slowest of the
 * three (grinding stays bounded). Above the last band, levels clamp to it —
 * growth is bounded by design, not by accident.
 */
export const ENEMY_LEVEL_BANDS: readonly ScalingBand[] = [
  { minLevel: 1, maxLevel: 5, hpMult: 1.0, dmgMult: 1.0, xpMult: 1.0, variance: 0.0 },
  { minLevel: 6, maxLevel: 10, hpMult: 1.25, dmgMult: 1.15, xpMult: 1.1, variance: 0.05 },
  { minLevel: 11, maxLevel: 15, hpMult: 1.55, dmgMult: 1.35, xpMult: 1.25, variance: 0.06 },
  { minLevel: 16, maxLevel: 20, hpMult: 1.95, dmgMult: 1.55, xpMult: 1.4, variance: 0.07 },
  { minLevel: 21, maxLevel: 25, hpMult: 2.45, dmgMult: 1.8, xpMult: 1.6, variance: 0.08 },
  { minLevel: 26, maxLevel: 30, hpMult: 3.05, dmgMult: 2.05, xpMult: 1.8, variance: 0.08 },
  { minLevel: 31, maxLevel: 35, hpMult: 3.75, dmgMult: 2.35, xpMult: 2.05, variance: 0.09 },
  { minLevel: 36, maxLevel: 40, hpMult: 4.6, dmgMult: 2.65, xpMult: 2.3, variance: 0.09 },
  { minLevel: 41, maxLevel: 45, hpMult: 5.6, dmgMult: 3.0, xpMult: 2.6, variance: 0.1 },
  { minLevel: 46, maxLevel: 50, hpMult: 6.8, dmgMult: 3.4, xpMult: 2.9, variance: 0.1 },
];

/**
 * Manhattan distance of a map from the world origin, read off the stamped
 * spec.custom.portalMap ({mx, my, worldSeed}). Missing stamp (single-map
 * games, tests) = 0. Pure function of the spec.
 */
export function mapDistanceFromSpec(spec: { custom?: { portalMap?: { mx?: number; my?: number } } }): number {
  const pm = spec?.custom?.portalMap;
  const mx = Number.isFinite(pm?.mx) ? Math.abs(pm!.mx!) : 0;
  const my = Number.isFinite(pm?.my) ? Math.abs(pm!.my!) : 0;
  return mx + my;
}

/**
 * WORLD-TIERS (upgrade loop): levels contributed by the world tier.
 * Each tier above tier 1 raises the spawn-level floor by this many levels.
 * Tier 1 (origin map, single-map games) contributes 0 — the identity.
 */
export const TIER_LEVEL_STEP = 2;

/**
 * The level enemies spawn at: the player's level, or the map's depth
 * floor (1 + hops from origin), whichever is higher. A fresh player
 * wandering deep portals still meets tougher bands.
 *
 * WORLD-TIERS: the world tier adds (tier - 1) * TIER_LEVEL_STEP to the
 * floor (default tier = 1, identity). Deeper maps are tougher through two
 * reinforcing signals — the mapDist floor and the tier bump — both pure
 * functions of (seed, path), so same (mapSeed, playerLevel, map, tier) ->
 * identical encounters.
 */
export function effectiveSpawnLevel(playerLevel: number, mapDist: number, tier = 1): number {
  const pl = Number.isFinite(playerLevel) ? Math.max(1, Math.floor(playerLevel)) : 1;
  const md = Number.isFinite(mapDist) ? Math.max(0, Math.floor(mapDist)) : 0;
  const t = Number.isFinite(tier) ? Math.max(1, Math.floor(tier)) : 1;
  return Math.max(pl, 1 + md + (t - 1) * TIER_LEVEL_STEP);
}

/**
 * Band index for an effective level. Clamped to the table: levels above
 * the last band reuse the last band (bounded growth, by design).
 */
export function bandIndexForLevel(level: number): number {
  const l = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  const i = Math.floor((l - 1) / SCALING_BAND_WIDTH);
  return Math.min(Math.max(i, 0), ENEMY_LEVEL_BANDS.length - 1);
}

export interface ScaledEnemySpec {
  /** derived spec copy with scaled health/damage — the authored spec is never mutated */
  spec: EnemySpec;
  /** XP multiplier for this enemy's kill (band xpMult, no variance) */
  xpMult: number;
  /** band index this enemy spawned in */
  bandIndex: number;
}

/**
 * Apply the scaling band to one enemy's spec. Pure + deterministic: the
 * same (baseSpec fields, enemySeed, playerLevel, mapDist, tier) always
 * yields the same result. The returned spec is a shallow copy — callers
 * must pass it to the Enemy constructor instead of the shared spec object.
 */
export function applyEnemyScaling(
  base: EnemySpec,
  enemySeed: number,
  playerLevel: number,
  mapDist: number,
  tier = 1,
): ScaledEnemySpec {
  const bandIndex = bandIndexForLevel(effectiveSpawnLevel(playerLevel, mapDist, tier));
  const band = ENEMY_LEVEL_BANDS[bandIndex];
  // Seeded variance stream: per-enemy, derived from the spawn seed (itself
  // a pure function of mapSeed) mixed with SCALING_SALT. Two draws in a
  // fixed order — hp jitter, then damage jitter.
  const vrng = new Rng(((enemySeed ^ SCALING_SALT) >>> 0));
  const hpJ = band.variance === 0 ? 1 : 1 + vrng.range(-band.variance, band.variance);
  const dmgJ = band.variance === 0 ? 1 : 1 + vrng.range(-band.variance, band.variance);
  return {
    spec: {
      ...base,
      health: base.health * band.hpMult * hpJ,
      damage: base.damage * band.dmgMult * dmgJ,
    },
    xpMult: band.xpMult,
    bandIndex,
  };
}
