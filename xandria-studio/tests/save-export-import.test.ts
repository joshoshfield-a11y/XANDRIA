/**
 * UPGRADE LOOP (save-export-import): JSON backup export/import —
 * serialization round-trip, strict validation rejections, new-slot
 * landing, name collisions, slot cap, and no-corruption guarantees.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _setProfileStorage,
  createSlot,
  getActiveSlot,
  listSlots,
  loadSlots,
  saveSlots,
  SLOTS_KEY,
  type SaveSlot,
} from '../src/engine/game/Profile';
import {
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  exportFileName,
  importSaveExport,
  parseSaveExport,
  serializeActiveSlot,
  serializeSlot,
  uniqueSlotName,
} from '../src/engine/game/SaveExport';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    _map: m,
  };
}

let mem: ReturnType<typeof memStore>;
beforeEach(() => {
  mem = memStore();
  _setProfileStorage(mem);
});

function rawStore(): string {
  return mem._map.get(SLOTS_KEY)!;
}

/** A rich, fully-populated slot: every profile section + settings exercised. */
function richSlot(): SaveSlot {
  // Persist through the store so serializeActiveSlot()/import re-reads
  // see the same values (getActiveSlot() re-parses storage every call).
  const st = loadSlots();
  const slot = st.slots.find((s) => s.id === st.activeSlotId)!;
  const p = slot.profile;
  p.merit = 77;
  p.owned = ['vitality', 'power'];
  p.loadout = ['vitality'];
  p.runsPlayed = { 'third-person-action': 3 };
  p.runsWon = { 'third-person-action': 1 };
  p.bestScore = { 'third-person-action': 1234 };
  p.bestLevel = { 'third-person-action': 5 };
  p.totalKills = 42;
  p.totalPlaytime = 3600.5;
  p.dailyBest = { '2026-10-26': 900 };
  p.gauntletResults = {
    '2026-10-26': {
      score: 500, roundsCleared: 3, kills: 20, timeSeconds: 120,
      damageTaken: 10, won: true, genre: 'survivor', seed: 12345,
    },
  };
  p.gauntletBest = 500;
  p.achievements = ['first-blood', 'hunter-10'];
  p.difficulty = 'hard';
  p.ngPlusCycle = 2;
  p.bestiaryKills = { ember: 9 };
  p.dailyResults = {
    '2026-10-26': {
      score: 10, kills: 5, timeSeconds: 60, damageTaken: 0, won: true,
      goalKind: 'kills', goalTarget: 5, genre: 'survivor', seed: 1,
    },
  };
  p.journal = [{
    startUtc: '2026-10-26T10:00:00.000Z', seed: 99, genre: 'survivor',
    duration: 60, kills: 5, deaths: 0, portals: 1, xpGained: 30,
    bossesKilled: 0, result: 'won', ironman: false,
  }];
  p.tutorialSeen = true;
  p.accessibility = { keybinds: {}, colorblind: 'none', reducedMotion: true, hudTextScale: 1.2 };
  p.companions = { activeId: null, roster: [] };
  p.cosmetics = { visor: null, outfit: null, scarf: true, hood: false, trim: null };
  p.campChest = { iron: 4 };
  p.campBuilt = { '12345': ['tent'] };
  p.mounts = { active: null, stamina: {} };
  slot.settings = {
    volume: 0.5, muted: true, quality: 'retro', tier: 's25', floatingText: false,
    musicEnabled: false, sfxEnabled: true, musicVolume: 0.3, sfxVolume: 0.6,
  };
  slot.ironman = true;
  saveSlots(st);
  return slot;
}

function mutateBackup(text: string, fn: (doc: any) => void): string {
  const doc = JSON.parse(text);
  fn(doc);
  return JSON.stringify(doc);
}

