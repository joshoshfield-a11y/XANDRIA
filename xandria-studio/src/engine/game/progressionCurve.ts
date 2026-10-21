/**
 * PROGRESSION CURVE (upgrade-loop progression-curve phase): the data-driven
 * player leveling table. ALL player-level tuning lives in the single
 * PROGRESSION_TABLE below — XP thresholds and per-level stat growth in one
 * place, level cap 50.
 *
 * Symmetric derivation with the enemy-scaling band table (enemyScaling.ts):
 *   - player damage growth tracks ENEMY hp growth (band hpMult) → time-to-kill
 *     stays roughly constant as both sides level up;
 *   - player max-HP growth tracks ENEMY damage growth (band dmgMult) →
 *     survivability stays roughly constant;
 *   - band 0 (levels 1-5) is the identity band, so a fresh level-1 player is
 *     byte-identical to before this feature existed.
 * The table is DERIVED from ENEMY_LEVEL_BANDS via bandIndexForLevel, so the
 * two ladders can never drift apart — the "symmetric derivation" the
 * progression-curve brief requires. XP thresholds keep the pre-existing
 * 100 * level^1.5 curve (frozen into the table; identical values, now
 * data-driven instead of computed inline).
 *
 * Determinism: the table is a pure function of ENEMY_LEVEL_BANDS (static
 * data) — no RNG of any kind. Object.freeze'd; rows are readonly.
 */
import { ENEMY_LEVEL_BANDS, bandIndexForLevel } from './enemyScaling';

/** Hard level cap. addXp stops leveling here (XP still accumulates). */
export const LEVEL_CAP = 50;

/** Per-level speed bonus: flat +0.4% move speed per level above 1. */
export const SPEED_BONUS_PER_LEVEL = 0.004;

export interface ProgressionRow {
  /** 1-based level */
  level: number;
  /** XP required to go from this level to the next (row LEVEL_CAP: unused) */
  xpToNext: number;
  /** cumulative player damage multiplier vs level 1 (= enemy band hpMult) */
  dmgMult: number;
  /** cumulative player max-HP multiplier vs level 1 (= enemy band dmgMult) */
  hpMult: number;
  /** cumulative move-speed multiplier vs level 1 (1 + 0.004*(level-1)) */
  speedMult: number;
}

function buildTable(): readonly ProgressionRow[] {
  const rows: ProgressionRow[] = [];
  for (let level = 1; level <= LEVEL_CAP; level++) {
    const band = ENEMY_LEVEL_BANDS[bandIndexForLevel(level)];
    rows.push({
      level,
      xpToNext: Math.round(100 * Math.pow(level, 1.5)),
      dmgMult: band.hpMult,
      hpMult: band.dmgMult,
      speedMult: 1 + SPEED_BONUS_PER_LEVEL * (level - 1),
    });
  }
  return Object.freeze(rows);
}

/** The whole leveling ladder. Read rows, never mutate them. */
export const PROGRESSION_TABLE: readonly ProgressionRow[] = buildTable();

/**
 * Table row for a level, clamped to [1, LEVEL_CAP]. Defensive: NaN /
 * infinities clamp to level 1 rather than throwing mid-run.
 */
export function levelRow(level: number): ProgressionRow {
  const l = Number.isFinite(level) ? Math.max(1, Math.min(LEVEL_CAP, Math.floor(level))) : 1;
  return PROGRESSION_TABLE[l - 1];
}

/** XP required to advance from `level` to `level + 1`. */
export function xpForNextLevel(level: number): number {
  return levelRow(level).xpToNext;
}

/**
 * A level-up event's from→to span, for incremental stat-growth application.
 * Multiple levels from one XP grant arrive as a single {from, to} span.
 */
export interface LevelGain {
  from: number;
  to: number;
}
