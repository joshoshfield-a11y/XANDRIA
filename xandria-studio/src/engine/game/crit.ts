/**
 * CRIT-SYSTEM (upgrade loop): a real seeded critical-hit mechanic.
 *
 * Replaces the damage-numbers wave's display-only crit highlight: crit
 * styling on a damage number now means a real crit happened — the damage
 * value was multiplied per this table. (The old rule — top-decile seeded
 * variance rendering with crit styling and an unchanged value — is gone;
 * see combatAbilities.ts history and the crit-system REPORT.md.)
 *
 * One tuning table (CRIT_TABLE) — no other file carries crit numbers:
 *   - base crit chance 5%, base crit damage multiplier x2.0.
 *   - per weapon-tier bonuses: higher rarity weapons crit more often and
 *     harder (tier = equipped weapon's ItemRarity; no weapon -> common).
 *   - per skill-rank bonuses: the smithing rank (the weapon-craft skill)
 *     adds chance + multiplier at ranks 2-3; rank 0/1 add nothing.
 *
 * Determinism: crit rolls NEVER draw from engine.rng / Math.random /
 * Date.now. Every roll consumes one draw from a caller-owned seeded Rng
 * stream (ability manager's stream, the avatar's melee stream, or a
 * blueprint's projectile stream). Same seed + same event sequence ->
 * identical crit outcomes. Non-crit damage is bit-identical to the
 * pre-crit formula in every path: crit multiplies a value that was
 * already computed, it never re-rolls it.
 */
import { Rng } from '../core/Rng';
import type { ItemRarity } from '@spec';

/** Salts for the dedicated crit streams — off the loot/enemy/ability streams. */
export const CRIT_MELEE_SALT = 0xc217;
export const CRIT_PROJECTILE_SALT = 0x9c17;

/** What a crit roll needs: equipped weapon tier + smithing rank. */
export interface CritCtx {
  /** equipped weapon rarity; null = no weapon equipped (common bonuses). */
  tier: ItemRarity | null;
  /** smithing skill rank (0 = unknown/unranked, 1..3 otherwise). */
  skillRank: number;
  /**
   * SKILL-SYNERGIES: additive crit-chance bonus from active skill
   * synergies, applied AFTER the table's tier + smithing-rank bonuses.
   * Omitted = 0 (every pre-synergy caller). Never changes the roll's
   * seeded draw — only the threshold the draw is compared against.
   */
  synergyChanceBonus?: number;
  /** SKILL-SYNERGIES: additive crit-multiplier bonus, same order. Omitted = 0. */
  synergyMultiplierBonus?: number;
}

/** The default context: no weapon, no skill rank — base table only. */
export const BASE_CRIT_CTX: CritCtx = { tier: null, skillRank: 0 };

/**
 * Build a CritCtx carrying skill-synergy bonuses (blueprint damage
 * paths that construct the context inline — projectiles, melee).
 * Keeps the bonus plumbing in one place; bonuses are the
 * SkillSystem.synergyCritBonuses() sums, applied after tier + rank.
 */
export function synergyCritCtx(
  tier: ItemRarity | null,
  skillRank: number,
  bonuses: { chanceBonus: number; multiplierBonus: number },
): CritCtx {
  return {
    tier,
    skillRank,
    synergyChanceBonus: bonuses.chanceBonus,
    synergyMultiplierBonus: bonuses.multiplierBonus,
  };
}

/** One tuning table — every crit number lives here and nowhere else. */
export const CRIT_TABLE = {
  /** base crit chance (0..1) before tier/rank bonuses. */
  baseChance: 0.05,
  /** base crit damage multiplier before tier/rank bonuses. */
  baseMultiplier: 2.0,
  /** additive crit-chance bonus per weapon tier. */
  tierChanceBonus: {
    common: 0,
    uncommon: 0.02,
    rare: 0.04,
    epic: 0.06,
    legendary: 0.1,
  } as Record<ItemRarity, number>,
  /** additive crit-damage-multiplier bonus per weapon tier. */
  tierMultiplierBonus: {
    common: 0,
    uncommon: 0.1,
    rare: 0.2,
    epic: 0.3,
    legendary: 0.5,
  } as Record<ItemRarity, number>,
  /** additive crit-chance bonus per smithing rank, indexed by rank (0..3). */
  skillRankChanceBonus: [0, 0, 0.02, 0.04],
  /** additive crit-damage-multiplier bonus per smithing rank, indexed by rank (0..3). */
  skillRankMultiplierBonus: [0, 0, 0.1, 0.2],
} as const;

