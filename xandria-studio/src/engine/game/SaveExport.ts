/**
 * Save-slot export / import (UPGRADE LOOP: save-export-import).
 *
 * A backup is one save slot serialized to a JSON file:
 *
 *   { format: 'xandria-save-slot', schemaVersion: 1, exportedAt: <ms>,
 *     slot: { name, profile, settings, ironman, dead } }
 *
 * Export is a pure serialization of the stored slot — every profile
 * section rides along (currency, owned/equipped modifiers, per-genre
 * progression, achievements, bestiary, difficulty, NG+ cycle, daily +
 * gauntlet results, run journal, tutorial flag, accessibility, companions,
 * cosmetics, camp, mounts) plus the slot's own settings. Quest *state*
 * is not persisted anywhere today (portal snapshots only — see the
 * save-slots REPORT), so there is no quest section to export; anything a
 * future phase adds to ProfileData is exported automatically because the
 * whole profile object is serialized.
 *
 * Import is STRICT, unlike the lenient migrateProfile() path that loads
 * the live store: a backup must carry the right format + schema version,
 * every required section, and in-range values, or the whole file is
 * rejected with a human-readable reason. A rejected file never touches
 * the stored slots, and import never overwrites in place — the backup
 * always lands as a NEW slot (name collisions auto-suffixed). Nothing in
 * this module throws: every entry point returns a result object, and
 * unexpected exceptions are caught and reported as errors.
 *
 * Serialization only — no gameplay RNG, no behavior contracts changed.
 */

import { isDifficultyId } from './difficulty';
import {
  getActiveSlot,
  loadSlots,
  migrateProfile,
  saveSlots,
  MAX_SLOTS,
  MAX_SLOT_NAME_LENGTH,
  PROFILE_VERSION,
  JOURNAL_CAP,
  MODIFIER_IDS,
  appendSlot,
  type ProfileData,
  type SaveSlot,
} from './Profile';
import type { SettingsData } from './Settings';
import {
  isColorblindPalette,
  validateAccessibilitySettings,
} from './accessibility';
import { validateCosmetics } from './cosmetics';

/** Backup file marker — a file without it is not a save backup. */
export const EXPORT_FORMAT = 'xandria-save-slot';
/** Bump when the backup shape changes; parseSaveExport rejects anything else. */
export const EXPORT_SCHEMA_VERSION = 1;
/** Backups bigger than this are refused outright (a real slot is ~tens of KB). */
export const MAX_EXPORT_BYTES = 1_000_000;

export interface SaveExportSlot {
  name: string;
  profile: ProfileData;
  settings: SettingsData;
  ironman: boolean;
  dead: boolean;
}

export interface SaveExportFile {
  format: string;
  schemaVersion: number;
  exportedAt: number;
  slot: SaveExportSlot;
}

export type ParseResult =
  | { ok: true; file: SaveExportFile }
  | { ok: false; error: string };

export type ImportResult =
  | { ok: true; slot: SaveSlot }
  | { ok: false; error: string };

export interface ExportedSlot {
  filename: string;
  text: string;
}

