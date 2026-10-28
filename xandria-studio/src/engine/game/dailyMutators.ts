/**
 * UPGRADE LOOP (daily-mutators phase): data-driven daily challenge mutators.
 *
 * Mutators ride on top of the daily-challenges wave (dailyChallenges.ts)
 * without touching its pinned tuple: the challenge (seed / fixed loadout /
 * goal) is unchanged, and the mutator set for a date is a SEPARATE pure
 * derivation from the same UTC date, so every player gets the same
 * mutators on the same day:
 *
 *   mutatorSeed(date) = (DAILY_CHALLENGE_SALT ^ yyyymmdd ^ MUTATOR_SALT) >>> 0
 *   mutators(date)    = shuffle(MUTATOR_IDS, Rng(mutatorSeed))[:2]
 *
 * (challengeSeed(date) is exactly DAILY_CHALLENGE_SALT ^ yyyymmdd, so the
 * formula above is the brief's DATE_SALT ^ yyyymmdd ^ MUTATOR_SALT with
 * DATE_SALT = DAILY_CHALLENGE_SALT.) The UTC calendar date is the input,
 * sampled once at run start; no wall-clock is ever sampled mid-run, so the
 * run itself stays deterministic under the engine's seeded-RNG rule.
 *
 * ALL tuning lives in the single MUTATOR_TABLE below. Effects wire
 * ADDITIVELY into the existing scaling/difficulty derivation, in this
 * order: level bands (enemyScaling) -> difficulty (difficulty) -> NG+
 * (newGamePlus) -> elite affixes (eliteAffixes) -> mutators (here). The
 * wiring sites are all in EnemyManager.spawnOne / spawnForMap / the death
 * path (EnemyAI.ts) plus the daily scoring path (Engine.recordRunResult);
 * nothing here changes NPC/enemy public behavior contracts, the loot
 * ladder (tiers, item ids, per-entry weights), or the challenge goal.
 *
 * Effect semantics per field (every field defaults to 1 = identity):
 * - playerDamageTakenMult: multiplies the enemy damage stat at spawn, so
 *   every damage path (melee onPlayerHit, enemy projectiles) is covered
 *   uniformly — the difficulty.ts folding pattern.
 * - playerDamageDealtMult: multiplies damage the player deals. It rides
 *   the enemy's incoming-damage multiplier (Enemy.damageTakenMult) at
 *   spawn: every Enemy.damage() caller is a player weapon (projectile
 *   hits, melee, turret fire; the only exceptions are scripted
 *   9999/100000 kills whose outcome is unchanged), so folding the dealt
 *   multiplier there covers all player damage with one seam instead of
 *   patching every blueprint's shooting code. It composes multiplicatively
 *   with iron-skin's enemyDamageTakenMult on the same field.
 * - enemyDamageTakenMult: armor — the enemy takes this fraction of damage.
 * - spawnDensityMult: multiplies the spawnForMap roster density (the
 *   opts.density scale). Scripted wave/boss spawns via spawnAll are
 *   deliberately NOT scaled: those counts are authored per-encounter, and
 *   doubling a scripted boss would break encounters. Documented scope.
 * - lootChanceMult: multiplies the rollLoot chanceMult argument (the
 *   difficulty/NG+ product) — only the drop-vs-nothing probability moves.
 * - scoreMult: multiplies the finished daily attempt's recorded score
 *   (Engine.recordRunResult, daily branch only). The live engine.score,
 *   the goal tracker, and the generic run history stay raw.
 *
 * Determinism: selection and combination are pure functions of the date
 * and the table. No RNG streams are shared with anything else — the
 * mutator shuffle draws from its own Rng(mutatorSeed), so the challenge
 * generator's draws and the loot/enemy streams are untouched.
 */

import { Rng } from '../core/Rng';
import { challengeSeed } from './dailyChallenges';

/** Salt mixed into the pinned daily seed for the mutator stream. Never changes. */
export const MUTATOR_SALT = 0x6d757461;

/** How many mutators a daily challenge carries (distinct ids). */
export const DAILY_MUTATOR_COUNT = 2;

export interface MutatorDef {
  id: string;
  name: string;
  /** player-facing description of the effect */
  desc: string;
  /** multiplies the enemy damage stat at spawn (player takes this much) */
  playerDamageTakenMult: number;
  /** multiplies damage the player deals (via Enemy.damageTakenMult) */
  playerDamageDealtMult: number;
  /** fraction of damage the enemy takes (armor) */
  enemyDamageTakenMult: number;
  /** multiplies the spawnForMap roster density */
  spawnDensityMult: number;
  /** multiplies the rollLoot drop-vs-nothing chance */
  lootChanceMult: number;
  /** multiplies the finished daily attempt's recorded score */
  scoreMult: number;
}

