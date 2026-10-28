/**
 * STEALTH-SYSTEM (upgrade loop): sneak state + enemy detection model.
 *
 * This is the ONE authorized narrow behavior-contract change for this
 * phase (the same standing as companion-combat-depth was for
 * retaliation): enemies gain awareness states that gate their existing
 * chase/attack behavior. Nothing else about enemy behavior changes —
 * chase/attack ranges, facing, speeds, attack cadences, and damage
 * numbers are all pre-existing values; only WHETHER the enemy chases
 * changes, and only through the weight table below.
 *
 * ONE TUNING TABLE (STEALTH_TABLE) — no other file carries stealth
 * numbers. The sneak-attack bonus reuses the CRIT_TABLE multiplier
 * (crit.ts) — it is not a second damage table.
 *
 * Detection model (disclosed in full; line-of-sight is NOT modeled):
 *   - Detection is radius + noise ONLY. Walls, darkness, and facing
 *     never hide the player. This is a deliberate scope limit of this
 *     phase, disclosed here and in the phase REPORT.md.
 *   - Effective detection radius =
 *       baseRadius(kind) x sneakMultiplier (0.45 while sneaking, else 1)
 *       x detectionJitter (0.9–1.1, one seeded draw per enemy at spawn)
 *       x aggroMult (the PRE-EXISTING enemy aggression multiplier:
 *       spec enemyMods.aggression and boss-phase growth — stealth does
 *       not own it, it only reads it, exactly as the old aggroR did).
 *   - Targeting weight (the exact math, prominently disclosed):
 *       weight(unaware) = 0, weight(suspicious) = 0, weight(alerted) = 100.
 *     An enemy chases/attacks only while its weight is 100. There is no
 *     partial chase: suspicious enemies keep wandering (their pre-
 *     existing idle behavior) until they escalate or calm down.
 *   - Awareness transitions (AwarenessTracker, pure per-enemy state):
 *       unaware --(inside detection radius)--> suspicious, and after
 *         ALERT_DELAY (0.4s) of continuous exposure --> alerted.
 *       unaware --(noise heard)--> suspicious.
 *       suspicious --(suspicion timer expires, 4s without stimulus)-->
 *         unaware. Noise re-heard resets the timer.
 *       alerted --(beyond detection radius x hysteresis 1.3)-->
 *         suspicious (timer restarts); then unaware as above. This
 *         mirrors the pre-existing idle hysteresis (aggroR * 1.3).
 *       ANY state --(takes damage)--> alerted immediately.
 *       A lure target (deployables) bypasses awareness entirely: a
 *       lured enemy is treated as alerted toward the totem, exactly
 *       as before this phase.
 *   - Noise: continuous movement noise is a radius around the player
 *     (walk 6m, sprint 12m, dash 10m, sneaking 0m — sneaking is
 *     silent). A one-shot attack noise (14m) fires on every attack
 *     via the onAttack hook tap in tpAction. Noise NEVER alerts
 *     directly: it only makes enemies suspicious (unless the enemy is
 *     already alerted). Enemies outside the noise radius hear nothing.
 *   - Sneak-attack bonus: a melee strike against an enemy whose
 *     awareness is 'unaware' at the moment of the strike deals
 *     round(baseDamage x critMultiplierFor(ctx)) — the CRIT_TABLE
 *     multiplier (x2.0 for a common weapon, no smithing rank) —
 *     applied ONCE, additively, exactly like applyCrit. The crit roll
 *     is SKIPPED on that strike (no seeded crit draw is consumed and
 *     the two multipliers never stack). First strike only: taking
 *     damage alerts the victim, so the next strike is a normal one.
 *     Projectiles do NOT get the sneak bonus (their crit paths live in
 *     the blueprints); they still make attack noise.
 *
 * Determinism: the ONLY RNG in this module is the per-enemy detection
 * jitter — one draw from Rng(seed ^ STEALTH_SALT) at spawn, fixed for
 * the enemy's life. Awareness transitions are pure functions of
 * (dt, distance, noise, damage). No Math.random / Date.now anywhere.
 * Sneak state is player-scoped (CharacterController.sneaking) and is
 * never persisted in saves (holding the key is the state).
 */
