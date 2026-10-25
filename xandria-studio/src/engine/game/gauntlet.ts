/**
 * Gauntlet mode — seeded boss-gauntlet runs.
 *
 * A gauntlet is an ordered sequence of GAUNTLET_ROUNDS boss fights drawn
 * from the existing boss defs (bosses.ts), one arena per boss reusing the
 * boss-fights arena system. Generation is PURE:
 *
 *   seed = GAUNTLET_SALT ^ yyyymmdd  (a uint32, "pinned" like daily-challenges)
 *   gauntlet = new Rng(seed) -> { bosses: [id x5] }
 *
 * Same date -> same seed, same boss order, for everyone on every machine.
 * The UTC calendar date is the input (sampled once when the run starts);
 * no wall-clock is ever sampled mid-run, so the run itself stays
 * deterministic under the engine's seeded-RNG rule. generateGauntlet also
 * accepts an explicit numeric seed (tests, e2e, dev).
 *
 * Run mode (Engine.startGauntletRun, additive wiring only):
 *   - the world is re-seeded from the gauntlet seed (the daily-challenges
 *     R2-M1 path: reseedPortalOrigin + syncTerrainToSeed + resetRun);
 *   - the run's spec is overridden for the mode: a {type:'boss',count:5}
 *     objective (so the HUD reads "N / 5 defeated" and the 5th boss kill
 *     ends the run through the existing Objectives -> engine.win() path),
 *     no ambient enemies, and the boss flag re-pointed per round;
 *     toTitle()/startRun() restore the base spec;
 *   - a GauntletDirector drives the rounds: per round it re-seeds the boss
 *     arena from gauntletRoundSeed(seed, round) via the live BossEncounter
 *     (spawnForMap — the boss-fights system, untouched), spawns one brute
 *     through the EnemyManager's public spawnOne, and marks it isBoss (a
 *     public Enemy field — the boss-fights wave's own report blesses this
 *     as additive wiring);
 *   - on each boss kill (the real die() path: hooks.emit('onKill') runs
 *     before the blueprint's onDeath -> objectives.addProgress, so the
 *     director's round counter is already advanced when the 5th kill
 *     completes the objective and scores the run) the player heals
 *     GAUNTLET_HEAL_FRAC of max health and the next round begins;
 *   - scoring: scoreGauntlet(roundsCleared, timeSeconds, damageTaken) —
 *     rounds dominate, faster runs earn a time bonus, damage taken
 *     subtracts. Best score per UTC date wins (recordGauntletResult);
 *     results are local-only (localStorage profile, guarded + migratable
 *     like the rest of Profile.ts). There is no server, no leaderboard.
 *
 * Boss defs and behavior contracts are untouched: the director only reads
 * BOSS_DEFS (canonical id order) and drives the encounter's public
 * spawnForMap/liveArena. Gauntlet runs need the boss encounter, so the
 * mode is gated to combat blueprints (gauntletSupported).
 */

import * as THREE from 'three';
import type { Genre } from '@spec';
import { Rng } from '../core/Rng';
import { BOSS_DEFS } from './bosses';
import type { Engine } from '../Engine';
import type { Enemy } from './EnemyAI';
import type { ProfileData } from './Profile';

/** Pinned salt: the gauntlet seed is (SALT ^ yyyymmdd) >>> 0. Never changes. */
export const GAUNTLET_SALT = 0x6a57;

/** Bosses per gauntlet run. */
export const GAUNTLET_ROUNDS = 5;

/** How many past days the gauntlet board shows (plus today). */
export const GAUNTLET_BOARD_DAYS = 7;

/** Heal between rounds, as a fraction of the avatar's max health. */
export const GAUNTLET_HEAL_FRAC = 0.5;

/** Genres whose blueprints wire the boss encounter (blueprints/bosses.ts). */
const GAUNTLET_GENRES: readonly Genre[] = [
  'third-person-action',
  'fps-arena',
  'top-down-shooter',
];

/** Canonical boss id order — the gauntlet draws from this. */
export const GAUNTLET_BOSS_IDS = Object.keys(BOSS_DEFS);

/** True when the genre's blueprint has boss-fights wiring. */
export function gauntletSupported(genre: Genre): boolean {
  return (GAUNTLET_GENRES as readonly string[]).includes(genre);
}

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
 * Deterministic gauntlet seed: GAUNTLET_SALT ^ yyyymmdd, as uint32.
 * Throws on malformed input (fail loud in tests rather than shipping a
 * garbage seed).
 */
export function gauntletSeedForDate(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`gauntletSeedForDate: bad date "${dateStr}" (want YYYY-MM-DD)`);
  }
  const yyyymmdd = parseInt(dateStr.replace(/-/g, ''), 10);
  return (GAUNTLET_SALT ^ yyyymmdd) >>> 0;
}