function clampRank(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  return Math.max(0, Math.min(3, Math.floor(rank)));
}

/** Synergy bonuses are additive and never negative; garbage sanitizes to 0. */
function clampSynergyBonus(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Round to the table's authored precision — the bonus decimals are
 * exact at 2 places, so float dust (0.05 + 0.1 = 0.15000000000000002)
 * must never leak into a chance boundary or a displayed multiplier. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Effective crit chance (0..1) for a tier + smithing rank + synergy bonus. */
export function critChanceFor(
  tier: ItemRarity | null,
  skillRank: number,
  synergyChanceBonus = 0,
): number {
  const t = tier ?? 'common';
  const r = clampRank(skillRank);
  return Math.min(
    1,
    Math.max(
      0,
      round4(
        CRIT_TABLE.baseChance +
          (CRIT_TABLE.tierChanceBonus[t] ?? 0) +
          (CRIT_TABLE.skillRankChanceBonus[r] ?? 0) +
          clampSynergyBonus(synergyChanceBonus),
      ),
    ),
  );
}

/** Effective crit damage multiplier for a tier + smithing rank + synergy bonus. */
export function critMultiplierFor(
  tier: ItemRarity | null,
  skillRank: number,
  synergyMultiplierBonus = 0,
): number {
  const t = tier ?? 'common';
  const r = clampRank(skillRank);
  return round4(
    CRIT_TABLE.baseMultiplier +
      (CRIT_TABLE.tierMultiplierBonus[t] ?? 0) +
      (CRIT_TABLE.skillRankMultiplierBonus[r] ?? 0) +
      clampSynergyBonus(synergyMultiplierBonus),
  );
}

/** The crit-stats shape the inventory panel renders. */
export type CritStats = {
  chance: number;
  multiplier: number;
  tier: ItemRarity;
  skillRank: number;
};

/** Full crit stats for a context — the shape the inventory panel renders. */
export function critStatsFor(ctx: CritCtx): CritStats {
  const tier = ctx.tier ?? 'common';
  const skillRank = clampRank(ctx.skillRank);
  return {
    chance: critChanceFor(tier, skillRank, ctx.synergyChanceBonus),
    multiplier: critMultiplierFor(tier, skillRank, ctx.synergyMultiplierBonus),
    tier,
    skillRank,
  };
}

/** Pure roll: given one seeded draw u in [0, 1), is it a crit, and at what multiplier? */
export function rollCrit(
  u: number,
  tier: ItemRarity | null,
  skillRank: number,
  synergy?: { chanceBonus?: number; multiplierBonus?: number },
): { crit: boolean; multiplier: number } {
  const crit = u < critChanceFor(tier, skillRank, synergy?.chanceBonus);
  return {
    crit,
    multiplier: crit
      ? critMultiplierFor(tier, skillRank, synergy?.multiplierBonus)
      : 1,
  };
}

/**
 * Apply a roll to an already-computed damage value. Non-crit returns the
 * input bit-identical; crit rounds (base * multiplier) once. Callers pass
 * the pre-crit value, never a re-rolled one.
 */
export function applyCrit(baseDamage: number, roll: { crit: boolean; multiplier: number }): number {
  return roll.crit ? Math.round(baseDamage * roll.multiplier) : baseDamage;
}

/** Seeded crit roller: one Rng stream, one draw per roll. */
export class CritRoller {
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed >>> 0);
  }

  /** Roll a crit for a context; consumes exactly one seeded draw. */
  roll(ctx: CritCtx): { crit: boolean; multiplier: number } {
    return rollCrit(this.rng.next(), ctx.tier, ctx.skillRank, {
      chanceBonus: ctx.synergyChanceBonus,
      multiplierBonus: ctx.synergyMultiplierBonus,
    });
  }
}