import { Rng } from '../core/Rng';
import { critMultiplierFor, type CritCtx } from './crit';

/** Salt for the per-enemy detection-jitter stream — off every other stream. */
export const DETECTION_JITTER_SALT = 0x5ea17;

/** Enemy awareness states. */
export type AwarenessState = 'unaware' | 'suspicious' | 'alerted';

/** The one stealth tuning table — every stealth number lives here. */
export const STEALTH_TABLE = {
  /** base detection radius (m) for walker/brute/drone/flyer. */
  baseDetectionRadius: 30,
  /** base detection radius (m) for turrets (mirrors the old aggroR). */
  turretDetectionRadius: 42,
  /** detection-radius multiplier while the player is sneaking. */
  sneakRadiusMultiplier: 0.45,
  /** movement-speed multiplier while the player is sneaking. */
  sneakSpeedMultiplier: 0.5,
  /** detection-jitter bounds: one seeded draw per enemy, in [low, high]. */
  jitterLow: 0.9,
  jitterHigh: 1.1,
  /** continuous exposure (s) inside the detection radius before alerting. */
  alertDelaySeconds: 0.4,
  /** suspicion lifetime (s) without renewed stimulus before calming down. */
  suspicionSeconds: 4,
  /** hysteresis multiplier for losing alert (mirrors the old aggroR * 1.3). */
  hysteresisMultiplier: 1.3,
  /** continuous movement-noise radius (m) while walking (not sneaking). */
  walkNoiseRadius: 6,
  /** continuous movement-noise radius (m) while sprinting. */
  sprintNoiseRadius: 12,
  /** continuous movement-noise radius (m) while dashing. */
  dashNoiseRadius: 10,
  /** one-shot attack-noise radius (m) fired on every attack. */
  attackNoiseRadius: 14,
} as const;

/**
 * Targeting weight for an awareness state — the exact weight math.
 * Chase/attack happen only at weight 100 (alerted). Suspicious
 * enemies score 0: they wander, they do not pursue.
 */
export function targetWeightFor(awareness: AwarenessState): number {
  return awareness === 'alerted' ? 100 : 0;
}

/** Base detection radius for a kind (before sneak/jitter/aggroMult). */
export function baseDetectionRadiusFor(kind: string): number {
  return kind === 'turret' ? STEALTH_TABLE.turretDetectionRadius : STEALTH_TABLE.baseDetectionRadius;
}

/**
 * One seeded detection-jitter draw per enemy, fixed for its life.
 * Same seed -> identical jitter; always in [0.9, 1.1].
 */
export function detectionJitterFor(seed: number): number {
  const r = new Rng((seed ^ DETECTION_JITTER_SALT) >>> 0);
  const v = r.range(STEALTH_TABLE.jitterLow, STEALTH_TABLE.jitterHigh);
  return Math.round(v * 10000) / 10000;
}

/**
 * Effective detection radius: base x sneak x jitter x aggroMult.
 * aggroMult is the pre-existing aggression multiplier (spec
 * enemyMods.aggression, boss phases) — read here, never owned here.
 */
export function detectionRadiusFor(
  kind: string,
  sneaking: boolean,
  jitter: number,
  aggroMult: number,
): number {
  const sneak = sneaking ? STEALTH_TABLE.sneakRadiusMultiplier : 1;
  // Round to the table's authored precision — float dust (42 * 0.45 =
  // 18.900000000000002) must never leak into a radius boundary.
  return Math.round(baseDetectionRadiusFor(kind) * sneak * jitter * aggroMult * 10000) / 10000;
}

/** Continuous movement-noise radius for the player's current motion. */
export function noiseRadiusFor(motion: {
  moving: boolean;
  sneaking: boolean;
  sprinting: boolean;
  dashing: boolean;
}): number {
  if (!motion.moving || motion.sneaking) return 0;
  if (motion.dashing) return STEALTH_TABLE.dashNoiseRadius;
  if (motion.sprinting) return STEALTH_TABLE.sprintNoiseRadius;
  return STEALTH_TABLE.walkNoiseRadius;
}

