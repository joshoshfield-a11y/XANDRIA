/**
 * Profile — cross-run progression persisted in localStorage.
 *
 * What persists across runs:
 *   - per-genre runs played / won, best score, best level reached
 *   - lifetime totals: kills, playtime
 *   - merit balance + purchased modifiers + equipped loadout
 *   - local daily-challenge bests (YYYY-MM-DD -> score)
 *   - local daily-challenge attempt results (UTC date -> result, first attempt wins)
 *   - tutorial 'seen' flag (tutorial wave: never replays once done/dismissed)
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
import { invalidateProgressionSpeedAnchor } from './Progression';
/**
 * UPGRADE LOOP (difficulty-modes): the player's difficulty mode lives in
 * the profile (player-scoped, persisted). isDifficultyId is a pure guard —
 * no import cycle (difficulty.ts imports nothing).
 */
import { isDifficultyId, type DifficultyId } from './difficulty';
/**
 * UPGRADE LOOP (save-slots): SettingsData is a type-only import (erased at
 * compile) — Settings.ts imports runtime functions from THIS module, so a
 * runtime import here would create an import cycle. Keep it type-only.
 */
import type { SettingsData } from './Settings';
/**
 * UPGRADE LOOP (accessibility-pass): keybinds, colorblind palette,
 * reduced motion, HUD text scale live in the profile (player-scoped,
 * persisted) so they survive reload and portal travel. Additive field —
 * missing keys default via validateAccessibilitySettings, no version bump.
 */
import {
  defaultAccessibilitySettings, validateAccessibilitySettings,
  type AccessibilitySettings,
} from './accessibility';

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

/**
 * UPGRADE LOOP (run-journal): one record per finished run, newest first.
 * Written observe-only through the run-completion path (Engine.recordRunResult
 * taps onWin/onLose — the achievement-hook pattern). Never drives gameplay.
 */
export interface RunJournalEntry {
  /** ISO 8601 UTC timestamp captured once at run start (never mid-run) */
  startUtc: string;
  /** run's world seed (daily-challenge runs record the challenge seed) */
  seed: number;
  genre: string;
  /** run length in seconds */
  duration: number;
  kills: number;
  deaths: number;
  /** portal traversals completed during the run */
  portals: number;
  /** total XP earned during the run */
  xpGained: number;
  bossesKilled: number;
  result: 'won' | 'lost';
}

/**
 * Stored journal cap (newest first). The journal UI lists the newest 20;
 * storage keeps JOURNAL_CAP so a long session never grows the profile
 * without bound.
 */
export const JOURNAL_CAP = 50;

/** Local daily-challenge attempt result (one per UTC date — first attempt wins). */
export interface DailyChallengeResult {
  score: number;
  kills: number;
  /** run length in seconds */
  timeSeconds: number;
  /** total player damage taken during the run */
  damageTaken: number;
  won: boolean;
  goalKind: string;
  goalTarget: number;
  genre: string;
  /** world seed the attempt played on */
  seed: number;
}