/** The pinned per-date tuple: identical for every player. */
export interface Gauntlet {
  /** world seed for the run (GAUNTLET_SALT ^ yyyymmdd, or explicit) */
  seed: number;
  /** ordered boss def ids, GAUNTLET_ROUNDS long */
  bosses: string[];
  /** == GAUNTLET_ROUNDS; kept on the tuple for readability */
  rounds: number;
}

/**
 * Generate the gauntlet's boss order from a seed. Pure: Rng(seed) only,
 * no I/O, no clock. Same seed -> deep-equal tuple, every machine.
 * Back-to-back repeats are skipped (a rematch with a fresh arena is fine
 * gameplay, but a gauntlet should feel like a tour).
 */
export function generateGauntlet(seed: number): Gauntlet {
  const rng = new Rng((seed >>> 0) || 0x9e3779b9);
  const bosses: string[] = [];
  for (let i = 0; i < GAUNTLET_ROUNDS; i++) {
    let id = rng.pick(GAUNTLET_BOSS_IDS);
    if (bosses.length && id === bosses[bosses.length - 1]) {
      id = GAUNTLET_BOSS_IDS[(GAUNTLET_BOSS_IDS.indexOf(id) + 1) % GAUNTLET_BOSS_IDS.length];
    }
    bosses.push(id);
  }
  return { seed: seed >>> 0, bosses, rounds: GAUNTLET_ROUNDS };
}

/**
 * PURE: the map seed for a gauntlet round — the boss encounter's arena
 * placement (planBossArena) and attack stream derive from this, so the
 * round-i arena is identical for every player on the same gauntlet seed.
 */
export function gauntletRoundSeed(gauntletSeed: number, roundIndex: number): number {
  return ((gauntletSeed ^ Math.imul(roundIndex + 1, 0x85ebca6b)) >>> 0);
}

/** Short display name for a boss id ("THE WARDEN" -> "WARDEN"). */
export function bossShortName(id: string): string {
  const def = BOSS_DEFS[id];
  if (!def) return id;
  return def.name.replace(/^THE /, '');
}

/** One-line boss order for the title screen ("WARDEN → TITAN → …"). */
export function gauntletLine(g: Gauntlet): string {
  return g.bosses.map(bossShortName).join(' → ');
}

// ---------------------------------------------------------------------------
// scoring + persistence (daily-challenges pattern, additive)
// ---------------------------------------------------------------------------

/**
 * PURE gauntlet score. Rounds cleared dominate (1000 each); faster runs
 * earn a small time bonus (2 pts per second under a 2:00/round par, at most
 * 240/round — never enough to bridge a full round, so with equal damage a
 * deeper run always outscores a shallower one); damage taken subtracts 1:1
 * but can never drive the score below 0. Zero rounds -> zero score.
 */
export function scoreGauntlet(r: {
  roundsCleared: number;
  timeSeconds: number;
  damageTaken: number;
}): number {
  const rounds = Math.max(0, Math.floor(r.roundsCleared));
  if (rounds === 0) return 0;
  const time = Math.max(0, r.timeSeconds);
  const dmg = Math.max(0, Math.floor(r.damageTaken));
  const timeBonus = Math.max(0, Math.round((rounds * 120 - time) * 2));
  const subtotal = rounds * 1000 + timeBonus;
  return subtotal - Math.min(dmg, subtotal);
}

/**
 * Record a finished gauntlet attempt. BEST score per date wins: a lower
 * (or equal) score never overwrites a stored best. Returns true when the
 * result was stored. Also tracks the all-time best (gauntletBest).
 */
export function recordGauntletResult(
  p: ProfileData,
  dateStr: string,
  r: {
    roundsCleared: number;
    kills: number;
    timeSeconds: number;
    damageTaken: number;
    won: boolean;
    genre: string;
    seed: number;
  },
): boolean {
  const score = scoreGauntlet(r);
  const prev = p.gauntletResults[dateStr];
  if (prev && prev.score >= score) return false;
  p.gauntletResults[dateStr] = {
    score,
    roundsCleared: Math.max(0, Math.floor(r.roundsCleared)),
    kills: Math.max(0, Math.floor(r.kills)),
    timeSeconds: Math.max(0, r.timeSeconds),
    damageTaken: Math.max(0, Math.floor(r.damageTaken)),
    won: r.won,
    genre: typeof r.genre === 'string' ? r.genre : '',
    seed: r.seed >>> 0,
  };
  if (score > (p.gauntletBest ?? 0)) p.gauntletBest = score;
  return true;
}

// ---------------------------------------------------------------------------
// gauntlet board (title screen)
// ---------------------------------------------------------------------------

export interface GauntletBoardRow {
  date: string;
  today: boolean;
  /** boss order short names for the date's pinned gauntlet */
  bossesText: string;
  result: {
    score: number;
    roundsCleared: number;
    won: boolean;
  } | null;
}

/**
 * Board rows for today + the previous GAUNTLET_BOARD_DAYS days, newest
 * first. All local: the gauntlet tuple is recomputed from each date (pure)
 * and results come from the profile. Offline-only by construction.
 */
