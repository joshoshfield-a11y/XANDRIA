/**
 * Profile — cross-run progression persisted in localStorage.
 *
 * What persists across runs:
 *   - per-genre runs played / won, best score, best level reached
 *   - lifetime totals: kills, playtime
 *   - merit balance + purchased modifiers + equipped loadout
 *   - local daily-challenge bests (YYYY-MM-DD -> score)
 *
 * Merit economy (documented, intentionally simple):
 *   - finishing a run earns (won ? 10 : 2) merit, plus +1 per level reached.
 *   - modifiers are permanent unlocks bought with merit, then equipped as a
 *     loadout that applies to every subsequent run until changed.
 *
 * Determinism: modifiers only ever touch the run's *config* (player health /
 * speed / lives, a damage multiplier) — never the seed. applyLoadout() is
 * idempotent: it restores pristine base values from a snapshot before
 * re-applying, so restarts can never compound bonuses.
 *
 * Storage access is guarded — headless/test environments without localStorage
 * get a working in-memory profile instead of a crash. Tests can inject a fake
 * backend via _setProfileStorage().
 */

import type { GameSpec } from '@spec';

export const PROFILE_KEY = 'xandria.profile.v1';
/** Bump when the stored shape changes; migrateProfile() handles old versions. */
export const PROFILE_VERSION = 1;

/** A purchasable, equippable run modifier. Effects are documented per id. */
export interface ModifierDef {
  id: string;
  name: string;
  /** player-facing description of the effect */
  desc: string;
  /** merit cost to unlock (permanent) */
  cost: number;
}

export const MODIFIERS: ModifierDef[] = [
  { id: 'vitality', name: 'Vitality', desc: '+25 max health', cost: 20 },
  { id: 'power', name: 'Power', desc: '+10% damage', cost: 25 },
  { id: 'swift', name: 'Swift', desc: '+8% move speed', cost: 15 },
  { id: 'secondwind', name: 'Second Wind', desc: '+1 life per run', cost: 18 },
];

export const MODIFIER_IDS = MODIFIERS.map((m) => m.id);

export interface RunResult {
  genre: string;
  won: boolean;
  /** final score, rounded */
  score: number;
  /** player level reached */
  level: number;
  kills: number;
  /** run length in seconds */
  timeSeconds: number;
  /** YYYY-MM-DD when this was a daily-challenge run; feeds the local daily best */
  daily?: string;
}

export interface ProfileData {
  version: number;
  /** spendable currency earned from runs */
  merit: number;
  /** purchased modifier ids (permanent unlocks) */
  owned: string[];
  /** equipped modifier ids (subset of owned; applies to the next run) */
  loadout: string[];
  runsPlayed: Record<string, number>;
  runsWon: Record<string, number>;
  bestScore: Record<string, number>;
  bestLevel: Record<string, number>;
  totalKills: number;
  /** lifetime seconds played */
  totalPlaytime: number;
  /** local daily-challenge bests: YYYY-MM-DD -> score */
  dailyBest: Record<string, number>;
}

/** Merit earned for finishing a run. Wins pay more; every level adds a bonus. */
export function meritForRun(won: boolean, level: number): number {
  return (won ? 10 : 2) + Math.max(0, Math.floor(level));
}

export function defaultProfile(): ProfileData {
  return {
    version: PROFILE_VERSION,
    merit: 0,
    owned: [],
    loadout: [],
    runsPlayed: {},
    runsWon: {},
    bestScore: {},
    bestLevel: {},
    totalKills: 0,
    totalPlaytime: 0,
    dailyBest: {},
  };
}

// ---------------------------------------------------------------------------
// storage (guarded + injectable for tests)
// ---------------------------------------------------------------------------

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

let injected: StorageLike | null | undefined;