/** Local gauntlet attempt result (one per UTC date — best score wins). */
export interface GauntletResult {
  score: number;
  roundsCleared: number;
  kills: number;
  /** run length in seconds */
  timeSeconds: number;
  /** total player damage taken during the run */
  damageTaken: number;
  won: boolean;
  genre: string;
  /** gauntlet seed the attempt played on */
  seed: number;
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
  /** local gauntlet attempts: UTC YYYY-MM-DD -> result (best score wins) */
  gauntletResults: Record<string, GauntletResult>;
  /** all-time best gauntlet score */
  gauntletBest: number;
  /**
   * achievements wave: unlocked achievement ids (cross-run unlock store).
   * Additive field — missing keys default to [] via ...base, no version bump.
   */
  achievements: string[];
  /**
   * UPGRADE LOOP (difficulty-modes): the player's selected difficulty mode.
   * Player-scoped, persisted, survives portal travel and save/reload.
   * 'normal' is the identity mode (all multipliers 1.0).
   */
  difficulty: DifficultyId;
  /**
   * UPGRADE LOOP (new-game-plus): the player's prestige cycle. 0 = base
   * game (identity — no spawn scaling); N >= 1 = NG+N. Player-scoped,
   * persisted, survives portal travel and save/reload. Entering NG+
   * increments ONLY this field — gear, merit, achievements, difficulty,
   * bestiary, daily results and journal data are never touched by it.
   */
  ngPlusCycle: number;
  /** bestiary codex: enemy entry id -> lifetime kill count */
  bestiaryKills: Record<string, number>;
  /** local daily-challenge attempts: UTC YYYY-MM-DD -> result (first wins) */
  dailyResults: Record<string, DailyChallengeResult>;
  /**
   * run-journal wave: per-run records, newest first (see RunJournalEntry).
   * Additive field — missing keys default to [] via ...base, no version bump.
   */
  journal: RunJournalEntry[];
  /**
   * Tutorial wave: true once the first-run tutorial has been completed or
   * dismissed. Player-scoped; the tutorial never replays while this is set.
   */
  tutorialSeen: boolean;
  /** accessibility-pass settings (keybinds, palette, reduced motion, text scale) */
  accessibility: AccessibilitySettings;
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
    gauntletResults: {},
    gauntletBest: 0,
    achievements: [],
    difficulty: 'normal',
    ngPlusCycle: 0,
    bestiaryKills: {},
    dailyResults: {},
    journal: [],
    tutorialSeen: false,
    accessibility: defaultAccessibilitySettings(),
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
    gauntletResults: gauntletResultsRec(r.gauntletResults),
    gauntletBest: Math.max(0, Math.floor(num(r.gauntletBest))),
    // achievements wave: keep only ids from the live def table (stale ids
    // from retired achievements are dropped, like owned/loadout above).
    // The manager re-filters against ACHIEVEMENT_IDS on load as well.
    achievements: strArr(r.achievements),
    difficulty: isDifficultyId(r.difficulty) ? r.difficulty : 'normal',
    ngPlusCycle: Math.max(0, Math.floor(num(r.ngPlusCycle))),
    bestiaryKills: numRec(r.bestiaryKills),
    dailyResults: dailyResultsRec(r.dailyResults),
    // run-journal wave: cap + migrate malformed entries, never throw.
    journal: journalRec(r.journal),
    tutorialSeen: r.tutorialSeen === true,
    accessibility: validateAccessibilitySettings(r.accessibility),
  };
}

/** Validate the daily-results record; drop malformed entries, never throw. */
function dailyResultsRec(v: unknown): Record<string, DailyChallengeResult> {
  const out: Record<string, DailyChallengeResult> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const num = (x: unknown, d = 0) =>
    typeof x === 'number' && isFinite(x) ? x : d;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !x || typeof x !== 'object') continue;
    const e = x as Record<string, unknown>;
    out[k] = {
      score: Math.max(0, Math.floor(num(e.score))),
      kills: Math.max(0, Math.floor(num(e.kills))),
      timeSeconds: Math.max(0, num(e.timeSeconds)),
      damageTaken: Math.max(0, Math.floor(num(e.damageTaken))),
      won: e.won === true,
      goalKind: typeof e.goalKind === 'string' ? e.goalKind : '',
      goalTarget: Math.max(0, Math.floor(num(e.goalTarget))),
      genre: typeof e.genre === 'string' ? e.genre : '',
      seed: Math.max(0, Math.floor(num(e.seed))) >>> 0,
    };
  }
  return out;
}


/** Validate the gauntlet-results record; drop malformed entries, never throw. */
function gauntletResultsRec(v: unknown): Record<string, GauntletResult> {
  const out: Record<string, GauntletResult> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const num = (x: unknown, d = 0) =>
    typeof x === 'number' && isFinite(x) ? x : d;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !x || typeof x !== 'object') continue;
    const e = x as Record<string, unknown>;
    out[k] = {
      score: Math.max(0, Math.floor(num(e.score))),
      roundsCleared: Math.max(0, Math.floor(num(e.roundsCleared))),
      kills: Math.max(0, Math.floor(num(e.kills))),
      timeSeconds: Math.max(0, num(e.timeSeconds)),
      damageTaken: Math.max(0, Math.floor(num(e.damageTaken))),
      won: e.won === true,
      genre: typeof e.genre === 'string' ? e.genre : '',
      seed: Math.max(0, Math.floor(num(e.seed))) >>> 0,
    };
  }
  return out;
}

// NOTE (save-slots): loadProfile/saveProfile are defined in the save-slots
// section below — they target the active slot. Kept here as documentation
// only; do not re-add definitions (duplicate function error).

/**
 * Validate the stored run-journal list. Malformed entries are migrated
 * field-by-field (numbers clamped, strings coerced) or dropped when
 * unrecognizable; the list is capped at JOURNAL_CAP, newest first.
 * Never throws.
 */
