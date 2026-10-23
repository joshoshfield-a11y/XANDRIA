/**
 * Daily challenges — seeded daily runs, identical for every player.
 *
 * The challenge for a calendar day is generated PURELY from the UTC date:
 *   seed = DAILY_CHALLENGE_SALT ^ yyyymmdd  (a uint32, "pinned")
 *   challenge = new Rng(seed) → { loadout, goal }
 *
 * Same date -> same seed, same fixed modifier loadout, same goal, for
 * everyone on every machine. The UTC calendar date is the input (sampled
 * once when the run starts); no wall-clock is ever sampled mid-run, so the
 * run itself stays deterministic under the engine's seeded-RNG rule.
 *
 * Challenge run mode:
 *   - Engine.startDailyRun(dateStr?) builds the challenge, re-seeds the
 *     world, and applies the FIXED challenge loadout (everyone plays the
 *     same build — the profile's own loadout is ignored for the attempt).
 *   - A ChallengeGoalTracker watches kills / score / elapsed via engine
 *     hooks and calls engine.win() when the day's goal is met. Reaching
 *     the goal is not required to finish — a normal win/lose still scores
 *     the attempt.
 *   - One scored attempt per UTC date per profile: the first completed run
 *     (win or lose) writes profile.dailyResults[date]; later completions
 *     for the same date never overwrite it. Quitting mid-run (no
 *     completion) does NOT consume the attempt.
 *   - Results are local-only (localStorage profile, guarded + migratable
 *     like the rest of Profile.ts). There is no server, no leaderboard.
 *
 * Reuses the generator and scaling systems unmodified: the daily run plays
 * on the base game's spec (same genre/blueprint), only the world seed,
 * loadout config, and goal overlay differ. Additive wiring only.
 */

import { Rng } from '../core/Rng';
import {
  MODIFIER_IDS,
  MODIFIERS,
  defaultProfile,
  type ProfileData,
} from './Profile';
import type { Engine } from '../Engine';

/** Pinned salt: the daily seed is (SALT ^ yyyymmdd) >>> 0. Never changes. */
export const DAILY_CHALLENGE_SALT = 0xd41e5ca1;

/** How many past days the challenge board shows (plus today). */
export const CHALLENGE_BOARD_DAYS = 7;

/** UTC calendar date as YYYY-MM-DD — the same "today" for every player. */
export function todayUtcDate(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD minus n days (UTC calendar arithmetic). */
export function utcDateMinus(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - n * 86400_000;
  return todayUtcDate(new Date(t));
}

/**
 * Deterministic daily seed: DAILY_CHALLENGE_SALT ^ yyyymmdd, as uint32.
 * Throws on malformed input (fail loud in tests rather than shipping a
 * garbage seed).
 */
export function challengeSeed(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`challengeSeed: bad date "${dateStr}" (want YYYY-MM-DD)`);
  }
  const yyyymmdd = parseInt(dateStr.replace(/-/g, ''), 10);
  return (DAILY_CHALLENGE_SALT ^ yyyymmdd) >>> 0;
}

export type ChallengeGoalKind = 'kills' | 'score' | 'survive';

export interface ChallengeGoal {
  kind: ChallengeGoalKind;
  target: number;
}

/** The fixed per-day tuple: identical for every player. */
export interface DailyChallenge {
  /** UTC date key, YYYY-MM-DD */
  date: string;
  /** world seed: DAILY_CHALLENGE_SALT ^ yyyymmdd */
  seed: number;
  /** fixed modifier ids — everyone plays the same build */
  loadout: string[];
  goal: ChallengeGoal;
}

/**
 * Generate the day's challenge from the UTC date. Pure: Rng(challengeSeed)
 * only, no I/O, no clock. Same date -> deep-equal tuple, every machine.
 */
