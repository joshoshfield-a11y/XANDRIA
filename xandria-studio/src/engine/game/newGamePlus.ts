/**
 * UPGRADE LOOP (new-game-plus phase): New Game+ / prestige run cycles.
 *
 * Data-driven NG+ table: cycle -> enemy hp/damage/xp/loot multipliers.
 * ALL tuning lives in the single NG_PLUS_TABLE below. Cycle 0 is the base
 * game (identity: every multiplier 1.0) so default spawns are byte-identical
 * to pre-NG+ builds; cycles above the table clamp to the last row (bounded
 * growth, by design — same discipline as the enemy-scaling bands).
 *
 * Exact spawn wiring (symmetric with difficulty-modes, see EnemyAI
 * spawnOne): the derivation chain is
 *   authored spec
 *     -> band scaling (enemyScaling.ts: level band + seeded variance)
 *     -> difficulty (difficulty.ts: mode multipliers, normal = identity)
 *     -> NG+ (this module: cycle multipliers, cycle 0 = identity)
 * Each stage operates on a scaled COPY; the authored spec object is never
 * mutated. Kill XP is the product band xpMult * difficulty enemyXpMult *
 * NG+ xpMult (threaded through the existing Enemy.xpMult path). Loot chance
 * is the product difficulty lootChanceMult * NG+ lootChanceMult, applied
 * only to rollLoot's "nothing" slot — loot ladder tiers, item ids and
 * per-entry weights are untouched, exactly like the difficulty wiring.
 * NG+ has NO player-damage-taken term (the table carries hp/damage/xp/loot
 * only); the enemy damage stat is band dmg * difficulty dmg (incl. the
 * difficulty player-taken fold) * NG+ dmgMult.
 *
 * Determinism: the cycle is a discrete integer input and NG+ draws NO
 * RNG — same (mapSeed, playerLevel, difficulty, cycle, roster specs) ->
 * identical encounters. The cycle lives in the profile (ProfileData
 * .ngPlusCycle) so it survives reloads, and (once the unmerged save-slots
 * branch lands) rides with the slot's profile via migrateProfile.
 * Entering NG+ touches ONLY that one profile field: gear (loadout/owned),
 * merit, achievements, difficulty, bestiary, daily results and journal
 * data are never written by the NG+ path.
 */

/** A single NG+ cycle's tuning row. */
export interface NgPlusDef {
  /** 0 = base game (identity row); 1 = NG+1, 2 = NG+2, ... */
  cycle: number;
  label: string;
  /** multiplies enemy maxHealth at spawn */
  enemyHpMult: number;
  /** multiplies the enemy damage stat at spawn */
  enemyDmgMult: number;
  /** multiplies kill XP (threaded through the existing Enemy.xpMult path) */
  enemyXpMult: number;
  /**
   * scales the drop chance in rollLoot by narrowing/widening the "nothing"
   * slot of the drop table. Loot ladder tiers, item ids and per-entry
   * weights are untouched — only the drop-vs-nothing probability moves.
   * Composed multiplicatively with the difficulty lootChanceMult.
   */
  lootChanceMult: number;
}

/** The whole NG+ ladder. Cycle 0 is the identity row; cycles above the last row clamp to it. */
export const NG_PLUS_TABLE: readonly NgPlusDef[] = [
  { cycle: 0, label: 'Base Game', enemyHpMult: 1.0, enemyDmgMult: 1.0, enemyXpMult: 1.0, lootChanceMult: 1.0 },
  { cycle: 1, label: 'NG+ 1', enemyHpMult: 1.25, enemyDmgMult: 1.15, enemyXpMult: 1.25, lootChanceMult: 1.15 },
  { cycle: 2, label: 'NG+ 2', enemyHpMult: 1.55, enemyDmgMult: 1.3, enemyXpMult: 1.5, lootChanceMult: 1.3 },
  { cycle: 3, label: 'NG+ 3', enemyHpMult: 1.9, enemyDmgMult: 1.5, enemyXpMult: 1.8, lootChanceMult: 1.45 },
  { cycle: 4, label: 'NG+ 4', enemyHpMult: 2.3, enemyDmgMult: 1.7, enemyXpMult: 2.1, lootChanceMult: 1.6 },
  { cycle: 5, label: 'NG+ 5', enemyHpMult: 2.75, enemyDmgMult: 1.95, enemyXpMult: 2.45, lootChanceMult: 1.75 },
  { cycle: 6, label: 'NG+ 6', enemyHpMult: 3.25, enemyDmgMult: 2.2, enemyXpMult: 2.8, lootChanceMult: 1.9 },
  { cycle: 7, label: 'NG+ 7', enemyHpMult: 3.8, enemyDmgMult: 2.5, enemyXpMult: 3.2, lootChanceMult: 2.05 },
  { cycle: 8, label: 'NG+ 8', enemyHpMult: 4.4, enemyDmgMult: 2.8, enemyXpMult: 3.6, lootChanceMult: 2.2 },
];

/** Highest defined cycle; higher cycles clamp to this row. */
export const MAX_NG_PLUS_CYCLE = NG_PLUS_TABLE[NG_PLUS_TABLE.length - 1].cycle;

/**
 * Look up a cycle's def; non-integer / negative / NaN inputs fall back to
 * cycle 0 (never throw); cycles above the table clamp to the last row.
 */
export function ngPlusByCycle(cycle: unknown): NgPlusDef {
  const c = typeof cycle === 'number' && isFinite(cycle) ? Math.floor(cycle) : 0;
  if (c <= 0) return NG_PLUS_TABLE[0];
  if (c >= MAX_NG_PLUS_CYCLE) return NG_PLUS_TABLE[NG_PLUS_TABLE.length - 1];
  return NG_PLUS_TABLE[c];
}

export interface NgPlusScaledStats {
  /** enemy maxHealth after the NG+ multiplier */
  health: number;
  /** enemy damage after the NG+ multiplier */
  damage: number;
  /** kill XP multiplier after the NG+ multiplier */
  xpMult: number;
  /** loot drop-chance multiplier after the NG+ multiplier */
  lootChanceMult: number;
}

/**
 * Apply an NG+ def to one enemy's already-band-and-difficulty-scaled
 * stats. Pure + deterministic: same (health, damage, xpMult,
 * lootChanceMult, def) -> same result. lootChanceMult here is the
 * already-difficulty-scaled chance (normal difficulty = 1.0), so the
 * composed value is difficulty * NG+ — the two systems stay orthogonal.
 */
export function applyNgPlusScaling(
  health: number,
  damage: number,
  xpMult: number,
  lootChanceMult: number,
  def: NgPlusDef,
): NgPlusScaledStats {
  return {
    health: health * def.enemyHpMult,
    damage: damage * def.enemyDmgMult,
    xpMult: xpMult * def.enemyXpMult,
    lootChanceMult: lootChanceMult * def.lootChanceMult,
  };
}