function journalRec(v: unknown): RunJournalEntry[] {
  const out: RunJournalEntry[] = [];
  if (!Array.isArray(v)) return out;
  const num = (x: unknown, d = 0) =>
    typeof x === 'number' && isFinite(x) ? x : d;
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.startUtc !== 'string' || typeof e.genre !== 'string') continue;
    out.push({
      startUtc: e.startUtc,
      seed: Math.max(0, Math.floor(num(e.seed))) >>> 0,
      genre: e.genre,
      duration: Math.max(0, num(e.duration)),
      kills: Math.max(0, Math.floor(num(e.kills))),
      deaths: Math.max(0, Math.floor(num(e.deaths))),
      portals: Math.max(0, Math.floor(num(e.portals))),
      xpGained: Math.max(0, Math.floor(num(e.xpGained))),
      bossesKilled: Math.max(0, Math.floor(num(e.bossesKilled))),
      result: e.result === 'won' ? 'won' : 'lost',
    });
    if (out.length >= JOURNAL_CAP) break;
  }
  return out;
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


/**
 * Prepend a finished run's record to the journal (newest first). The list
 * is re-validated and capped at JOURNAL_CAP — callers pass the raw entry,
 * storage always holds a clean list. Never throws.
 */
export function recordJournalEntry(p: ProfileData, e: RunJournalEntry): ProfileData {
  p.journal = journalRec([e, ...p.journal]);
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
  // progression-curve: speed was rewritten from the pristine base — the
  // progression speed anchor must re-anchor to this loadout-final value.
  invalidateProgressionSpeedAnchor(spec);

  if (equipped.has('power')) custom.profileDamageMult = 1.1;
  else delete custom.profileDamageMult;
}

// ---------------------------------------------------------------------------
// daily challenge
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// save slots (UPGRADE LOOP: save-slots)
// ---------------------------------------------------------------------------
// Multiple named save slots. One storage key holds all slots plus the active
// slot id; each slot is an INDEPENDENT full profile + settings pair, so
// progress in one slot can never leak into another.
//
// Back-compat: loadProfile()/saveProfile() (used all over Engine.ts and the
// achievements/daily systems) keep working unchanged — they now transparently
// target the ACTIVE slot. No gameplay contracts change.
//
// Timestamps (createdAt/updatedAt) are wall-clock UI metadata only — never
// gameplay input. Determinism rule (seeded RNG for gameplay) is unaffected.

export const SLOTS_KEY = 'xandria.slots.v1';
/** Bump when the stored shape changes; normalizeSlotStore() handles old shapes. */
export const SLOTS_VERSION = 1;
/** Fresh players get this many named slots. */
export const DEFAULT_SLOT_COUNT = 3;
/** Hard cap — keeps the slot picker UI and the stored JSON sane. */
export const MAX_SLOTS = 8;
/** Display-name cap for renamed slots. */
export const MAX_SLOT_NAME_LENGTH = 24;
/** Legacy single-profile key (consumed once into 'Slot 1' by migration). */
const LEGACY_SETTINGS_KEY = 'xandria.settings.v1';

export interface SaveSlot {
  /** stable id, e.g. 'slot-1' — never reused, never shown raw in UI */
  id: string;
  /** user-visible name, renamable */
  name: string;
  /** the full cross-run profile (currency, achievements, bestiary, progression, daily results, ...) */
  profile: ProfileData;
  /** this slot's own settings (volume/mute/quality/perf tier) */
  settings: SettingsData;
  /** wall-clock metadata for the picker UI only — not gameplay */
  createdAt: number;
  updatedAt: number;
}

export interface SlotStore {
  version: number;
  activeSlotId: string;
  /** deterministic id source: next new slot is `slot-${nextSeq}` */
  nextSeq: number;
  slots: SaveSlot[];
}

/** UI-facing summary of one slot (no heavy profile data crosses the HUD seam). */
export interface SlotSummary {
  id: string;
  name: string;
  active: boolean;
  merit: number;
  runs: number;
  playtimeMin: number;
  updatedAt: number;
}

function makeSlot(id: string, name: string, profile: ProfileData, settings: SettingsData): SaveSlot {
  const now = Date.now();
  return { id, name, profile, settings, createdAt: now, updatedAt: now };
}