export function generateDailyChallenge(dateStr: string): DailyChallenge {
  const seed = challengeSeed(dateStr);
  const rng = new Rng(seed);

  // fixed loadout: 2 distinct modifiers from the canonical modifier order
  const pool = [...MODIFIER_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const loadout = pool.slice(0, 2);

  const kind = rng.pick(['kills', 'score', 'survive'] as const);
  let target: number;
  switch (kind) {
    case 'kills':
      target = rng.int(25, 60);
      break;
    case 'score':
      target = rng.int(15, 50) * 50; // 750..2500
      break;
    case 'survive':
      target = rng.int(8, 20) * 15; // 120..300 s
      break;
  }
  return { date: dateStr, seed, loadout, goal: { kind, target } };
}

/** Human line for the goal, used on the title screen and the board. */
export function goalLabel(goal: ChallengeGoal): string {
  switch (goal.kind) {
    case 'kills':
      return `Kill ${goal.target} enemies`;
    case 'score':
      return `Score ${goal.target.toLocaleString('en-US')} pts`;
    case 'survive':
      return `Survive ${goal.target}s`;
  }
}

/** One-line loadout summary for the title screen. */
export function loadoutLabel(loadout: string[]): string {
  if (!loadout.length) return 'no modifiers';
  return loadout
    .map((id) => MODIFIERS.find((m) => m.id === id)?.name ?? id)
    .join(' + ');
}

// ---------------------------------------------------------------------------
// profile wiring
// ---------------------------------------------------------------------------

/**
 * A profile shaped for applyLoadout() carrying the challenge's FIXED
 * loadout instead of the player's own. applyLoadout only reads owned +
 * loadout, so a default profile with both set to the challenge ids is
 * exact — everyone plays the identical build.
 */
export function challengeProfile(challenge: DailyChallenge): ProfileData {
  const p = defaultProfile();
  p.owned = [...challenge.loadout];
  p.loadout = [...challenge.loadout];
  return p;
}

/**
 * Record a finished challenge attempt. FIRST attempt wins: once a date has
 * a result, later completions for that date are dropped (the attempt is
 * consumed). Returns true when the result was stored.
 */
export function recordDailyResult(
  p: ProfileData,
  dateStr: string,
  r: {
    score: number;
    kills: number;
    timeSeconds: number;
    damageTaken: number;
    won: boolean;
    goal: ChallengeGoal;
    genre: string;
    seed: number;
  },
): boolean {
  if (p.dailyResults[dateStr]) return false;
  p.dailyResults[dateStr] = {
    score: Math.max(0, Math.floor(r.score)),
    kills: Math.max(0, Math.floor(r.kills)),
    timeSeconds: Math.max(0, r.timeSeconds),
    damageTaken: Math.max(0, Math.floor(r.damageTaken)),
    won: r.won,
    goalKind: r.goal.kind,
    goalTarget: r.goal.target,
    genre: r.genre,
    seed: r.seed >>> 0,
  };
  return true;
}

// ---------------------------------------------------------------------------
// goal tracking (live run)
// ---------------------------------------------------------------------------

/**
 * Watches a live challenge run and wins it when the day's goal is met.
 * Taps the public hook surface only (onKill / onTick) — no blueprint or
 * NPC/enemy behavior changes. Engine hooks persist across in-place
 * restarts, so an armed tracker survives restart() (same attempt, same
 * goal); arm() is idempotent and disarm() is called on toTitle() and after
 * the attempt completes.
 */
export class ChallengeGoalTracker {
  kills = 0;
  private untaps: Array<() => void> = [];
  private done = false;

  constructor(
    private engine: Engine,
    readonly challenge: DailyChallenge,
  ) {}

  get armed(): boolean {
    return this.untaps.length > 0 && !this.done;
  }

  arm(): void {
    if (this.untaps.length) return;
    this.untaps = [
      this.engine.hooks.tap('onKill', () => {
        this.kills++;
      }),
      this.engine.hooks.tap('onTick', () => {
        this.check();
      }),
    ];
  }

  disarm(): void {
    for (const u of this.untaps) u();
    this.untaps = [];
  }

  private check(): void {
    if (this.done || this.engine.state !== 'playing') return;
    const { kind, target } = this.challenge.goal;
    const met =
      kind === 'kills'
        ? this.kills >= target
        : kind === 'score'
          ? this.engine.score >= target
          : this.engine.elapsed >= target;
    if (met) {
      this.done = true;
      this.disarm();
      this.engine.win(
        { kills: this.kills },
        `DAILY CHALLENGE COMPLETE — ${goalLabel(this.challenge.goal)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// challenge board (title screen)
// ---------------------------------------------------------------------------

export interface DailyBoardRow {
  date: string;
  today: boolean;
  goalText: string;
  loadoutText: string;
  result: {
    score: number;
    kills: number;
    timeSeconds: number;
    damageTaken: number;
    won: boolean;
  } | null;
}

/**
 * Board rows for today + the previous CHALLENGE_BOARD_DAYS days, newest
 * first. All local: the challenge tuple is recomputed from each date (pure)
 * and results come from the profile. Offline-only by construction.
 */
export function challengeBoard(
  p: ProfileData,
  todayStr: string = todayUtcDate(),
): DailyBoardRow[] {
  const rows: DailyBoardRow[] = [];
  for (let n = 0; n <= CHALLENGE_BOARD_DAYS; n++) {
    const date = utcDateMinus(todayStr, n);
    const ch = generateDailyChallenge(date);
    const stored = p.dailyResults[date] ?? null;
    rows.push({
      date,
      today: n === 0,
      goalText: goalLabel(ch.goal),
      loadoutText: loadoutLabel(ch.loadout),
      result: stored
        ? {
            score: stored.score,
            kills: stored.kills,
            timeSeconds: stored.timeSeconds,
            damageTaken: stored.damageTaken,
            won: stored.won,
          }
        : null,
    });
  }
  return rows;
}