export function gauntletBoard(
  p: ProfileData,
  todayStr: string = todayUtcDate(),
): GauntletBoardRow[] {
  const rows: GauntletBoardRow[] = [];
  for (let n = 0; n <= GAUNTLET_BOARD_DAYS; n++) {
    const date = utcDateMinus(todayStr, n);
    const g = generateGauntlet(gauntletSeedForDate(date));
    const stored = p.gauntletResults[date] ?? null;
    rows.push({
      date,
      today: n === 0,
      bossesText: gauntletLine(g),
      result: stored
        ? {
            score: stored.score,
            roundsCleared: stored.roundsCleared,
            won: stored.won,
          }
        : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// run director (live run)
// ---------------------------------------------------------------------------

/**
 * Drives a gauntlet run's rounds. Taps the public hook surface only
 * (onKill) — no blueprint or NPC/enemy behavior changes. The Engine owns
 * the director's lifetime: startGauntletRun creates+starts it, toTitle() /
 * startRun() disarm it, resetRun() re-drives the current round after an
 * in-place rebuild (onRunRebuilt).
 *
 * Kill-flow ordering (verified against EnemyAI.die): hooks.emit('onKill')
 * runs BEFORE the blueprint's onDeath -> objectives.addProgress('kill'),
 * so the director's round counter is already advanced when the 5th boss
 * kill completes the {type:'boss',count:5} objective and ends the run
 * through the existing Objectives -> engine.win() path. The director never
 * calls win() itself.
 */
export class GauntletDirector {
  /** boss kills so far == rounds cleared (only the current boss counts) */
  roundsCleared = 0;
  kills = 0;
  private untaps: Array<() => void> = [];
  private currentBoss: Enemy | null = null;
  private done = false;

  constructor(
    private engine: Engine,
    readonly gauntlet: Gauntlet,
  ) {}

  get active(): boolean {
    return this.untaps.length > 0 && !this.done;
  }

  /** 0-based index of the round currently being fought. */
  get roundIndex(): number {
    return this.roundsCleared;
  }

  start(): void {
    if (this.untaps.length) return;
    this.untaps = [
      this.engine.hooks.tap('onKill', ({ enemy }) => this.onKill(enemy)),
    ];
    this.setupRound(0);
  }

  disarm(): void {
    for (const u of this.untaps) u();
    this.untaps = [];
    this.currentBoss = null;
  }

  /**
   * Called by Engine.resetRun() after an in-place rebuild: the world is
   * fresh (new encounter, no boss) — re-drive the current round so the
   * run continues instead of stalling boss-less. The round seed is a pure
   * function of (gauntletSeed, round), so the replayed round is identical.
   */
  onRunRebuilt(): void {
    if (this.done || !this.untaps.length) return;
    this.setupRound(this.roundsCleared);
  }

  private onKill(enemy: Enemy): void {
    if (this.done || enemy !== this.currentBoss) return;
    this.kills++;
    this.roundsCleared++;
    this.currentBoss = null;
    // heal between rounds (also fires after the final boss — harmless,
    // the run is over)
    const av = this.engine.portalsPlayerAvatar;
    if (av && av.health > 0) av.heal(av.maxHealth * GAUNTLET_HEAL_FRAC);
    if (this.roundsCleared < this.gauntlet.rounds) {
      this.setupRound(this.roundsCleared);
      const def = BOSS_DEFS[this.gauntlet.bosses[this.roundsCleared]];
      this.engine.hud.toast(`ROUND ${this.roundsCleared + 1} — ${def?.name ?? ''}`);
    } else {
      // the 5th kill completes the boss objective -> Objectives fires
      // engine.win(); the director's counters are already final.
      this.done = true;
      this.disarm();
    }
  }

  private setupRound(i: number): void {
    const wiring = this.engine.bossWiring;
    if (!wiring) return; // combat blueprints only — the title gates this
    const bossId = this.gauntlet.bosses[i];
    const spec = this.engine.spec;
    spec.custom = spec.custom ?? {};
    spec.custom.boss = { enabled: true, bossId };
    const seed = gauntletRoundSeed(this.gauntlet.seed, i);
    // re-place the arena for this round (the boss-fights system, untouched)
    wiring.encounter.spawnForMap(seed);
    // spawn the round's brute through the public spawn path; the encounter
    // binds the first living isBoss brute on its next tick (teleporting it
    // into the arena, scaling health by the def, showing the bar).
    const av = this.engine.portalsPlayerAvatar;
    const px = av?.ctrl.position.x ?? 0;
    const py = av?.ctrl.position.y ?? 2;
    const pz = av?.ctrl.position.z ?? 0;
    const brute = wiring.manager.spawnOne(
      { kind: 'brute', count: 1, health: 120, speed: 4.5, damage: 12, weapon: 'melee' },
      new THREE.Vector3(px, py + 2, pz),
      seed,
    );
    // public Enemy field (the boss-fights wave's report blesses this as
    // additive wiring); also implied by the boss objective, set explicitly
    brute.isBoss = true;
    this.currentBoss = brute;
  }
}