function freshSlotStore(): SlotStore {
  const slots: SaveSlot[] = [];
  for (let i = 0; i < DEFAULT_SLOT_COUNT; i++) {
    slots.push(
      makeSlot(`slot-${i + 1}`, `Slot ${i + 1}`, defaultProfile(), defaultSlotSettings()),
    );
  }
  return { version: SLOTS_VERSION, activeSlotId: 'slot-1', nextSeq: DEFAULT_SLOT_COUNT + 1, slots };
}

/** Migrate a legacy xandria.settings.v1 payload (or {}) into slot settings. */
function migrateLegacySettings(raw: unknown): SettingsData {
  const base = defaultSlotSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const vol = typeof r.volume === 'number' && isFinite(r.volume)
    ? Math.max(0, Math.min(1, r.volume)) : base.volume;
  const quality = r.quality === 'retro' || r.quality === 'standard' || r.quality === 'high' ? r.quality : 'auto';
  const tier = r.tier === 'desktop' || r.tier === 's25' ? r.tier : 'auto';
  // DAMAGE-NUMBERS: this normalizer also runs on every load of a current
  // store, so it must PRESERVE a stored floatingText:false — defaulting
  // here would silently re-enable the toggle on every reload.
  return { volume: vol, muted: r.muted === true, quality, tier, floatingText: r.floatingText !== false };
}

/**
 * One-shot migration: an existing single profile becomes 'Slot 1'.
 * Runs only when xandria.slots.v1 is absent. The legacy keys are left in
 * place (inert — the slots key takes precedence) so a failed write can never
 * destroy the only copy of the player's data.
 */
function migrateLegacyStore(): SlotStore | null {
  let rawProfile: string | null = null;
  let rawSettings: string | null = null;
  try {
    rawProfile = store().getItem(PROFILE_KEY);
    rawSettings = store().getItem(LEGACY_SETTINGS_KEY);
  } catch {
    return null;
  }
  if (!rawProfile && !rawSettings) return null;
  let profile = defaultProfile();
  if (rawProfile) {
    try { profile = migrateProfile(JSON.parse(rawProfile)); } catch { /* fresh profile */ }
  }
  let settings = defaultSlotSettings();
  if (rawSettings) {
    try { settings = migrateLegacySettings(JSON.parse(rawSettings)); } catch { /* defaults */ }
  }
  return {
    version: SLOTS_VERSION,
    activeSlotId: 'slot-1',
    nextSeq: 2,
    slots: [makeSlot('slot-1', 'Slot 1', profile, settings)],
  };
}

/** Validate + normalize a parsed slot store. Returns null when unrecoverable. */
function normalizeSlotStore(raw: unknown): SlotStore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === 'number' ? Math.floor(r.version) : 0;
  if (version > SLOTS_VERSION) return null; // from the future — don't trust it
  if (!Array.isArray(r.slots)) return null;
  const slots: SaveSlot[] = [];
  const seen = new Set<string>();
  for (const s of r.slots) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const e = s as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id ? e.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = sanitizeSlotName(e.name) || id;
    let profile = defaultProfile();
    try { profile = migrateProfile(e.profile); } catch { /* fresh profile */ }
    let settings = defaultSlotSettings();
    try { settings = migrateLegacySettings(e.settings); } catch { /* defaults */ }
    slots.push({
      id, name, profile, settings,
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
    });
  }
  if (slots.length === 0) return null; // a store with zero slots is data loss — refuse it
  const activeSlotId = typeof r.activeSlotId === 'string' && seen.has(r.activeSlotId)
    ? r.activeSlotId : slots[0].id;
  const nextSeq = typeof r.nextSeq === 'number' && isFinite(r.nextSeq) && r.nextSeq >= 1
    ? Math.floor(r.nextSeq) : slots.length + 1;
  return { version: SLOTS_VERSION, activeSlotId, nextSeq, slots };
}

export function loadSlots(): SlotStore {
  try {
    const raw = store().getItem(SLOTS_KEY);
    if (!raw) {
      const migrated = migrateLegacyStore();
      if (migrated) { saveSlots(migrated); return migrated; }
      const fresh = freshSlotStore();
      saveSlots(fresh);
      return fresh;
    }
    return normalizeSlotStore(JSON.parse(raw)) ?? freshSlotStore();
  } catch {
    return freshSlotStore();
  }
}