describe('export', () => {
  it('serializes the active slot with format, schema version, and all sections', () => {
    const slot = richSlot();
    const text = serializeSlot(slot);
    const doc = JSON.parse(text);
    expect(doc.format).toBe(EXPORT_FORMAT);
    expect(doc.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(typeof doc.exportedAt).toBe('number');
    expect(doc.slot.name).toBe(slot.name);
    expect(doc.slot.profile.merit).toBe(77);
    expect(doc.slot.profile.achievements).toEqual(['first-blood', 'hunter-10']);
    expect(doc.slot.profile.bestiaryKills).toEqual({ ember: 9 });
    expect(doc.slot.profile.difficulty).toBe('hard');
    expect(doc.slot.profile.ngPlusCycle).toBe(2);
    expect(doc.slot.profile.dailyResults['2026-10-26'].score).toBe(10);
    expect(doc.slot.profile.gauntletBest).toBe(500);
    expect(doc.slot.profile.journal).toHaveLength(1);
    expect(doc.slot.profile.campChest).toEqual({ iron: 4 });
    expect(doc.slot.settings).toMatchObject({ volume: 0.5, muted: true, tier: 's25' });
    expect(doc.slot.ironman).toBe(true);
    expect(doc.slot.dead).toBe(false);
  });

  it('serializeActiveSlot + filename slug the active slot name', () => {
    richSlot();
    const { filename, text } = serializeActiveSlot();
    expect(filename).toMatch(/^xandria-slot-backup-v1-slot-1\.json$/);
    expect(JSON.parse(text).slot.profile.merit).toBe(77);
    expect(exportFileName({ ...getActiveSlot(), name: 'My Run!' } as SaveSlot))
      .toBe('xandria-slot-backup-v1-my-run.json');
  });
});

describe('parse: round-trip', () => {
  it('a rich backup parses back with profile and settings identical', () => {
    const slot = richSlot();
    const parsed = parseSaveExport(serializeSlot(slot));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.slot.profile).toEqual(slot.profile);
    expect(parsed.file.slot.settings).toEqual(slot.settings);
    expect(parsed.file.slot.ironman).toBe(true);
    expect(parsed.file.slot.dead).toBe(false);
  });

  it('a default fresh-slot backup round-trips', () => {
    const parsed = parseSaveExport(serializeSlot(getActiveSlot()));
    expect(parsed.ok).toBe(true);
  });
});

describe('parse: strict rejection', () => {
  const good = () => serializeSlot(richSlot());

  it.each([
    ['empty string', ''],
    ['plain text', 'hello'],
    ['truncated JSON', '{"format": "xandria-save-slot", "schemaVersion": 1, "slot":'],
    ['JSON array', '[]'],
    ['JSON number', '42'],
    ['JSON null', 'null'],
  ])('rejects %s', (_label, text) => {
    const r = parseSaveExport(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it('never throws on non-string input', () => {
    for (const v of [null, undefined, 42, true, [], {}, Symbol('x') as unknown]) {
      expect(() => parseSaveExport(v)).not.toThrow();
      expect(parseSaveExport(v).ok).toBe(false);
    }
  });

  it('rejects wrong format, missing format, and wrong/missing schema version', () => {
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.format = 'other'; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.format; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.schemaVersion = 2; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.schemaVersion = '1'; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.schemaVersion; })).ok).toBe(false);
    const r = parseSaveExport(mutateBackup(good(), (d) => { d.schemaVersion = 99; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('99');
  });

  it('rejects a missing slot section and missing profile/settings sections', () => {
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.slot; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.slot.profile; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.slot.settings; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.slot.profile.merit; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.slot.profile.achievements; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { delete d.slot.settings.volume; })).ok).toBe(false);
  });

  it('rejects empty, blank, and over-long slot names', () => {
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.slot.name = ''; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.slot.name = '   '; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.slot.name = 'x'.repeat(25); })).ok).toBe(false);
  });

  it('rejects out-of-range and wrong-typed profile values', () => {
    const cases: Array<(d: any) => void> = [
      (d) => { d.slot.profile.merit = -1; },
      (d) => { d.slot.profile.merit = 1.5; },
      (d) => { d.slot.profile.merit = '77'; },
      (d) => { d.slot.profile.totalKills = -5; },
      (d) => { d.slot.profile.totalPlaytime = -1; },
      (d) => { d.slot.profile.difficulty = 'insane'; },
      (d) => { d.slot.profile.ngPlusCycle = -1; },
      (d) => { d.slot.profile.version = 2; },
      (d) => { d.slot.profile.version = 0; },
      (d) => { d.slot.profile.owned = ['vitality', 'bogus-mod']; },
      (d) => { d.slot.profile.owned = ['vitality']; d.slot.profile.loadout = ['power']; }, // unowned
      (d) => { d.slot.profile.owned = ['vitality', 'vitality']; }, // duplicate
      (d) => { d.slot.profile.achievements = 'first-blood'; },
      (d) => { d.slot.profile.bestiaryKills = { ember: -1 }; },
      (d) => { d.slot.profile.tutorialSeen = 'yes'; },
      (d) => { d.slot.profile.journal = [{ startUtc: 'x', genre: 's' }]; },
      (d) => { d.slot.profile.dailyResults = { '26/10/2026': {} }; },
      (d) => { d.slot.profile.dailyResults = { '2026-10-26': { score: -1 } }; },
      (d) => { d.slot.profile.gauntletResults = { '2026-10-26': { score: 1, roundsCleared: 1, kills: 1, timeSeconds: 1, damageTaken: 0, won: 'yes', genre: 's', seed: 1 } }; },
      (d) => { d.slot.profile.accessibility = { keybinds: {}, colorblind: 'xray', reducedMotion: false, hudTextScale: 1 }; },
      (d) => { d.slot.profile.accessibility.hudTextScale = 9; },
      (d) => { d.slot.profile.companions = { activeId: 3, roster: [] }; },
      (d) => { d.slot.profile.cosmetics = { visor: 1, outfit: null, scarf: false, hood: false, trim: null }; },
      (d) => { d.slot.profile.campChest = { iron: -2 }; },
      (d) => { d.slot.profile.mounts = { active: null, stamina: { a: 'full' } }; },
    ];
    for (const fn of cases) {
      const r = parseSaveExport(mutateBackup(good(), fn));
      expect(r.ok).toBe(false);
    }
  });

  it('rejects out-of-range and wrong-typed settings values', () => {
    const cases: Array<(d: any) => void> = [
      (d) => { d.slot.settings.volume = 1.5; },
      (d) => { d.slot.settings.volume = -0.1; },
      (d) => { d.slot.settings.volume = 'loud'; },
      (d) => { d.slot.settings.musicVolume = 2; },
      (d) => { d.slot.settings.muted = 1; },
      (d) => { d.slot.settings.quality = 'ultra'; },
      (d) => { d.slot.settings.tier = 'pc'; },
      (d) => { d.slot.settings.floatingText = 'yes'; },
    ];
    for (const fn of cases) {
      expect(parseSaveExport(mutateBackup(good(), fn)).ok).toBe(false);
    }
  });

  it('rejects non-boolean ironman/dead flags and oversize input', () => {
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.slot.ironman = 'yes'; })).ok).toBe(false);
    expect(parseSaveExport(mutateBackup(good(), (d) => { d.slot.dead = 1; })).ok).toBe(false);
    expect(parseSaveExport(' '.repeat(1_000_001)).ok).toBe(false);
  });
});

