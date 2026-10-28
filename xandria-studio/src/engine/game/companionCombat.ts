/**
 * UPGRADE LOOP (companion-combat-depth): enemy retaliation against
 * companions — the ONE behavior-contract change this phase is authorized
 * to make, and it is additive only.
 *
 * THE CONTRACT CHANGE (read this before touching EnemyAI):
 * Enemies may now target a summoned, living companion INSTEAD of the
 * player. Nothing else about enemy behavior changes: chase/attack
 * ranges, facing, speeds, attack cadences and damage numbers are all
 * exactly the pre-existing values; only the target point changes, and
 * only when the weight table below picks the companion. When no
 * companion is summoned, or the companion is downed/fallen/out of
 * range, every enemy behaves byte-identically to before this phase
 * (companionTargetPos stays null and Enemy.update reads playerPos).
 *
 * TARGETING WEIGHT TABLE (exact math — REPORT.md discloses it verbatim):
 *   weight(player)    = 100, always, when the player is in aggro range
 *   weight(companion) = 40 + stance bonus, when the companion is
 *                       summoned, alive (hp > 0), and in aggro range
 *     stance normal: bonus 0   -> companion weight 40
 *     stance taunt:  bonus 120 -> companion weight 160 (beats the player)
 *     stance guard:  bonus 120 -> companion weight 160 (beats the player)
 *   A candidate out of aggro range has weight 0 (it cannot be picked).
 *   The highest weight wins; ties go to the player (stable, no RNG).
 *   Both candidates out of range -> null (enemy keeps its own idle
 *   behavior; the caller leaves companionTargetPos null).
 *   WHY GUARD DRAWS AGGRO (design note, proven by the e2e): a melee hit
 *   requires the enemy within 2.2m of the companion, and the follower
 *   stays within 14m of the player (snap rule) — so whenever an enemy
 *   CAN hit the companion, the player is within 16m, far inside the
 *   30m aggro range. A guard weight below the player's 100 would make
 *   guard UNREACHABLE in live play (never targeted, never halved). So
 *   taunt and guard BOTH draw aggro and differ in offense vs defense
 *   instead: taunt keeps attacking, guard stops attacking and halves
 *   damage. Normal is the only stance that does not draw aggro.
 * Aggro range mirrors Enemy.update exactly: turrets 42m, all other
 * kinds 30m (before the enemy's private aggroMult, which this module
 * cannot see — see the caveat in pickEnemyTarget).
 *
 * STANCES (one per roster entry, set from the companion panel):
 *   normal — fights as before, weight 40 (never draws aggro).
 *   taunt  — draws aggro (weight 160), still attacks normally.
 *   guard  — draws aggro (weight 160), does NOT attack, takes halved
 *            damage (see applyGuardReduction).
 *
 * COMPANION FALL + REVIVE (never a player death):
 * A companion reduced to 0 HP by an enemy hit FALLS: it is dismissed
 * to the panel (roster entry kept at 0 HP, not deleted) and the player
 * is untouched — no player HP loss, no run end, no XP loss. Revival
 * costs COMPANION_REVIVE_COST scrap through the existing Wallet
 * (vendor-economy path, additive: Wallet.spend), restores full HP,
 * and does NOT auto-summon — the player summons again from the panel.
 *
 * RANGED LIMITATION (disclosed, not hidden): ranged enemies (drone /
 * flyer / turret) chase and AIM at a companion target exactly like
 * melee kinds, but their projectiles collide only with the player body
 * (Projectiles collision groups: hostile -> GROUP.PLAYER; companions
 * have no physics body). So a ranged hit on a companion is NOT routed
 * to companion HP — only melee hits route through onCompanionHit.
 * Melee routing is exact; ranged routing is aim-only. The e2e asserts
 * the melee path exactly and the ranged path as aim (lastTarget).
 *
 * VOLATILE LIMITATION: volatile-affix detonation still rides the
 * pre-existing onPlayerHit channel (it is a death AoE, not a targeted
 * attack) — unchanged by this phase.
 *
 * DETERMINISM: this module is pure (no RNG, no time, no Math.random).
 * Target selection is a max-weight pick, so the same positions +
 * stance + kind always pick the same target.
 */