function backend(): StorageLike | null {
  if (injected !== undefined) return injected;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Tests only: inject a fake storage backend (null = no storage at all). */
export function _setProfileStorage(s: StorageLike | null | undefined): void {
  injected = s;
}

/** In-memory fallback so the game still tracks a session profile headless. */
const memoryFallback = new Map<string, string>();
const fallbackBackend: StorageLike = {
  getItem: (k) => memoryFallback.get(k) ?? null,
  setItem: (k, v) => { memoryFallback.set(k, v); },
};

function store(): StorageLike {
  return backend() ?? fallbackBackend;
}

// ---------------------------------------------------------------------------
// load / save / migrate
// ---------------------------------------------------------------------------

/**
 * Merge stored data over defaults; unknown/old shapes migrate forward.
 * Corrupt or missing data yields a fresh profile — never throws.
 */
export function migrateProfile(raw: unknown): ProfileData {
  const base = defaultProfile();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  // version stub: v1 is the first shipped shape; future versions migrate here.
  const version = typeof r.version === 'number' ? Math.floor(r.version) : 0;
  if (version > PROFILE_VERSION) return base; // from the future — don't trust it
  const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
  const strArr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const numRec = (v: unknown) => {
    const out: Record<string, number> = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x === 'number' && isFinite(x)) out[k] = x;
      }
    }
    return out;
  };
  const owned = strArr(r.owned).filter((id) => MODIFIER_IDS.includes(id));
  return {
    ...base,
    version: PROFILE_VERSION,
    merit: Math.max(0, Math.floor(num(r.merit))),
    owned,
    // loadout must be a subset of owned, in canonical modifier order
    loadout: strArr(r.loadout).filter((id) => owned.includes(id)),
    runsPlayed: numRec(r.runsPlayed),
    runsWon: numRec(r.runsWon),
    bestScore: numRec(r.bestScore),
    bestLevel: numRec(r.bestLevel),
    totalKills: Math.max(0, Math.floor(num(r.totalKills))),
    totalPlaytime: Math.max(0, num(r.totalPlaytime)),
    dailyBest: numRec(r.dailyBest),
  };
}