export function saveSlots(s: SlotStore): void {
  try {
    store().setItem(SLOTS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — slots still apply for this session */
  }
}

/** The active slot (falls back to the first slot when the id is stale). */
export function getActiveSlot(s?: SlotStore): SaveSlot {
  const st = s ?? loadSlots();
  return st.slots.find((x) => x.id === st.activeSlotId) ?? st.slots[0];
}

export function getActiveSlotId(): string {
  return getActiveSlot().id;
}

/** Switch the active slot. Returns false when the id is unknown. */
export function setActiveSlotId(id: string): boolean {
  const st = loadSlots();
  if (!st.slots.some((s) => s.id === id)) return false;
  st.activeSlotId = id;
  saveSlots(st);
  return true;
}

export function listSlots(): SaveSlot[] {
  return loadSlots().slots;
}

export function slotSummaries(): SlotSummary[] {
  const st = loadSlots();
  return st.slots.map((s) => ({
    id: s.id,
    name: s.name,
    active: s.id === st.activeSlotId,
    merit: s.profile.merit,
    runs: Object.values(s.profile.runsPlayed).reduce((a, b) => a + (b || 0), 0),
    playtimeMin: Math.floor(Math.max(0, s.profile.totalPlaytime) / 60),
    updatedAt: s.updatedAt,
  }));
}

function sanitizeSlotName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_SLOT_NAME_LENGTH);
}

/**
 * Create a fresh slot with a default profile. The new slot becomes active
 * (the "new game" flow). Returns null at the slot cap.
 */
export function createSlot(name?: string): SaveSlot | null {
  const st = loadSlots();
  if (st.slots.length >= MAX_SLOTS) return null;
  const id = `slot-${st.nextSeq++}`;
  const slot = makeSlot(
    id,
    sanitizeSlotName(name) || `Slot ${st.slots.length + 1}`,
    defaultProfile(),
    defaultSlotSettings(),
  );
  st.slots.push(slot);
  st.activeSlotId = id;
  saveSlots(st);
  return slot;
}

/** Rename a slot. Returns false for unknown ids or blank names. */
export function renameSlot(id: string, name: string): boolean {
  const st = loadSlots();
  const slot = st.slots.find((s) => s.id === id);
  if (!slot) return false;
  const clean = sanitizeSlotName(name);
  if (!clean) return false;
  slot.name = clean;
  slot.updatedAt = Date.now();
  saveSlots(st);
  return true;
}

/**
 * Delete a slot. The last remaining slot can never be deleted (a player
 * always has somewhere to save). Deleting the active slot activates a
 * neighbour. Returns false when refused.
 */
export function deleteSlot(id: string): boolean {
  const st = loadSlots();
  if (st.slots.length <= 1) return false;
  const idx = st.slots.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  st.slots.splice(idx, 1);
  if (st.activeSlotId === id) {
    st.activeSlotId = st.slots[Math.min(idx, st.slots.length - 1)].id;
  }
  saveSlots(st);
  return true;
}

// ---------------------------------------------------------------------------
// active-slot compatibility: loadProfile/saveProfile now target the active slot
// ---------------------------------------------------------------------------

/** Load the ACTIVE slot's profile (back-compat for all existing callers). */
export function loadProfile(): ProfileData {
  return getActiveSlot().profile;
}

/**
 * Save into the ACTIVE slot's profile. Targets the currently active slot —
 * callers must not hold a profile across a slot switch.
 */
export function saveProfile(p: ProfileData): void {
  try {
    const st = loadSlots();
    const active = getActiveSlot(st);
    active.profile = { ...p, version: PROFILE_VERSION };
    active.updatedAt = Date.now();
    saveSlots(st);
  } catch {
    /* storage unavailable — the in-memory profile still applies this session */
  }
}

// ---------------------------------------------------------------------------
// per-slot settings (UPGRADE LOOP: save-slots)
// ---------------------------------------------------------------------------

/** The active slot's settings, merged over defaults. */
export function loadSlotSettings(): SettingsData {
  return { ...defaultSlotSettings(), ...getActiveSlot().settings };
}

/** Persist settings into the active slot. */
export function saveSlotSettings(s: SettingsData): void {
  try {
    const st = loadSlots();
    getActiveSlot(st).settings = { ...s };
    saveSlots(st);
  } catch {
    /* storage unavailable — settings still apply for this session */
  }
}

/**
 * Canonical per-slot settings defaults. Lives here (not in Settings.ts) so
 * Profile.ts needs no runtime import of Settings.ts — Settings.ts imports
 * runtime functions from THIS module, so the reverse direction would be an
 * import cycle. Settings.ts merges these over its own defaults anyway.
 */
function defaultSlotSettings(): SettingsData {
  return { volume: 0.8, muted: false, quality: 'auto', tier: 'auto', floatingText: true };
}

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