const QUALITIES = ['auto', 'retro', 'standard', 'high'];
const TIERS = ['auto', 'desktop', 's25'];
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && isFinite(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

/** Non-negative integer (counts, scores, kills, merit). */
function isCount(v: unknown): v is number {
  return isInt(v) && v >= 0;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/** Serialize one stored slot to its backup JSON text (pretty-printed). */
export function serializeSlot(slot: SaveSlot): string {
  const file: SaveExportFile = {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    slot: {
      name: slot.name,
      profile: slot.profile,
      settings: slot.settings,
      ironman: slot.ironman === true,
      dead: slot.dead === true,
    },
  };
  return JSON.stringify(file, null, 2);
}

/** Download filename for a slot backup, e.g. `xandria-slot-backup-v1-my-run.json`. */
export function exportFileName(slot: SaveSlot): string {
  const slug = slot.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'slot';
  return `xandria-slot-backup-v${EXPORT_SCHEMA_VERSION}-${slug}.json`;
}

/** Serialize the ACTIVE slot for download. Never throws. */
export function serializeActiveSlot(): ExportedSlot {
  const slot = getActiveSlot();
  return { filename: exportFileName(slot), text: serializeSlot(slot) };
}

// ---------------------------------------------------------------------------
// strict validation (import path — rejects, never coerces silently)
// ---------------------------------------------------------------------------

function validateNumberRecord(
  v: unknown, label: string, integer: boolean,
): string | null {
  if (!isObj(v)) return `${label} must be an object`;
  for (const [k, x] of Object.entries(v)) {
    if (integer ? !isCount(x) : !(isNum(x) && x >= 0)) {
      return `${label}.${k} must be a ${integer ? 'non-negative integer' : 'non-negative number'}`;
    }
  }
  return null;
}

function validateStringArray(v: unknown, label: string): string | null {
  if (!Array.isArray(v)) return `${label} must be an array`;
  for (const x of v) {
    if (typeof x !== 'string' || x.length === 0) return `${label} must contain only non-empty strings`;
  }
  if (new Set(v).size !== v.length) return `${label} must not contain duplicates`;
  return null;
}

function validateResultRecord(
  v: unknown, label: string, fields: Record<string, 'count' | 'num' | 'bool' | 'str' | 'seed'>,
): string | null {
  if (!isObj(v)) return `${label} must be an object`;
  for (const [k, e] of Object.entries(v)) {
    if (!DATE_KEY.test(k)) return `${label} has an invalid date key "${k}" (expected YYYY-MM-DD)`;
    if (!isObj(e)) return `${label}.${k} must be an object`;
    for (const [f, kind] of Object.entries(fields)) {
      const x = e[f];
      if (kind === 'count' && !isCount(x)) return `${label}.${k}.${f} must be a non-negative integer`;
      if (kind === 'num' && !(isNum(x) && x >= 0)) return `${label}.${k}.${f} must be a non-negative number`;
      if (kind === 'bool' && typeof x !== 'boolean') return `${label}.${k}.${f} must be a boolean`;
      if (kind === 'str' && typeof x !== 'string') return `${label}.${k}.${f} must be a string`;
      if (kind === 'seed' && !(isInt(x) && x >= 0 && x <= 0xffffffff)) return `${label}.${k}.${f} must be a 32-bit seed`;
    }
  }
  return null;
}

function validateJournal(v: unknown): string | null {
  if (!Array.isArray(v)) return 'profile.journal must be an array';
  if (v.length > JOURNAL_CAP) return `profile.journal must hold at most ${JOURNAL_CAP} entries`;
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (!isObj(e)) return `profile.journal[${i}] must be an object`;
    if (typeof e.startUtc !== 'string' || e.startUtc.length === 0) return `profile.journal[${i}].startUtc must be a non-empty string`;
    if (typeof e.genre !== 'string' || e.genre.length === 0) return `profile.journal[${i}].genre must be a non-empty string`;
    if (!(isInt(e.seed) && e.seed >= 0 && e.seed <= 0xffffffff)) return `profile.journal[${i}].seed must be a 32-bit seed`;
    for (const f of ['duration']) if (!(isNum(e[f]) && e[f] >= 0)) return `profile.journal[${i}].${f} must be a non-negative number`;
    for (const f of ['kills', 'deaths', 'portals', 'xpGained', 'bossesKilled']) {
      if (!isCount(e[f])) return `profile.journal[${i}].${f} must be a non-negative integer`;
    }
    if (e.result !== 'won' && e.result !== 'lost') return `profile.journal[${i}].result must be "won" or "lost"`;
    if (e.ironman !== undefined && typeof e.ironman !== 'boolean') return `profile.journal[${i}].ironman must be a boolean`;
  }
  return null;
}

function validateAccessibility(v: unknown): string | null {
  if (!isObj(v)) return 'profile.accessibility must be an object';
  if (!isObj(v.keybinds)) return 'profile.accessibility.keybinds must be an object';
  for (const [k, x] of Object.entries(v.keybinds)) {
    if (typeof x !== 'string' || x.length === 0) return `profile.accessibility.keybinds.${k} must be a non-empty string`;
  }
  if (!isColorblindPalette(v.colorblind)) return 'profile.accessibility.colorblind must be a known palette';
  if (typeof v.reducedMotion !== 'boolean') return 'profile.accessibility.reducedMotion must be a boolean';
  if (!(isNum(v.hudTextScale) && v.hudTextScale >= 0.85 && v.hudTextScale <= 1.5)) {
    return 'profile.accessibility.hudTextScale must be between 0.85 and 1.5';
  }
  return null;
}

function validateCompanions(v: unknown): string | null {
  if (v === null) return null;
  if (!isObj(v)) return 'profile.companions must be null or an object';
  if (!(v.activeId === null || (typeof v.activeId === 'string' && v.activeId.length > 0))) {
    return 'profile.companions.activeId must be null or a non-empty string';
  }
  if (!Array.isArray(v.roster)) return 'profile.companions.roster must be an array';
  for (let i = 0; i < v.roster.length; i++) {
    const c = v.roster[i];
    if (!isObj(c)) return `profile.companions.roster[${i}] must be an object`;
    if (typeof c.defId !== 'string' || c.defId.length === 0) return `profile.companions.roster[${i}].defId must be a non-empty string`;
    if (typeof c.name !== 'string') return `profile.companions.roster[${i}].name must be a string`;
    if (!(isNum(c.hp) && c.hp >= 0)) return `profile.companions.roster[${i}].hp must be a non-negative number`;
  }
  return null;
}

function validateCosmeticsShape(v: unknown): string | null {
  if (!isObj(v)) return 'profile.cosmetics must be an object';
  for (const f of ['visor', 'outfit', 'trim']) {
    if (!(v[f] === null || typeof v[f] === 'string')) return `profile.cosmetics.${f} must be a string or null`;
  }
  for (const f of ['scarf', 'hood']) {
    if (typeof v[f] !== 'boolean') return `profile.cosmetics.${f} must be a boolean`;
  }
  return null;
}

function validateMounts(v: unknown): string | null {
  if (!isObj(v)) return 'profile.mounts must be an object';
  if (!(v.active === null || typeof v.active === 'string')) return 'profile.mounts.active must be a string or null';
  return validateNumberRecord(v.stamina, 'profile.mounts.stamina', false);
}

function validateCampBuilt(v: unknown): string | null {
  if (!isObj(v)) return 'profile.campBuilt must be an object';
  for (const [k, x] of Object.entries(v)) {
    if (!Array.isArray(x)) return `profile.campBuilt.${k} must be an array`;
    for (const s of x) if (typeof s !== 'string') return `profile.campBuilt.${k} must contain only strings`;
  }
  return null;
}

/** Every ProfileData field must be present and in range. Returns an error string or null. */
function validateProfile(raw: unknown): string | null {
  if (!isObj(raw)) return 'slot.profile must be an object';
  const p = raw;
  const required = [
    'version', 'merit', 'owned', 'loadout', 'runsPlayed', 'runsWon',
    'bestScore', 'bestLevel', 'totalKills', 'totalPlaytime', 'dailyBest',
    'gauntletResults', 'gauntletBest', 'achievements', 'difficulty',
    'ngPlusCycle', 'bestiaryKills', 'dailyResults', 'journal',
    'tutorialSeen', 'accessibility', 'companions', 'cosmetics',
    'campChest', 'campBuilt', 'mounts',
  ];
  for (const k of required) {
    if (!(k in p)) return `slot.profile is missing required section "${k}"`;
  }
  if (!(isInt(p.version) && p.version >= 1 && p.version <= PROFILE_VERSION)) {
    return `slot.profile.version ${JSON.stringify(p.version)} is not supported (expected 1..${PROFILE_VERSION})`;
  }
  if (!isCount(p.merit)) return 'slot.profile.merit must be a non-negative integer';
  let err = validateStringArray(p.owned, 'slot.profile.owned');
  if (err) return err;
  for (const id of p.owned as string[]) {
    if (!MODIFIER_IDS.includes(id)) return `slot.profile.owned contains unknown modifier "${id}"`;
  }
  err = validateStringArray(p.loadout, 'slot.profile.loadout');
  if (err) return err;
  const ownedSet = new Set(p.owned as string[]);
  for (const id of p.loadout as string[]) {
    if (!ownedSet.has(id)) return `slot.profile.loadout contains unowned modifier "${id}"`;
  }
  for (const [label, integer] of [
    ['slot.profile.runsPlayed', true], ['slot.profile.runsWon', true],
    ['slot.profile.bestScore', true], ['slot.profile.bestLevel', true],
    ['slot.profile.dailyBest', true], ['slot.profile.bestiaryKills', true],
  ] as const) {
    err = validateNumberRecord(p[label.split('.')[2] as string], label, integer);
    if (err) return err;
  }
  if (!isCount(p.totalKills)) return 'slot.profile.totalKills must be a non-negative integer';
  if (!(isNum(p.totalPlaytime) && p.totalPlaytime >= 0)) return 'slot.profile.totalPlaytime must be a non-negative number';
  err = validateResultRecord(p.gauntletResults, 'slot.profile.gauntletResults', {
    score: 'count', roundsCleared: 'count', kills: 'count', timeSeconds: 'num',
    damageTaken: 'count', won: 'bool', genre: 'str', seed: 'seed',
  });
  if (err) return err;
  if (!isCount(p.gauntletBest)) return 'slot.profile.gauntletBest must be a non-negative integer';
  err = validateStringArray(p.achievements, 'slot.profile.achievements');
  if (err) return err;
  if (!isDifficultyId(p.difficulty)) return 'slot.profile.difficulty must be a known difficulty mode';
  if (!isCount(p.ngPlusCycle)) return 'slot.profile.ngPlusCycle must be a non-negative integer';
  err = validateResultRecord(p.dailyResults, 'slot.profile.dailyResults', {
    score: 'count', kills: 'count', timeSeconds: 'num', damageTaken: 'count',
    won: 'bool', goalKind: 'str', goalTarget: 'count', genre: 'str', seed: 'seed',
  });
  if (err) return err;
  err = validateJournal(p.journal);
  if (err) return err;
  if (typeof p.tutorialSeen !== 'boolean') return 'slot.profile.tutorialSeen must be a boolean';
  err = validateAccessibility(p.accessibility);
  if (err) return err;
  err = validateCompanions(p.companions);
  if (err) return err;
  err = validateCosmeticsShape(p.cosmetics);
  if (err) return err;
  err = validateNumberRecord(p.campChest, 'slot.profile.campChest', true);
  if (err) return err;
  err = validateCampBuilt(p.campBuilt);
  if (err) return err;
  err = validateMounts(p.mounts);
  if (err) return err;
  return null;
}

/** Every SettingsData field must be present and in range. Returns an error string or null. */
function validateSettings(raw: unknown): string | null {
  if (!isObj(raw)) return 'slot.settings must be an object';
  const required = [
    'volume', 'muted', 'musicEnabled', 'sfxEnabled', 'musicVolume',
    'sfxVolume', 'quality', 'tier', 'floatingText',
  ];
  for (const k of required) {
    if (!(k in raw)) return `slot.settings is missing required section "${k}"`;
  }
  for (const f of ['volume', 'musicVolume', 'sfxVolume']) {
    if (!(isNum(raw[f]) && raw[f] >= 0 && raw[f] <= 1)) return `slot.settings.${f} must be between 0 and 1`;
  }
  for (const f of ['muted', 'musicEnabled', 'sfxEnabled', 'floatingText']) {
    if (typeof raw[f] !== 'boolean') return `slot.settings.${f} must be a boolean`;
  }
  if (!QUALITIES.includes(raw.quality as string)) return 'slot.settings.quality must be a known quality setting';
  if (!TIERS.includes(raw.tier as string)) return 'slot.settings.tier must be a known perf tier';
  return null;
}

/**
 * Parse + strictly validate backup text. Never throws; malformed input
 * yields { ok: false, error } with a plain-language reason.
 */
export function parseSaveExport(text: unknown): ParseResult {
  try {
    if (typeof text !== 'string') return fail('Backup must be JSON text');
    if (text.length === 0) return fail('Backup file is empty');
    if (text.length > MAX_EXPORT_BYTES) {
      return fail(`Backup file is too large (${text.length} bytes, max ${MAX_EXPORT_BYTES})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('Backup file is not valid JSON (truncated or malformed)');
    }
    if (!isObj(parsed)) return fail('Backup must be a JSON object');
    if (parsed.format === undefined) return fail('Backup is missing the format marker — not a XANDRIA save backup');
    if (parsed.format !== EXPORT_FORMAT) return fail(`Backup format "${String(parsed.format)}" is not recognized (expected "${EXPORT_FORMAT}")`);
    if (parsed.schemaVersion === undefined) return fail('Backup is missing the schema version');
    if (parsed.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      return fail(`Backup schema version ${JSON.stringify(parsed.schemaVersion)} is not supported (expected ${EXPORT_SCHEMA_VERSION})`);
    }
    if (!(isNum(parsed.exportedAt) && parsed.exportedAt >= 0)) return fail('Backup exportedAt must be a non-negative number');
    if (!isObj(parsed.slot)) return fail('Backup is missing the slot section');
    const slot = parsed.slot;
    if (typeof slot.name !== 'string') return fail('Backup slot name must be a string');
    const name = slot.name.trim().replace(/\s+/g, ' ');
    if (name.length === 0) return fail('Backup slot name must not be empty');
    if (name.length > MAX_SLOT_NAME_LENGTH) {
      return fail(`Backup slot name is too long (${name.length} characters, max ${MAX_SLOT_NAME_LENGTH})`);
    }
    const profileErr = validateProfile(slot.profile);
    if (profileErr) return fail(profileErr);
    const settingsErr = validateSettings(slot.settings);
    if (settingsErr) return fail(settingsErr);
    if (slot.ironman !== undefined && typeof slot.ironman !== 'boolean') return fail('Backup slot ironman flag must be a boolean');
    if (slot.dead !== undefined && typeof slot.dead !== 'boolean') return fail('Backup slot dead flag must be a boolean');
    // Normalize through the same migrations the live store uses, so the
    // imported slot is canonical (unknown cosmetic ids drop to defaults,
    // keybind conflicts resolve deterministically). Validation above has
    // already established every value is in range, so this cannot change
    // a valid backup's meaning — it only canonicalizes it.
    const profile = migrateProfile(slot.profile);
    const rawSettings = slot.settings as Record<string, unknown>;
    const settings: SettingsData = {
      volume: rawSettings.volume as number,
      muted: rawSettings.muted as boolean,
      musicEnabled: rawSettings.musicEnabled as boolean,
      sfxEnabled: rawSettings.sfxEnabled as boolean,
      musicVolume: rawSettings.musicVolume as number,
      sfxVolume: rawSettings.sfxVolume as number,
      quality: rawSettings.quality as SettingsData['quality'],
      tier: rawSettings.tier as SettingsData['tier'],
      floatingText: rawSettings.floatingText as boolean,
    };
    const rawProfile = slot.profile as Record<string, unknown>;
    profile.accessibility = validateAccessibilitySettings(rawProfile.accessibility);
    profile.cosmetics = validateCosmetics(rawProfile.cosmetics);
    const file: SaveExportFile = {
      format: EXPORT_FORMAT,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: parsed.exportedAt as number,
      slot: {
        name,
        profile,
        settings,
        ironman: slot.ironman === true,
        dead: slot.dead === true,
      },
    };
    return { ok: true, file };
  } catch {
    return fail('Backup could not be read (unexpected error while parsing)');
  }
}

/**
 * Pick a free display name: the backup's name, or the name with a
 * " (2)", " (3)", ... suffix when it collides, truncated to fit the
 * 24-character cap. Pure — takes the names already in use.
 */
export function uniqueSlotName(base: string, taken: string[]): string {
  const clean = base.trim().replace(/\s+/g, ' ');
  const used = new Set(taken);
  if (!used.has(clean)) return clean;
  for (let n = 2; n < 100; n++) {
    const suffix = ` (${n})`;
    const candidate = (clean.slice(0, MAX_SLOT_NAME_LENGTH - suffix.length) + suffix)
      .trimEnd();
    if (!used.has(candidate)) return candidate;
  }
  return clean.slice(0, MAX_SLOT_NAME_LENGTH);
}

/**
 * Import a backup: validate strictly, then append it as a NEW slot
 * (never overwrites in place). The new slot becomes active, matching
 * createSlot's "new game" flow. On any failure the stored slots are
 * left byte-for-byte untouched. Never throws.
 */
export function importSaveExport(text: unknown): ImportResult {
  try {
    const parsed = parseSaveExport(text);
    if (!parsed.ok) return parsed;
    const store = loadSlots();
    if (store.slots.length >= MAX_SLOTS) {
      return fail(`Save slot list is full (${MAX_SLOTS} slots) — delete a slot before importing`);
    }
    const name = uniqueSlotName(parsed.file.slot.name, store.slots.map((s) => s.name));
    const slot = appendSlot(
      name,
      parsed.file.slot.profile,
      parsed.file.slot.settings,
      parsed.file.slot.ironman,
      parsed.file.slot.dead,
    );
    if (!slot) return fail(`Save slot list is full (${MAX_SLOTS} slots) — delete a slot before importing`);
    return { ok: true, slot };
  } catch {
    return fail('Backup could not be imported (unexpected error)');
  }
}
