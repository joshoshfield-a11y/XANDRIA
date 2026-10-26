/**
 * UPGRADE LOOP (save-slots): multiple named save slots — slot manager,
 * migration, isolation, per-slot settings.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _setProfileStorage,
  createSlot,
  DEFAULT_SLOT_COUNT,
  deleteSlot,
  getActiveSlot,
  getActiveSlotId,
  listSlots,
  loadProfile,
  loadSlots,
  loadSlotSettings,
  MAX_SLOTS,
  renameSlot,
  recordRun,
  saveProfile,
  saveSlots,
  saveSlotSettings,
  setActiveSlotId,
  slotSummaries,
  SLOTS_KEY,
  PROFILE_KEY,
  defaultProfile,
  type SlotStore,
} from '../src/engine/game/Profile';

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

function rawStore(): SlotStore {
  return JSON.parse(mem._map.get(SLOTS_KEY)!);
}

describe('fresh store', () => {
  it('ships DEFAULT_SLOT_COUNT named slots with the first active', () => {
    const st = loadSlots();
    expect(st.slots).toHaveLength(DEFAULT_SLOT_COUNT);
    expect(st.slots.map((s) => s.name)).toEqual(['Slot 1', 'Slot 2', 'Slot 3']);
    expect(st.activeSlotId).toBe('slot-1');
    expect(getActiveSlotId()).toBe('slot-1');
    // ids are deterministic
    expect(st.slots.map((s) => s.id)).toEqual(['slot-1', 'slot-2', 'slot-3']);
    // writes through to storage
    expect(mem._map.has(SLOTS_KEY)).toBe(true);
  });
});

describe('legacy migration', () => {
  it('migrates an existing single profile into Slot 1 with no data loss', () => {
    mem._map.set(PROFILE_KEY, JSON.stringify({
      version: 1, merit: 77, owned: ['vitality'], loadout: ['vitality'],
      totalKills: 123, totalPlaytime: 3600,
      dailyResults: { '2026-10-22': { score: 10, kills: 5, timeSeconds: 60, damageTaken: 0, won: true, goalKind: 'kills', goalTarget: 5, genre: 'survivor', seed: 1 } },
      achievements: ['first-blood'],
      difficulty: 'hard',
      bestiaryKills: { ember: 9 },
    }));
    mem._map.set('xandria.settings.v1', JSON.stringify({ volume: 0.5, muted: true, quality: 'retro', tier: 's25' }));
    const st = loadSlots();
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0].name).toBe('Slot 1');
    expect(st.activeSlotId).toBe('slot-1');
    const p = st.slots[0].profile;
    expect(p.merit).toBe(77);
    expect(p.owned).toEqual(['vitality']);
    expect(p.totalKills).toBe(123);
    expect(p.dailyResults['2026-10-22'].score).toBe(10);
    expect(p.difficulty).toBe('hard');
    expect(p.bestiaryKills).toEqual({ ember: 9 });
    // settings migrated too
    expect(st.slots[0].settings).toMatchObject({ volume: 0.5, muted: true, quality: 'retro', tier: 's25' });
    // legacy keys left in place (inert); the slots key takes precedence
    expect(mem._map.has(PROFILE_KEY)).toBe(true);
    // second load does not re-migrate (no duplicate Slot 1)
    expect(loadSlots().slots).toHaveLength(1);
  });

  it('legacy profile alone (no legacy settings) still migrates cleanly', () => {
    mem._map.set(PROFILE_KEY, JSON.stringify({ merit: 5 }));
    const st = loadSlots();
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0].profile.merit).toBe(5);
    expect(st.slots[0].settings.volume).toBe(0.8);
  });

  it('corrupt legacy profile yields a fresh Slot 1, never a throw', () => {
    mem._map.set(PROFILE_KEY, 'not-json{{{');
    const st = loadSlots();
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0].profile.merit).toBe(0);
  });
});

describe('active-slot compatibility (loadProfile/saveProfile)', () => {
  it('loadProfile reads and saveProfile writes the active slot', () => {
    const p = loadProfile();
    p.merit = 42;
    saveProfile(p);
    expect(rawStore().slots[0].profile.merit).toBe(42);
    // switching slots swaps the visible profile
    setActiveSlotId('slot-2');
    expect(loadProfile().merit).toBe(0);
    const p2 = loadProfile();
    p2.merit = 7;
    saveProfile(p2);
    setActiveSlotId('slot-1');
    expect(loadProfile().merit).toBe(42);
  });
});

describe('isolation', () => {
  it('progress in one slot never leaks into another', () => {
    const a = loadProfile();
    recordRun(a, { genre: 'survivor', won: true, score: 1000, level: 5, kills: 50, timeSeconds: 300, daily: '2026-10-22' });
    a.achievements.push('first-blood');
    a.bestiaryKills['ember'] = 3;
    saveProfile(a);

    setActiveSlotId('slot-2');
    const b = loadProfile();
    expect(b.merit).toBe(0);
    expect(b.runsPlayed).toEqual({});
    expect(b.dailyBest).toEqual({});
    expect(b.achievements).toEqual([]);
    expect(b.bestiaryKills).toEqual({});

    // and back — slot 1 kept everything
    setActiveSlotId('slot-1');
    const a2 = loadProfile();
    expect(a2.merit).toBe(meritOf(true, 5));
    expect(a2.runsPlayed['survivor']).toBe(1);
    expect(a2.dailyBest['2026-10-22']).toBe(1000);
    expect(a2.achievements).toEqual(['first-blood']);
    expect(a2.bestiaryKills).toEqual({ ember: 3 });
  });

  it('slotSummaries reports per-slot stats for the picker UI', () => {
    const a = loadProfile();
    recordRun(a, { genre: 'survivor', won: false, score: 100, level: 2, kills: 9, timeSeconds: 125 });
    saveProfile(a);
    const sums = slotSummaries();
    expect(sums).toHaveLength(3);
    expect(sums[0]).toMatchObject({ id: 'slot-1', name: 'Slot 1', active: true, runs: 1, playtimeMin: 2 });
    expect(sums[0].merit).toBeGreaterThan(0);
    expect(sums[1]).toMatchObject({ active: false, runs: 0 });
  });
});

function meritOf(won: boolean, level: number): number {
  return (won ? 10 : 2) + Math.max(0, Math.floor(level));
}

describe('createSlot', () => {
  it('creates a fresh slot and makes it active', () => {
    const s = createSlot('Speedrun');
    expect(s).not.toBeNull();
    expect(s!.name).toBe('Speedrun');
    expect(s!.id).toBe('slot-4');
    expect(getActiveSlotId()).toBe('slot-4');
    expect(loadProfile().merit).toBe(0);
    expect(listSlots()).toHaveLength(4);
  });

  it('refuses past MAX_SLOTS', () => {
    for (let i = 0; i < MAX_SLOTS - DEFAULT_SLOT_COUNT; i++) createSlot();
    expect(listSlots()).toHaveLength(MAX_SLOTS);
    expect(createSlot()).toBeNull();
    expect(listSlots()).toHaveLength(MAX_SLOTS);
  });

  it('default name falls back to Slot N and ids stay deterministic', () => {
    const a = createSlot()!;
    const b = createSlot()!;
    expect(a.name).toBe('Slot 4');
    expect(b.name).toBe('Slot 5');
    expect(b.id).toBe('slot-5');
  });
});

describe('renameSlot', () => {
  it('renames, trims, and caps length', () => {
    expect(renameSlot('slot-2', '  My  Hero  Run  ')).toBe(true);
    expect(getActiveSlot(loadSlots()).name).toBe('Slot 1'); // active untouched
    expect(listSlots()[1].name).toBe('My Hero Run');
    expect(renameSlot('slot-2', 'x'.repeat(100))).toBe(true);
    expect(listSlots()[1].name).toHaveLength(24);
  });

  it('rejects blank names and unknown ids', () => {
    expect(renameSlot('slot-2', '   ')).toBe(false);
    expect(renameSlot('nope', 'Name')).toBe(false);
    expect(listSlots()[1].name).toBe('Slot 2');
  });
});

describe('deleteSlot', () => {
  it('never deletes the last slot', () => {
    const st = loadSlots();
    st.slots = [st.slots[0]];
    st.activeSlotId = st.slots[0].id;
    saveSlots(st);
    expect(deleteSlot(st.slots[0].id)).toBe(false);
    expect(listSlots()).toHaveLength(1);
  });

  it('deleting a non-active slot keeps the active one', () => {
    expect(deleteSlot('slot-3')).toBe(true);
    expect(listSlots()).toHaveLength(2);
    expect(getActiveSlotId()).toBe('slot-1');
  });

  it('deleting the active slot activates a neighbour', () => {
    setActiveSlotId('slot-2');
    expect(deleteSlot('slot-2')).toBe(true);
    const ids = listSlots().map((s) => s.id);
    expect(ids).not.toContain('slot-2');
    expect(getActiveSlotId()).toBe('slot-3');
    expect(ids).toContain(getActiveSlotId());
  });

  it('rejects unknown ids', () => {
    expect(deleteSlot('nope')).toBe(false);
  });
});

describe('per-slot settings', () => {
  it('each slot owns its settings; switching swaps them', () => {
    saveSlotSettings({ volume: 0.2, muted: true, quality: 'retro', tier: 's25', floatingText: false, musicEnabled: true, sfxEnabled: true, musicVolume: 0.8, sfxVolume: 0.8 });
    expect(loadSlotSettings()).toMatchObject({ volume: 0.2, muted: true, quality: 'retro', tier: 's25' });
    setActiveSlotId('slot-2');
    // slot 2 was never touched: clean defaults
    expect(loadSlotSettings()).toMatchObject({ volume: 0.8, muted: false, quality: 'auto', tier: 'auto' });
    setActiveSlotId('slot-1');
    expect(loadSlotSettings().volume).toBe(0.2);
  });
});

describe('robustness', () => {
  it('corrupt slots JSON yields fresh defaults, never throws', () => {
    mem._map.set(SLOTS_KEY, 'garbage{{{');
    expect(loadSlots().slots).toHaveLength(DEFAULT_SLOT_COUNT);
  });

  it('zero-slot stores are refused (data-loss guard)', () => {
    mem._map.set(SLOTS_KEY, JSON.stringify({ version: 1, activeSlotId: 'x', nextSeq: 1, slots: [] }));
    expect(loadSlots().slots).toHaveLength(DEFAULT_SLOT_COUNT);
  });

  it('stale activeSlotId falls back to the first slot', () => {
    const st = loadSlots();
    st.activeSlotId = 'slot-999';
    saveSlots(st);
    expect(getActiveSlotId()).toBe('slot-1');
  });

  it('setActiveSlotId rejects unknown ids', () => {
    expect(setActiveSlotId('nope')).toBe(false);
    expect(getActiveSlotId()).toBe('slot-1');
  });

  it('defaultProfile() is untouched by the slots layer', () => {
    expect(defaultProfile().merit).toBe(0);
  });
});