export function loadProfile(): ProfileData {
  try {
    const raw = store().getItem(PROFILE_KEY);
    if (!raw) return defaultProfile();
    return migrateProfile(JSON.parse(raw));
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(p: ProfileData): void {
  try {
    store().setItem(PROFILE_KEY, JSON.stringify({ ...p, version: PROFILE_VERSION }));
  } catch {
    /* storage unavailable — the in-memory profile still applies this session */
  }
}

// ---------------------------------------------------------------------------
// run recording + economy
// ---------------------------------------------------------------------------

/** Aggregate a finished run into the profile (stats, merit, daily best). */
export function recordRun(p: ProfileData, r: RunResult): ProfileData {
  const g = r.genre || 'unknown';
  p.runsPlayed[g] = (p.runsPlayed[g] ?? 0) + 1;
  if (r.won) p.runsWon[g] = (p.runsWon[g] ?? 0) + 1;
  p.bestScore[g] = Math.max(p.bestScore[g] ?? 0, Math.max(0, Math.floor(r.score)));
  p.bestLevel[g] = Math.max(p.bestLevel[g] ?? 0, Math.max(0, Math.floor(r.level)));
  p.totalKills += Math.max(0, Math.floor(r.kills));
  p.totalPlaytime += Math.max(0, r.timeSeconds);
  p.merit += meritForRun(r.won, r.level);
  if (r.daily) {
    const s = Math.max(0, Math.floor(r.score));
    p.dailyBest[r.daily] = Math.max(p.dailyBest[r.daily] ?? 0, s);
  }
  return p;
}

/** Buy a modifier with merit. Returns false when unknown, already owned, or unaffordable. */
export function purchaseModifier(p: ProfileData, id: string): boolean {
  const def = MODIFIERS.find((m) => m.id === id);
  if (!def || p.owned.includes(id) || p.merit < def.cost) return false;
  p.merit -= def.cost;
  p.owned.push(id);
  return true;
}

/**
 * Equip a loadout. Unknown or unowned ids are dropped; order follows the
 * canonical MODIFIERS order so the loadout is deterministic.
 */
export function setLoadout(p: ProfileData, ids: string[]): ProfileData {
  const want = new Set(ids.filter((id) => p.owned.includes(id)));
  p.loadout = MODIFIERS.map((m) => m.id).filter((id) => want.has(id));
  return p;
}

export function getLoadout(p: ProfileData): string[] {
  return [...p.loadout];
}

// ---------------------------------------------------------------------------
// applying the loadout to a run (config only — never the seed)
// ---------------------------------------------------------------------------

interface BaseSnapshot {
  health: number;
  speed: number;
  lives: number;
  /** pristine custom.weaponMods.rateOfFire (undefined when the spec ships without one) */
  rateOfFire: number | undefined;
}
const baseSnapshots = new WeakMap<object, BaseSnapshot>();

/**
 * Capture the pristine run config for a spec. Idempotent — the first call
 * wins. Blueprints call this at build time, BEFORE any run-time mutation
 * (level-up 'speed' upgrades do `spec.player.speed *= 1.12`, 'firerate'
 * upgrades stack `custom.weaponMods.rateOfFire`), so applyLoadout() always
 * restores the true base instead of a polluted one (M2).
 */
export function snapshotLoadoutBase(spec: GameSpec): void {
  if (baseSnapshots.has(spec)) return;
  baseSnapshots.set(spec, {
    health: spec.player.health,
    speed: spec.player.speed,
    lives: spec.rules.lives,
    rateOfFire: spec.custom?.weaponMods?.rateOfFire,
  });
}

/**
 * Apply the equipped loadout to a run's spec. Idempotent: pristine base
 * values are snapshotted (see snapshotLoadoutBase — blueprints capture them
 * at build, before any run-time mutation) and restored before every apply,
 * so repeated calls (restarts, title->run cycles) never compound bonuses.
 *
 * Restores every run-mutated stat: health/speed/lives AND
 * custom.weaponMods.rateOfFire (firerate upgrades used to stack permanently
 * across restarts while Progression counts reset — M2).
 *
 * Effects:
 *   vitality   -> player.health = base + 25
 *   swift      -> player.speed  = base * 1.08
 *   secondwind -> rules.lives   = base + 1
 *   power      -> custom.profileDamageMult = 1.10 (read by Progression.damageMult)
 */
export function applyLoadout(spec: GameSpec, p: ProfileData): void {
  // Safety net: if no blueprint snapshotted yet (e.g. direct calls in tests),
  // capture now. In-game the blueprint build always snapshots first, so this
  // never bakes run-time mutations into the base.
  snapshotLoadoutBase(spec);
  const base = baseSnapshots.get(spec)!;
  spec.player.health = base.health;
  spec.player.speed = base.speed;
  spec.rules.lives = base.lives;
  // run-mutated weapon mods: restore the pristine value (or remove the key
  // when the spec shipped without one) so firerate upgrades can't compound
  const custom = spec.custom ?? (spec.custom = {});
  if (base.rateOfFire === undefined) {
    if (custom.weaponMods) delete custom.weaponMods.rateOfFire;
  } else {
    (custom.weaponMods ?? (custom.weaponMods = {})).rateOfFire = base.rateOfFire;
  }

  const equipped = new Set(p.loadout.filter((id) => p.owned.includes(id)));
  if (equipped.has('vitality')) spec.player.health = Math.round(base.health + 25);
  if (equipped.has('swift')) spec.player.speed = base.speed * 1.08;
  if (equipped.has('secondwind')) spec.rules.lives = base.lives + 1;

  if (equipped.has('power')) custom.profileDamageMult = 1.1;
  else delete custom.profileDamageMult;
}

// ---------------------------------------------------------------------------
// daily challenge
// ---------------------------------------------------------------------------

/** Local calendar date as YYYY-MM-DD (local timezone — "today" for the player). */
export function todayLocalDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Deterministic daily seed from a YYYY-MM-DD string (FNV-1a 32-bit).
 * Same date -> same seed for everyone; different dates -> different seeds
 * with overwhelming probability. The seed feeds the run's RNG only.
 */
export function dailySeed(dateStr: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dateStr.length; i++) {
    h ^= dateStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