/**
 * The whole mutator table. Design intent: every mutator makes the run
 * harder on at least one axis and pays for it with score — there is no
 * free lunch, so the multiplier is the honest price of the hardship.
 */
export const MUTATOR_TABLE: readonly MutatorDef[] = [
  {
    id: 'glass-cannon',
    name: 'Glass Cannon',
    desc: 'You take 2x damage, deal 1.5x damage',
    playerDamageTakenMult: 2,
    playerDamageDealtMult: 1.5,
    enemyDamageTakenMult: 1,
    spawnDensityMult: 1,
    lootChanceMult: 1,
    scoreMult: 1.25,
  },
  {
    id: 'swarm',
    name: 'Swarm',
    desc: 'Twice as many enemies on every map',
    playerDamageTakenMult: 1,
    playerDamageDealtMult: 1,
    enemyDamageTakenMult: 1,
    spawnDensityMult: 2,
    lootChanceMult: 1,
    scoreMult: 1.3,
  },
  {
    id: 'miser',
    name: 'Miser',
    desc: 'Half the loot drops, but every point counts double-ish',
    playerDamageTakenMult: 1,
    playerDamageDealtMult: 1,
    enemyDamageTakenMult: 1,
    spawnDensityMult: 1,
    lootChanceMult: 0.5,
    scoreMult: 1.5,
  },
  {
    id: 'iron-skin',
    name: 'Iron Skin',
    desc: 'Enemies shrug off half of all damage',
    playerDamageTakenMult: 1,
    playerDamageDealtMult: 1,
    enemyDamageTakenMult: 0.5,
    spawnDensityMult: 1,
    lootChanceMult: 1,
    scoreMult: 1.25,
  },
];

export const MUTATOR_IDS: readonly string[] = MUTATOR_TABLE.map((m) => m.id);

/** Look up a mutator def; unknown ids return null (never throw). */
export function mutatorById(id: unknown): MutatorDef | null {
  return MUTATOR_TABLE.find((m) => m.id === id) ?? null;
}

/**
 * Deterministic mutator seed for a UTC date: the pinned daily seed XOR
 * the mutator salt. Throws on malformed dates via challengeSeed.
 */
export function mutatorSeed(dateStr: string): number {
  return (challengeSeed(dateStr) ^ MUTATOR_SALT) >>> 0;
}

/**
 * The day's mutator set: DAILY_MUTATOR_COUNT distinct ids, shuffled from
 * the canonical table order with Rng(mutatorSeed) only. Pure: same date
 * -> same ids, in the same order, on every machine.
 */
export function mutatorsForDate(dateStr: string): string[] {
  const rng = new Rng(mutatorSeed(dateStr));
  return rng.shuffle([...MUTATOR_IDS]).slice(0, DAILY_MUTATOR_COUNT);
}

/** Human line for a mutator set, used on the title screen and the board. */
export function mutatorLabel(ids: readonly string[]): string {
  if (!ids.length) return 'no mutators';
  return ids.map((id) => mutatorById(id)?.name ?? id).join(' + ');
}

/** Combined effect of a mutator set: every field is the product of the defs'. */
export interface MutatorEffect {
  playerDamageTakenMult: number;
  playerDamageDealtMult: number;
  enemyDamageTakenMult: number;
  spawnDensityMult: number;
  lootChanceMult: number;
  scoreMult: number;
}

/** The identity effect: no mutators, every multiplier 1. */
export const IDENTITY_MUTATOR_EFFECT: MutatorEffect = {
  playerDamageTakenMult: 1,
  playerDamageDealtMult: 1,
  enemyDamageTakenMult: 1,
  spawnDensityMult: 1,
  lootChanceMult: 1,
  scoreMult: 1,
};

/**
 * Combine a mutator set into one effect. Pure + deterministic. Unknown
 * ids are ignored (defensive: a stale stored id must never break a run).
 */
export function combineMutatorEffects(ids: readonly unknown[]): MutatorEffect {
  const out: MutatorEffect = { ...IDENTITY_MUTATOR_EFFECT };
  for (const id of ids) {
    const def = mutatorById(id);
    if (!def) continue;
    out.playerDamageTakenMult *= def.playerDamageTakenMult;
    out.playerDamageDealtMult *= def.playerDamageDealtMult;
    out.enemyDamageTakenMult *= def.enemyDamageTakenMult;
    out.spawnDensityMult *= def.spawnDensityMult;
    out.lootChanceMult *= def.lootChanceMult;
    out.scoreMult *= def.scoreMult;
  }
  return out;
}

/** Score multiplier for a mutator set (product of the defs' scoreMult). */
export function mutatorScoreMult(ids: readonly unknown[]): number {
  return combineMutatorEffects(ids).scoreMult;
}