/**
 * Sneak-attack bonus: round(baseDamage x CRIT_TABLE multiplier).
 * Applied once, additively, on a first strike from unaware only.
 * Uses the crit table's multiplier for the caller's tier/rank — there
 * is no separate sneak damage table.
 */
export function applySneakBonus(baseDamage: number, ctx: CritCtx): number {
  return Math.round(baseDamage * critMultiplierFor(ctx.tier, ctx.skillRank));
}

/** Per-frame awareness input for one enemy. */
export interface AwarenessInput {
  /** player (or lure) distance is inside the effective detection radius. */
  inDetectionRange: boolean;
  /** distance is beyond detection radius x hysteresis (losing alert). */
  beyondHysteresis: boolean;
  /** a noise event reached this enemy this frame. */
  noiseHeard: boolean;
  /** this enemy took damage this frame (set via alert(), not here). */
  damaged?: boolean;
}

/**
 * Pure per-enemy awareness state machine. Holds only (state, exposure,
 * suspicion timer); transitions are deterministic functions of the
 * input. Damage bypasses update(): call alert() — it wins over every
 * other transition, including mid-frame.
 */
export class AwarenessTracker {
  state: AwarenessState = 'unaware';
  private exposure = 0;
  private suspicionTimer = 0;

  /** Damage alerts immediately, whatever the previous state was. */
  alert(): void {
    this.state = 'alerted';
    this.exposure = 0;
    this.suspicionTimer = 0;
  }

  /** Noise makes an enemy suspicious (never directly alerted). */
  hearNoise(): void {
    if (this.state === 'alerted') return;
    this.state = 'suspicious';
    this.suspicionTimer = STEALTH_TABLE.suspicionSeconds;
  }

  update(dt: number, input: AwarenessInput): AwarenessState {
    if (input.damaged) this.alert();
    if (this.state === 'alerted') {
      if (input.beyondHysteresis) {
        this.state = 'suspicious';
        this.exposure = 0;
        this.suspicionTimer = STEALTH_TABLE.suspicionSeconds;
      }
      return this.state;
    }
    if (this.state === 'suspicious') {
      if (input.noiseHeard) this.suspicionTimer = STEALTH_TABLE.suspicionSeconds;
      if (input.inDetectionRange) {
        this.exposure += dt;
        if (this.exposure >= STEALTH_TABLE.alertDelaySeconds) {
          this.state = 'alerted';
          this.exposure = 0;
          this.suspicionTimer = 0;
        }
      } else {
        this.exposure = 0;
        this.suspicionTimer -= dt;
        if (this.suspicionTimer <= 0) this.state = 'unaware';
      }
      return this.state;
    }
    // unaware
    if (input.noiseHeard) {
      this.state = 'suspicious';
      this.suspicionTimer = STEALTH_TABLE.suspicionSeconds;
      this.exposure = input.inDetectionRange ? dt : 0;
      return this.state;
    }
    if (input.inDetectionRange) {
      this.state = 'suspicious';
      this.exposure = dt;
      this.suspicionTimer = STEALTH_TABLE.suspicionSeconds;
      if (this.exposure >= STEALTH_TABLE.alertDelaySeconds) {
        this.state = 'alerted';
        this.exposure = 0;
        this.suspicionTimer = 0;
      }
    }
    return this.state;
  }
}

/** What the enemy perception step needs about the player this frame. */
export interface StealthPerception {
  /** player is holding sneak (CharacterController.sneaking). */
  sneaking: boolean;
  /** continuous movement-noise radius around the player (0 = silent). */
  noiseRadius: number;
}

/** Default perception: standing, silent — the pre-stealth behavior. */
export const DEFAULT_PERCEPTION: StealthPerception = { sneaking: false, noiseRadius: 0 };
