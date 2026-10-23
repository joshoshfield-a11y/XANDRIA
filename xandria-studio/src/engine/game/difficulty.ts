/**
 * UPGRADE LOOP (difficulty-modes phase): data-driven difficulty modes.
 *
 * Three player-selectable modes (story / normal / hard). ALL tuning lives in
 * the single DIFFICULTY_TABLE below — enemy hp/damage/xp multipliers, a loot
 * chance multiplier, and a player-damage-taken scale. Additive on top of the
 * enemy-scaling level-band derivation (enemyScaling.ts): band scaling applies
 * first (spawn-level bands), then the difficulty multiplier, so difficulty is
 * orthogonal to level progression. Nothing here changes NPC/enemy public
 * behavior contracts.
 *
 * Design intent: normal is the identity mode (every multiplier 1.0, loot
 * chance 1.0) so default spawns are byte-identical to pre-difficulty builds;
 * story is for narrative runs (enemies softer, the player sturdier, slightly
 * more generous drops); hard is for mastery runs (enemies tougher, the
 * player frailer, slightly leaner drops, faster XP to compensate).
 *
 * Determinism: difficulty is a discrete enum input — same
 * (mapSeed, playerLevel, difficulty, roster specs) -> identical encounters.
 * No RNG, no Math.random, no Date.now anywhere in this module.
 */

/** Player-selectable difficulty modes. */
export type DifficultyId = 'story' | 'normal' | 'hard';

export interface DifficultyDef {
  id: DifficultyId;
  label: string;
  /** one-line picker description */
  blurb: string;
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
   */
  lootChanceMult: number;
  /**
   * scales damage the PLAYER takes. Folded into the enemy damage stat at
   * spawn (see applyDifficultyScaling) so every damage path (melee
   * onPlayerHit, enemy projectiles) is covered uniformly, instead of
   * patching each call site.
   */
  playerDamageTakenMult: number;
}

/** The whole difficulty ladder. See module doc for the design intent. */
export const DIFFICULTY_TABLE: readonly DifficultyDef[] = [
  {
    id: 'story',
    label: 'Story',
    blurb: 'Softer fights, sturdier player — for the narrative.',
    enemyHpMult: 0.7,
    enemyDmgMult: 0.6,
    enemyXpMult: 1.0,
    lootChanceMult: 1.3,
    playerDamageTakenMult: 0.6,
  },
  {
    id: 'normal',
    label: 'Normal',
    blurb: 'The authored experience. (Identity mode: all multipliers 1.0.)',
    enemyHpMult: 1.0,
    enemyDmgMult: 1.0,
    enemyXpMult: 1.0,
    lootChanceMult: 1.0,
    playerDamageTakenMult: 1.0,
  },
  {
    id: 'hard',
    label: 'Hard',
    blurb: 'Tougher enemies, frailer player, faster XP.',
    enemyHpMult: 1.5,
    enemyDmgMult: 1.4,
    enemyXpMult: 1.25,
    lootChanceMult: 0.85,
    playerDamageTakenMult: 1.3,
  },
];

export const DIFFICULTY_IDS: readonly DifficultyId[] = ['story', 'normal', 'hard'];

/** Look up a difficulty def; unknown ids fall back to normal (never throw). */
export function difficultyById(id: unknown): DifficultyDef {
  const found = DIFFICULTY_TABLE.find((d) => d.id === id);
  return found ?? DIFFICULTY_TABLE[1];
}

/** Narrowing guard for values coming out of storage / UI. */
export function isDifficultyId(v: unknown): v is DifficultyId {
  return v === 'story' || v === 'normal' || v === 'hard';
}

export interface DifficultyScaledStats {
  /** enemy maxHealth after the difficulty multiplier */
  health: number;
  /** enemy damage after enemyDmgMult * playerDamageTakenMult */
  damage: number;
  /** kill XP multiplier after the difficulty multiplier */
  xpMult: number;
}

/**
 * Apply a difficulty def to one enemy's already-band-scaled stats. Pure +
 * deterministic: same (health, damage, xpMult, def) -> same result.
 *
 * Note the damage folding: the final enemy damage stat is
 *   damage * enemyDmgMult * playerDamageTakenMult
 * so the assertable "damage band" in tests is the product — documented here
 * and in the report, not split across call sites.
 */
export function applyDifficultyScaling(
  health: number,
  damage: number,
  xpMult: number,
  diff: DifficultyDef,
): DifficultyScaledStats {
  return {
    health: health * diff.enemyHpMult,
    damage: damage * diff.enemyDmgMult * diff.playerDamageTakenMult,
    xpMult: xpMult * diff.enemyXpMult,
  };
}