describe('import: new-slot landing', () => {
  it('lands as a new slot, never overwrites, and becomes active', () => {
    loadSlots(); // materialize the fresh store before snapshotting it
    const text = serializeSlot(richSlot());
    const before = rawStore();
    const beforeSlots = JSON.parse(before).slots;
    const res = importSaveExport(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const st = loadSlots();
    expect(st.slots).toHaveLength(beforeSlots.length + 1);
    expect(st.activeSlotId).toBe(res.slot.id);
    // pre-existing slots untouched (same ids, names, profiles)
    for (let i = 0; i < beforeSlots.length; i++) {
      expect(st.slots[i]).toEqual(beforeSlots[i]);
    }
    expect(res.slot.profile.merit).toBe(77);
    expect(res.slot.settings.volume).toBe(0.5);
    expect(res.slot.ironman).toBe(true);
  });

  it('auto-suffixes name collisions, including long names', () => {
    const text = serializeSlot(richSlot()); // name "Slot 1", already taken
    const first = importSaveExport(text);
    expect(first.ok && first.slot.name).toBe('Slot 1 (2)');
    const second = importSaveExport(text);
    expect(second.ok && second.slot.name).toBe('Slot 1 (3)');
    expect(uniqueSlotName('Slot 1', ['Slot 1', 'Slot 1 (2)', 'Slot 1 (3)'])).toBe('Slot 1 (4)');
    const long = 'x'.repeat(24);
    expect(uniqueSlotName(long, [long])).toBe(`${'x'.repeat(20)} (2)`);
    expect(uniqueSlotName(long, [long]).length).toBe(24);
  });

  it('preserves dead + ironman flags from the backup', () => {
    const slot = richSlot();
    slot.dead = true;
    const res = importSaveExport(serializeSlot(slot));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.slot.dead).toBe(true);
      expect(res.slot.ironman).toBe(true);
    }
  });

  it('refuses at the slot cap and leaves the store untouched', () => {
    while (listSlots().length < 8) createSlot();
    expect(listSlots()).toHaveLength(8);
    // Build the backup (richSlot persists its fixture values) BEFORE
    // snapshotting, so the snapshot measures only the import attempt.
    const text = serializeSlot(richSlot());
    const before = rawStore();
    const res = importSaveExport(text);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('full');
    expect(rawStore()).toBe(before);
  });

  it('a rejected import leaves the store byte-identical', () => {
    loadSlots(); // force the fresh store write
    // Build backup texts first (richSlot persists its fixture values),
    // then snapshot — the snapshot must measure only the import attempts.
    const goodText = serializeSlot(richSlot());
    const before = rawStore();
    const bad = ['not json', '{"format":"xandria-save-slot"}', goodText.slice(0, 40)];
    for (const text of bad) {
      expect(importSaveExport(text).ok).toBe(false);
      expect(rawStore()).toBe(before);
    }
    // and a wrong-version file that passes JSON but fails validation
    const wrong = mutateBackup(goodText, (d) => { d.schemaVersion = 2; });
    expect(importSaveExport(wrong).ok).toBe(false);
    expect(rawStore()).toBe(before);
  });

  it('imported slot ids are deterministic and never reused', () => {
    const text = serializeSlot(richSlot());
    const a = importSaveExport(text);
    const b = importSaveExport(text);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.slot.id).toBe('slot-4');
      expect(b.slot.id).toBe('slot-5');
      expect(a.slot.id).not.toBe(b.slot.id);
    }
  });
});