export type CompanionStance = 'normal' | 'taunt' | 'guard';

/** All companion stances, in panel order. */
export const COMPANION_STANCES: readonly CompanionStance[] = ['normal', 'taunt', 'guard'];

/** Runtime guard for stance values restored from saves / panel input. */
export function isCompanionStance(v: unknown): v is CompanionStance {
  return v === 'normal' || v === 'taunt' || v === 'guard';
}

/**
 * Targeting weights (see header). Taunt and guard both beat the
 * player: 40 + 120 = 160 > 100. Normal is the only stance that does
 * not draw aggro.
 */
export const COMPANION_TARGET_WEIGHTS = {
  /** weight of the player candidate */
  player: 100,
  /** weight of a companion candidate before its stance bonus */
  companionBase: 40,
  /** extra weight while the companion is in taunt stance */
  tauntBonus: 120,
  /** extra weight while the companion is in guard stance (see header: guard must draw aggro or be unreachable) */
  guardBonus: 120,
} as const;

/** Guard damage reduction: companion takes this fraction of a hit. */
export const GUARD_DAMAGE_FRACTION = 0.5;

/** Flat revive price, in scrap (existing Wallet currency). */
export const COMPANION_REVIVE_COST = 25;

/**
 * Aggro range by enemy kind, mirroring Enemy.update's aggroR before
 * the private aggroMult (difficulty/enemyMods aggression): turrets
 * 42m, everything else 30m. CAVEAT: an enemy whose aggroMult > 1
 * (aggression mod) has a longer true range than this table, so a
 * companion just outside 30m/42m may still be chased — the weight
 * pick itself is unaffected (both candidates share the same range
 * rule), only the out-of-range edge differs. No enemy file is touched
 * to expose aggroMult; the approximation is documented here and in
 * REPORT.md, and the e2e pins targets well inside range.
 */
export function enemyAggroRange(kind: string): number {
  return kind === 'turret' ? 42 : 30;
}

export type EnemyTargetPick = 'player' | 'companion' | null;

export interface EnemyTargetInput {
  /** distance from the enemy to the player, meters */
  playerDist: number;
  /** distance from the enemy to the companion, meters; null = no live companion */
  companionDist: number | null;
  /** the companion's current stance */
  stance: CompanionStance;
  /** enemy kind string (spec.kind), for the aggro range */
  kind: string;
}

/**
 * Pure enemy target pick per the weight table. Returns 'player' when
 * the player wins or when there is no live companion candidate,
 * 'companion' when the companion's weight wins, null when NEITHER
 * candidate is in aggro range.
 */
export function pickEnemyTarget(input: EnemyTargetInput): EnemyTargetPick {
  const range = enemyAggroRange(input.kind);
  const playerWeight = input.playerDist <= range ? COMPANION_TARGET_WEIGHTS.player : 0;
  let companionWeight = 0;
  if (input.companionDist !== null && input.companionDist <= range) {
    companionWeight = COMPANION_TARGET_WEIGHTS.companionBase
      + (input.stance === 'taunt' ? COMPANION_TARGET_WEIGHTS.tauntBonus
        : input.stance === 'guard' ? COMPANION_TARGET_WEIGHTS.guardBonus : 0);
  }
  if (playerWeight === 0 && companionWeight === 0) return null;
  // Ties go to the player (strict > for the companion to win).
  return companionWeight > playerWeight ? 'companion' : 'player';
}

/**
 * Guard damage reduction: a guard-stance companion takes half damage
 * (floored, minimum 1 for a nonzero hit — guard absorbs chip damage
 * but never fully negates a real hit). Other stances take full damage.
 */
export function applyGuardReduction(damage: number, stance: CompanionStance): number {
  if (stance !== 'guard' || damage <= 0) return damage;
  return Math.max(1, Math.floor(damage * GUARD_DAMAGE_FRACTION));
}
